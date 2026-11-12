import { create } from 'zustand';
import { CONFIG } from '../config';
import { getBody, BODIES } from '../optics/bodies';
import { getLens, lensesFor, LENSES } from '../optics/lenses';
import { clampFocal, clampFocusM, deriveOptics, widestAt, narrowestAt, DEFAULT_EV100 } from '../optics/optics';
import { focusMToSlider, sliderToFocusM, FOCUS_SLIDER_MAX } from '../optics/focusScale';
import { APERTURE_STOPS, nearestStopIndex } from '../optics/stops';
import type { DerivedOptics, ExposureMode, ManualLock } from '../optics/types';
import { DEFAULT_TIME_OF_DAY, TIMES_OF_DAY, type TimeOfDay } from '../scene/timeOfDay';

export type View = 'camera' | 'eye';
export type RenderMode = 'INTERACTIVE' | 'REFINING' | 'DONE';

export interface Settings {
  bodyId: string;
  /** The selected lens: the one the HUD describes and the wheel zooms, and the one mounted in camera view. */
  lensId: string;
  /** Each lens's zoom ring, by lens id. */
  focalMmByLens: Record<string, number>;
  /** Requested values, shared by every lens; each lens clamps them to its own limits. */
  requestedFNumber: number;
  focusM: number;                                   // Infinity allowed
  exposureMode: ExposureMode;
  manualLock: ManualLock | null;
  view: View;
  /** Side by side is on screen when this is set and the view is the eye view (§9.1). */
  sideBySide: boolean;
  /** The lenses with a finder, in loadout order; never empty, at most CONFIG.sideBySide.maxFinders. */
  sideBySideLensIds: string[];
  timeOfDay: TimeOfDay;
}

/** Refinement progress of one view. */
export interface RefineProgress { samples: number; target: number }

export interface Runtime {
  centreDistanceM: number | null;                   // null = sky
  /** Whole screen: the camera view's, or the sum over the finders side by side. */
  refine: RefineProgress;
  /** Side by side: each finder's, by lens id. */
  finderRefine: Record<string, RefineProgress>;
  loading: { loadedBytes: number; totalBytes: number } | null;
  /** EV100 of the lighting on screen (§8.5); follows the time of day once its sky has loaded. */
  ev100: number;
  /** A time of day whose sky is still downloading. */
  timeOfDayLoading: { timeOfDay: TimeOfDay; loadedBytes: number; totalBytes: number } | null;
  /** Size of the viewport (the whole window), CSS px. */
  viewport: { width: number; height: number };
  /** Size of the render buffer in device px. */
  renderPx: { width: number; height: number };
  pointerLocked: boolean;
  error: string | null;
}

export interface DebugInfo {
  /** Frames the GPU finished per second, and the average cost of frames drawn (null when none were). */
  fps: number;
  cpuMs: number | null;
  /** Also null when the browser has no GPU timer queries. */
  gpuMs: number | null;
  /** Whole screen: INTERACTIVE while any view is, REFINING while any refines, DONE when all are. */
  mode: RenderMode;
  samplesPerFrame: number;
  passes: { gather: boolean; refine: boolean; vignette: boolean; residual: boolean };
}

/**
 * The lens wheel, open while Space is held (§9.2): the lens under the aim (null in the dead zone), and whether
 * a click has toggled a finder since it opened, after which releasing Space only closes it.
 */
export interface Wheel { lensId: string | null; clicked: boolean }

interface Store {
  settings: Settings;
  runtime: Runtime;
  debug: DebugInfo;
  helpOpen: boolean;
  hudVisible: boolean;
  /** The full readout, shown while Tab is held. */
  detailsOpen: boolean;
  wheel: Wheel | null;

  setBody(id: string): void;
  /** Selects a lens. Side by side, it also gets a finder (at the cap, in place of the previous selection). */
  setLens(id: string): void;
  nextLens(): void;
  setFocal(mm: number): void;
  stepFocal(deltaMm: number): void;
  setRequestedFNumber(n: number): void;
  stepAperture(thirds: number): void;
  setFocusM(m: number): void;
  stepFocus(positions: number): void;
  setExposureMode(mode: ExposureMode): void;
  toggleExposureMode(): void;
  setView(view: View): void;
  toggleView(): void;
  toggleSideBySide(): void;
  /** Adds or removes a lens's finder, turning side by side on first if it isn't on screen. */
  toggleFinder(id: string): void;
  setTimeOfDay(t: TimeOfDay): void;
  nextTimeOfDay(): void;
  setHelpOpen(open: boolean): void;
  setHudVisible(visible: boolean): void;
  setDetailsOpen(open: boolean): void;
  openWheel(): void;
  setWheelLens(id: string | null): void;
  /** A left click on the wheel: adds or removes the finder of the lens under the aim. */
  clickWheel(): void;
  /** `commit` selects the lens under the aim, unless a click was made; otherwise the wheel just closes. */
  closeWheel(commit: boolean): void;
  setRuntime(patch: Partial<Runtime>): void;
  setDebug(patch: Partial<DebugInfo>): void;
  togglePass(pass: keyof DebugInfo['passes']): void;
}

/** Optics of a lens (the selected one by default) with the shared settings and its own zoom ring. */
export function opticsFor(s: Settings, ev100: number, lensId = s.lensId): DerivedOptics {
  const lens = getLens(lensId);
  return deriveOptics(getBody(s.bodyId), lens, { ...s, focalMm: focalOf(s, lensId) }, ev100);
}

export function focalOf(s: Settings, lensId: string): number {
  const lens = getLens(lensId);
  return clampFocal(lens, s.focalMmByLens[lens.id] ?? lens.focalMm.min);
}

export function sideBySideOnScreen(s: Settings): boolean {
  return s.view === 'eye' && s.sideBySide;
}

const MAX_FINDERS = CONFIG.sideBySide.maxFinders;

const loadoutIds = (s: Settings) => lensesFor(getBody(s.bodyId)).map((l) => l.id);

/** `ids` plus `id`, in loadout order. At the cap, `id` takes the place of `evict`. */
function addShown(s: Settings, ids: string[], id: string, evict: string | undefined): string[] {
  if (ids.includes(id)) return ids;
  const kept = ids.length < MAX_FINDERS ? ids : ids.filter((x) => x !== evict);
  return loadoutIds(s).filter((x) => x === id || kept.includes(x));
}

/**
 * Keeps the shown lenses valid (mountable, in loadout order, 1 to the cap), and the selected lens among
 * them while side by side is on screen, replacing the last one at the cap. Returns `s` if nothing changed.
 */
function normalize(s: Settings): Settings {
  const loadout = loadoutIds(s);
  let ids = loadout.filter((id) => s.sideBySideLensIds.includes(id)).slice(0, MAX_FINDERS);
  if (ids.length === 0) ids = loadout.slice(0, MAX_FINDERS);
  if (sideBySideOnScreen(s)) ids = addShown(s, ids, s.lensId, ids[ids.length - 1]);
  const same = ids.length === s.sideBySideLensIds.length && ids.every((id, i) => id === s.sideBySideLensIds[i]);
  return same ? s : { ...s, sideBySideLensIds: ids };
}

const DEFAULT_LENS = getLens('ef-50-1.8-stm');

const DEFAULT_SETTINGS: Settings = normalize({
  bodyId: BODIES[0].id,
  lensId: DEFAULT_LENS.id,
  focalMmByLens: Object.fromEntries(LENSES.map((l) => [l.id, l.focalMm.min])),
  requestedFNumber: 1.8,
  focusM: 1.0,
  exposureMode: 'Av',
  manualLock: null,
  view: 'camera',
  sideBySide: false,
  sideBySideLensIds: [],
  timeOfDay: DEFAULT_TIME_OF_DAY,
});

export const useStore = create<Store>()((set, get) => {
  const update = (fn: (s: Settings) => Settings) => set((st) => ({ settings: normalize(fn(st.settings)) }));

  return {
    settings: DEFAULT_SETTINGS,
    runtime: {
      centreDistanceM: null,
      refine: { samples: 0, target: CONFIG.refineTarget },
      finderRefine: {},
      loading: null,
      ev100: DEFAULT_EV100,
      timeOfDayLoading: null,
      viewport: { width: 0, height: 0 },
      renderPx: { width: 0, height: 0 },
      pointerLocked: false,
      error: null,
    },
    debug: {
      fps: 0,
      cpuMs: null,
      gpuMs: null,
      mode: 'INTERACTIVE',
      samplesPerFrame: 0,
      passes: { gather: true, refine: true, vignette: true, residual: true },
    },
    helpOpen: true,
    hudVisible: true,
    detailsOpen: false,
    wheel: null,

    setBody: (id) =>
      update((s) => {
        const lenses = lensesFor(getBody(id));
        const lensId = lenses.some((l) => l.id === s.lensId) ? s.lensId : lenses[0].id;
        return { ...s, bodyId: id, lensId };
      }),
    // Lens switch (§9.4): each lens keeps its zoom ring, and focus and aperture stay as requested.
    setLens: (id) =>
      update((s) => {
        const lensId = getLens(id).id;
        if (!sideBySideOnScreen(s)) return { ...s, lensId };
        return { ...s, lensId, sideBySideLensIds: addShown(s, s.sideBySideLensIds, lensId, s.lensId) };
      }),
    // Side by side, L cycles through the lenses on screen.
    nextLens: () =>
      update((s) => {
        const ids = sideBySideOnScreen(s) ? s.sideBySideLensIds : loadoutIds(s);
        return { ...s, lensId: ids[(ids.indexOf(s.lensId) + 1) % ids.length] };
      }),
    setFocal: (mm) =>
      update((s) => ({
        ...s,
        focalMmByLens: { ...s.focalMmByLens, [s.lensId]: clampFocal(getLens(s.lensId), Math.round(mm)) },
      })),
    stepFocal: (d) => {
      const s = get().settings;
      get().setFocal(focalOf(s, s.lensId) + d);
    },
    setRequestedFNumber: (n) => update((s) => ({ ...s, requestedFNumber: n })),
    stepAperture: (thirds) =>
      update((s) => {
        const lens = getLens(s.lensId);
        const o = opticsFor(s, get().runtime.ev100);
        const i = nearestStopIndex(o.fNumber) + thirds;
        const n = APERTURE_STOPS[i];
        // At a limit, do nothing, so the requested value survives (e.g. f/4 at 55 mm).
        if (n === undefined || n < widestAt(lens, o.focalMm) || n > narrowestAt(lens, o.focalMm)) return s;
        return { ...s, requestedFNumber: n };
      }),
    setFocusM: (m) => update((s) => ({ ...s, focusM: clampFocusM(getLens(s.lensId), m) })),
    // On the selected lens's scale, from where it actually focuses. At its closest focus, nearer does nothing,
    // so a closer request made with another lens survives.
    stepFocus: (positions) =>
      update((s) => {
        const closest = getLens(s.lensId).closestFocusM;
        const from = focusMToSlider(clampFocusM(getLens(s.lensId), s.focusM), closest);
        const p = Math.min(Math.max(from + positions, 0), FOCUS_SLIDER_MAX);
        return p === from ? s : { ...s, focusM: sliderToFocusM(p, closest) };
      }),
    setExposureMode: (mode) =>
      update((s) => {
        if (mode === s.exposureMode) return s;
        if (mode === 'Av') return { ...s, exposureMode: 'Av', manualLock: null };
        const o = opticsFor(s, get().runtime.ev100);
        return { ...s, exposureMode: 'M', manualLock: { fNumber: o.fNumber, shutterS: o.shutterS } };
      }),
    toggleExposureMode: () => get().setExposureMode(get().settings.exposureMode === 'Av' ? 'M' : 'Av'),
    setView: (view) => update((s) => ({ ...s, view })),
    toggleView: () => get().setView(get().settings.view === 'camera' ? 'eye' : 'camera'),
    // Always visible: from camera view it turns side by side on and goes to the eye view.
    toggleSideBySide: () =>
      update((s) => (sideBySideOnScreen(s) ? { ...s, sideBySide: false } : { ...s, view: 'eye', sideBySide: true })),
    toggleFinder: (id) =>
      update((s) => {
        const ids = s.sideBySideLensIds;
        if (!sideBySideOnScreen(s)) {
          // As C, with this lens shown too; the selected one stays.
          const withSelected = addShown(s, ids, s.lensId, ids[ids.length - 1]);
          const shown = addShown(s, withSelected, id, withSelected.findLast((x) => x !== s.lensId));
          return { ...s, view: 'eye', sideBySide: true, sideBySideLensIds: shown };
        }
        if (ids.includes(id)) {
          if (ids.length === 1) return s;
          const shown = ids.filter((x) => x !== id);
          return { ...s, sideBySideLensIds: shown, lensId: shown.includes(s.lensId) ? s.lensId : shown[0] };
        }
        if (ids.length >= MAX_FINDERS) return s;
        return { ...s, sideBySideLensIds: addShown(s, ids, id, undefined) };
      }),
    setTimeOfDay: (timeOfDay) => update((s) => ({ ...s, timeOfDay })),
    nextTimeOfDay: () => {
      const i = TIMES_OF_DAY.findIndex((t) => t.id === get().settings.timeOfDay);
      get().setTimeOfDay(TIMES_OF_DAY[(i + 1) % TIMES_OF_DAY.length].id);
    },
    setHelpOpen: (helpOpen) => set((st) => ({ helpOpen, wheel: helpOpen ? null : st.wheel })),
    setHudVisible: (hudVisible) => set({ hudVisible }),
    setDetailsOpen: (detailsOpen) => set({ detailsOpen }),
    openWheel: () => set({ wheel: { lensId: null, clicked: false } }),
    setWheelLens: (lensId) => {
      const wheel = get().wheel;
      if (wheel && wheel.lensId !== lensId) set({ wheel: { ...wheel, lensId } });
    },
    clickWheel: () => {
      const wheel = get().wheel;
      if (!wheel?.lensId) return;
      get().toggleFinder(wheel.lensId);
      set({ wheel: { ...wheel, clicked: true } });
    },
    closeWheel: (commit) => {
      const wheel = get().wheel;
      if (!wheel) return;
      set({ wheel: null });
      // After a click, selecting the lens under the aim would bring a finder just removed straight back.
      if (commit && wheel.lensId && !wheel.clicked) get().setLens(wheel.lensId);
    },
    setRuntime: (patch) => set((st) => ({ runtime: { ...st.runtime, ...patch } })),
    setDebug: (patch) => set((st) => ({ debug: { ...st.debug, ...patch } })),
    togglePass: (pass) =>
      set((st) => ({ debug: { ...st.debug, passes: { ...st.debug.passes, [pass]: !st.debug.passes[pass] } } })),
  };
});

/** Derived optics of the selected lens, for React components. */
export function useOptics(): DerivedOptics {
  const settings = useStore((s) => s.settings);
  const ev100 = useStore((s) => s.runtime.ev100);
  return opticsFor(settings, ev100);
}
