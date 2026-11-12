import { create } from 'zustand';
import { getBody, BODIES } from '../optics/bodies';
import { getLens, lensesFor } from '../optics/lenses';
import { clampFocal, clampFocusM, deriveOptics, widestAt, narrowestAt, DEFAULT_EV100 } from '../optics/optics';
import { focusMToSlider, sliderToFocusM, FOCUS_SLIDER_MAX } from '../optics/focusScale';
import { APERTURE_STOPS, nearestStopIndex } from '../optics/stops';
import type { DerivedOptics, ExposureMode, ManualLock } from '../optics/types';
import { DEFAULT_TIME_OF_DAY, TIMES_OF_DAY, type TimeOfDay } from '../scene/timeOfDay';

export type View = 'camera' | 'eye';
export type RenderMode = 'INTERACTIVE' | 'REFINING' | 'DONE';

export interface Settings {
  bodyId: string;
  lensId: string;
  focalMm: number;
  requestedFNumber: number;
  focusM: number;                                   // Infinity allowed
  exposureMode: ExposureMode;
  manualLock: ManualLock | null;
  view: View;
  timeOfDay: TimeOfDay;
}

export interface Runtime {
  centreDistanceM: number | null;                   // null = sky
  refine: { samples: number; target: number };
  /** `stage` is 'shaders' once everything has downloaded and shaders are compiling. */
  loading: { loadedBytes: number; totalBytes: number; stage?: 'shaders' } | null;
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
  mode: RenderMode;
  /** Samples per refinement batch while refining, else 0. */
  samplesPerFrame: number;
  /** Interactive render scale from dynamic resolution, 1 = full. */
  previewScale: number;
  passes: { gather: boolean; refine: boolean; vignette: boolean; residual: boolean };
}

/** `?bench=1`: progress while it runs, then the report. */
export interface BenchState {
  status: string;
  report: string | null;
}

interface Store {
  settings: Settings;
  bench: BenchState | null;
  runtime: Runtime;
  debug: DebugInfo;
  helpOpen: boolean;
  hudVisible: boolean;
  /** The full readout, shown while Tab is held. */
  detailsOpen: boolean;

  setBody(id: string): void;
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
  setTimeOfDay(t: TimeOfDay): void;
  nextTimeOfDay(): void;
  setHelpOpen(open: boolean): void;
  setHudVisible(visible: boolean): void;
  setDetailsOpen(open: boolean): void;
  setRuntime(patch: Partial<Runtime>): void;
  setDebug(patch: Partial<DebugInfo>): void;
  setBench(bench: BenchState | null): void;
  togglePass(pass: keyof DebugInfo['passes']): void;
}

export function opticsFor(s: Settings, ev100: number): DerivedOptics {
  return deriveOptics(getBody(s.bodyId), getLens(s.lensId), s, ev100);
}

const DEFAULT_LENS = getLens('ef-50-1.8-stm');

const DEFAULT_SETTINGS: Settings = {
  bodyId: BODIES[0].id,
  lensId: DEFAULT_LENS.id,
  focalMm: DEFAULT_LENS.focalMm.min,
  requestedFNumber: 1.8,
  focusM: 1.0,
  exposureMode: 'Av',
  manualLock: null,
  view: 'camera',
  timeOfDay: DEFAULT_TIME_OF_DAY,
};

/** Lens switch rules (§9.4): clamp focal length and focus, keep requested N and the manual lock. */
function withLens(s: Settings, lensId: string): Settings {
  const lens = getLens(lensId);
  return {
    ...s,
    lensId: lens.id,
    focalMm: clampFocal(lens, s.focalMm),
    focusM: clampFocusM(lens, s.focusM),
  };
}

export const useStore = create<Store>()((set, get) => {
  const update = (fn: (s: Settings) => Settings) => set((st) => ({ settings: fn(st.settings) }));

  return {
    settings: DEFAULT_SETTINGS,
    runtime: {
      centreDistanceM: null,
      refine: { samples: 0, target: 256 },
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
      previewScale: 1,
      passes: { gather: true, refine: true, vignette: true, residual: true },
    },
    bench: null,
    helpOpen: true,
    hudVisible: true,
    detailsOpen: false,

    setBody: (id) =>
      update((s) => {
        const body = getBody(id);
        const lenses = lensesFor(body);
        const lensId = lenses.some((l) => l.id === s.lensId) ? s.lensId : lenses[0].id;
        return withLens({ ...s, bodyId: body.id }, lensId);
      }),
    setLens: (id) => update((s) => withLens(s, id)),
    nextLens: () =>
      update((s) => {
        const lenses = lensesFor(getBody(s.bodyId));
        const i = lenses.findIndex((l) => l.id === s.lensId);
        return withLens(s, lenses[(i + 1) % lenses.length].id);
      }),
    setFocal: (mm) => update((s) => ({ ...s, focalMm: clampFocal(getLens(s.lensId), Math.round(mm)) })),
    stepFocal: (d) => get().setFocal(get().settings.focalMm + d),
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
    stepFocus: (positions) =>
      update((s) => {
        const closest = getLens(s.lensId).closestFocusM;
        const p = focusMToSlider(s.focusM, closest) + positions;
        return { ...s, focusM: sliderToFocusM(Math.min(Math.max(p, 0), FOCUS_SLIDER_MAX), closest) };
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
    setTimeOfDay: (timeOfDay) => update((s) => ({ ...s, timeOfDay })),
    nextTimeOfDay: () => {
      const i = TIMES_OF_DAY.findIndex((t) => t.id === get().settings.timeOfDay);
      get().setTimeOfDay(TIMES_OF_DAY[(i + 1) % TIMES_OF_DAY.length].id);
    },
    setHelpOpen: (helpOpen) => set({ helpOpen }),
    setHudVisible: (hudVisible) => set({ hudVisible }),
    setDetailsOpen: (detailsOpen) => set({ detailsOpen }),
    setRuntime: (patch) => set((st) => ({ runtime: { ...st.runtime, ...patch } })),
    setDebug: (patch) => set((st) => ({ debug: { ...st.debug, ...patch } })),
    setBench: (bench) => set({ bench }),
    togglePass: (pass) =>
      set((st) => ({ debug: { ...st.debug, passes: { ...st.debug.passes, [pass]: !st.debug.passes[pass] } } })),
  };
});

/** Derived optics for React components. */
export function useOptics(): DerivedOptics {
  const settings = useStore((s) => s.settings);
  const ev100 = useStore((s) => s.runtime.ev100);
  return opticsFor(settings, ev100);
}
