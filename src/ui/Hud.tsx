import type { CSSProperties, ReactNode } from 'react';
import type { IconType } from 'react-icons';
import {
  TbAperture, TbCamera, TbChartDonut, TbColumns2, TbEye, TbEyeOff, TbFocus2, TbHelp, TbListDetails, TbMoonStars,
  TbStopwatch, TbSun, TbSunLow, TbSunset2,
} from 'react-icons/tb';
import { PiMouseScrollBold } from 'react-icons/pi';
import { getBody } from '../optics/bodies';
import { FOCUS_SLIDER_MAX, focusMToSlider, formatDistanceM } from '../optics/focusScale';
import { isZoom, lensesFor } from '../optics/lenses';
import { formatFNumber, shutterLabel, stopsWithin } from '../optics/stops';
import type { DerivedOptics } from '../optics/types';
import { finderRects, finderRowBottom, hudScale } from '../render/layout';
import { TIMES_OF_DAY, type TimeOfDay } from '../scene/timeOfDay';
import { sideBySideOnScreen, useOptics, useStore } from '../state/store';
import { DebugOverlay, FpsCounter } from './DebugOverlay';
import {
  avOutOfRange, centreText, dofDepthText, dofText, exposureNote, fNumberHint, fovText, lensFocalLabel,
} from './format';

const TIME_ICONS: Record<TimeOfDay, IconType> = { noon: TbSun, golden: TbSunLow, evening: TbSunset2, night: TbMoonStars };

/** Segments on the focus and zoom bars. */
const FOCUS_SEGMENTS = 24;
const ZOOM_SEGMENTS = 14;
/** The exposure meter spans ±3 EV in thirds, like the camera's level indicator. */
const METER_THIRDS = 9;

type SegmentState = 'lit' | 'mark' | 'warn' | null;

/** A bar of segments, like a health bar. */
function Segments({ count, state, className, children }: {
  count: number;
  state: (i: number) => SegmentState;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={className ? `hud-segments ${className}` : 'hud-segments'}>
      {Array.from({ length: count }, (_, i) => <span key={i} className={state(i) ?? undefined} />)}
      {children}
    </div>
  );
}

/** Lit up to `index`, which is marked. */
const level = (index: number) => (i: number): SegmentState => (i === index ? 'mark' : i < index ? 'lit' : null);

/** Replays the highlight whenever `value` changes, so a key press shows what it did. */
function Flash({ value, className }: { value: string; className?: string }) {
  return <span key={value} className={className ? `flash ${className}` : 'flash'}>{value}</span>;
}

/** One setting in the bottom-left stack: icon, keys, value, and a bar showing where it sits in its range. */
function Row({ icon: Icon, keys, children, note, warn, bar }: {
  icon: IconType;
  keys: string[];
  children: ReactNode;
  note?: string | null;
  warn?: boolean;
  bar: ReactNode;
}) {
  return (
    <div className="hud-row">
      <div className="hud-icon"><Icon /></div>
      <div className="hud-row-body">
        <div className="hud-row-head">
          <span className="hud-keys">{keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
          {children}
          {note && <span className={warn ? 'hud-row-note warn' : 'hud-row-note'}>{note}</span>}
        </div>
        {bar}
      </div>
    </div>
  );
}

function ApertureRow({ o }: { o: DerivedOptics }) {
  const stops = stopsWithin(o.widestFNumber, o.narrowestFNumber);
  return (
    <Row
      icon={TbAperture}
      keys={['[', ']']}
      note={fNumberHint(o)}
      warn
      bar={<Segments count={stops.length} state={level(stops.indexOf(o.fNumber))} />}
    >
      <Flash className="hud-row-value" value={formatFNumber(o.fNumber)} />
    </Row>
  );
}

/** The bar is the focus scale: the depth of field is lit, and a tick marks what's under the AF point. */
function FocusRow({ o }: { o: DerivedOptics }) {
  const centre = useStore((s) => s.runtime.centreDistanceM);
  const closest = o.lens.closestFocusM;
  const segment = (m: number) =>
    Math.min(FOCUS_SEGMENTS - 1, Math.floor((focusMToSlider(m, closest) / FOCUS_SLIDER_MAX) * FOCUS_SEGMENTS));
  const focus = segment(o.focusM);
  const near = segment(o.dofNearM);
  const far = segment(o.dofFarM);
  const subject = focusMToSlider(centre ?? Infinity, closest) / FOCUS_SLIDER_MAX;
  return (
    <Row
      icon={TbFocus2}
      keys={['−', '=']}
      note={dofText(o)}
      bar={(
        <Segments count={FOCUS_SEGMENTS} state={(i) => (i === focus ? 'mark' : i >= near && i <= far ? 'lit' : null)}>
          <i className="hud-subject" style={{ left: `${subject * 100}%` }} />
        </Segments>
      )}
    >
      <Flash className="hud-row-value" value={formatDistanceM(o.focusM)} />
    </Row>
  );
}

/** The bar is the exposure level: correct in the middle, lit out to the offset. */
function ExposureRow({ o }: { o: DerivedOptics }) {
  const outOfRange = avOutOfRange(o);
  const off = Math.max(-METER_THIRDS, Math.min(METER_THIRDS, Math.round(o.evOffset * 3)));
  const meter = (i: number): SegmentState => {
    const d = i - METER_THIRDS;
    if (d === off) return outOfRange ? 'warn' : 'mark';
    return d !== 0 && Math.sign(d) === Math.sign(off) && Math.abs(d) < Math.abs(off) ? 'lit' : null;
  };
  return (
    <Row
      icon={TbStopwatch}
      keys={['X']}
      note={exposureNote(o)}
      warn={outOfRange}
      bar={<Segments className="meter" count={2 * METER_THIRDS + 1} state={meter} />}
    >
      <Flash className="hud-row-mode" value={o.exposureMode} />
      {/* Blinks like the camera's display when Av runs out of shutter speeds. */}
      <Flash className={outOfRange ? 'hud-row-value warn blink' : 'hud-row-value'} value={shutterLabel(o.shutterS)} />
    </Row>
  );
}

/** Bottom left: the body, then aperture, focus and exposure. */
function ExposureStack() {
  const o = useOptics();
  const body = getBody(useStore((s) => s.settings.bodyId));
  return (
    <div className="hud-stack">
      <div className="hud-heading"><TbCamera />{body.name}</div>
      <ApertureRow o={o} />
      <FocusRow o={o} />
      <ExposureRow o={o} />
    </div>
  );
}

/**
 * Bottom right, like a weapon loadout: the lens, its focal length, and the lenses L cycles through. Side by
 * side, the slots of lenses with a finder are outlined. Space opens the lens wheel.
 */
function LensLoadout() {
  const o = useOptics();
  const settings = useStore((s) => s.settings);
  const body = getBody(settings.bodyId);
  const shown = sideBySideOnScreen(settings) ? settings.sideBySideLensIds : [];
  const lens = o.lens;
  const zoom = isZoom(lens);
  const zoomAt = Math.round(((o.focalMm - lens.focalMm.min) / (lens.focalMm.max - lens.focalMm.min)) * (ZOOM_SEGMENTS - 1));
  return (
    <div className="hud-lens">
      <Flash className="hud-lens-name" value={lens.name} />
      <div className="hud-lens-focal">
        {zoom && <PiMouseScrollBold className="hud-wheel" />}
        <Flash value={String(Math.round(o.focalMm))} />
        <small>mm</small>
      </div>
      <div className="hud-lens-sub">{Math.round(o.equivalentFocalMm)} mm equiv. · {fovText(o)}</div>
      {zoom && <Segments className="hud-zoom" count={ZOOM_SEGMENTS} state={level(zoomAt)} />}
      <div className="hud-slots">
        <kbd>Space</kbd>
        <TbChartDonut className="hud-wheel-icon" />
        <kbd>L</kbd>
        {lensesFor(body).map((l) => (
          <span key={l.id} className={l.id === lens.id ? 'on' : shown.includes(l.id) ? 'shown' : undefined}>
            {lensFocalLabel(l)}<small>mm</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function Chip({ keyLabel, icon: Icon, label, status, off }: {
  keyLabel: string;
  icon: IconType;
  label: string;
  status?: string | null;
  /** A toggle that's off: dimmed. */
  off?: boolean;
}) {
  return (
    <div className={off ? 'hud-chip off' : 'hud-chip'}>
      <kbd>{keyLabel}</kbd>
      <span className="hud-badge"><Icon /></span>
      <Flash key={off ? 'off' : 'on'} className="hud-chip-label" value={label} />
      {status && <span className="hud-chip-status">{status}</span>}
    </div>
  );
}

function loadingText({ loadedBytes, totalBytes }: { loadedBytes: number; totalBytes: number }): string {
  return totalBytes > 0 && loadedBytes < totalBytes ? `${Math.round((loadedBytes / totalBytes) * 100)}%` : 'loading';
}

/** Top left, like the team scores: what you're looking through, and when. */
function SceneChips({ timeOfDay }: { timeOfDay: boolean }) {
  const view = useStore((s) => s.settings.view);
  const sideBySide = useStore((s) => sideBySideOnScreen(s.settings));
  const tod = useStore((s) => s.settings.timeOfDay);
  const todLoading = useStore((s) => s.runtime.timeOfDayLoading);
  const t = TIMES_OF_DAY.find((x) => x.id === tod)!;
  return (
    <div className="hud-chips">
      <Chip keyLabel="V" icon={view === 'camera' ? TbCamera : TbEye} label={view === 'camera' ? 'Camera' : 'Eye'} />
      <Chip keyLabel="C" icon={TbColumns2} label="Side by side" off={!sideBySide} />
      {timeOfDay && (
        <Chip keyLabel="T" icon={TIME_ICONS[tod]} label={t.label} status={todLoading && loadingText(todLoading)} />
      )}
    </div>
  );
}

function Hints() {
  return (
    <div className="hud-hints">
      <span><kbd>Tab</kbd><TbListDetails /></span>
      <span><kbd>U</kbd><TbEyeOff /></span>
      <span><kbd>H</kbd><TbHelp /></span>
    </div>
  );
}

function RefineBar() {
  const refine = useStore((s) => s.runtime.refine);
  if (refine.samples <= 0 || refine.samples >= refine.target) return null;
  return (
    <div className="hud-refine">
      <span>Refining</span>
      <div className="hud-refine-bar"><div style={{ width: `${(refine.samples / refine.target) * 100}%` }} /></div>
      <span>{refine.samples}/{refine.target}</span>
    </div>
  );
}

/** Under the AF point, like the distance to a marker. */
function AfDistance() {
  const centre = useStore((s) => s.runtime.centreDistanceM);
  return <div className="hud-af-distance">{centreText(centre)}</div>;
}

/** Hold Tab: the full readout (§9.2). Side by side, it opens under the finders rather than over them. */
function Details({ top }: { top: number | null }) {
  const open = useStore((s) => s.detailsOpen);
  const centre = useStore((s) => s.runtime.centreDistanceM);
  const o = useOptics();
  if (!open) return null;
  const hint = fNumberHint(o);
  const rows: [string, string][] = [
    ['Focal length', `${Math.round(o.focalMm)} mm (${Math.round(o.equivalentFocalMm)} mm equiv.)`],
    ['Field of view', `H ${o.hfovDeg.toFixed(1)}° · V ${o.vfovDeg.toFixed(1)}° · D ${o.dfovDeg.toFixed(1)}°`],
    ['Aperture', hint ? `${formatFNumber(o.fNumber)} (${hint})` : formatFNumber(o.fNumber)],
    ['Shutter', `${shutterLabel(o.shutterS)} · ${exposureNote(o)}`],
    ['Focus', formatDistanceM(o.focusM)],
    ['Depth of field', `${dofText(o)} (${dofDepthText(o)})`],
    ['Hyperfocal', formatDistanceM(o.hyperfocalM)],
    ['AF point', centreText(centre)],
  ];
  return (
    <div className={top === null ? 'hud-details' : 'hud-details below'} style={top === null ? undefined : { top }}>
      <h2>{o.lens.name}</h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Everything on screen besides the image (§9.1). U hides it; the AF point and frame lines belong to the view. */
export function Hud({ debug, timeOfDay, frameWidth }: { debug: boolean; timeOfDay: boolean; frameWidth: number }) {
  const visible = useStore((s) => s.hudVisible);
  const settings = useStore((s) => s.settings);
  const viewport = useStore((s) => s.runtime.viewport);
  if (!visible) return null;
  const scale = hudScale(viewport.height);
  const sideBySide = sideBySideOnScreen(settings);
  // Side by side, the details card goes under the finder row; it's zoomed with the HUD, hence ÷ scale.
  const rects = sideBySide
    ? finderRects(viewport.width, viewport.height, settings.sideBySideLensIds.length, getBody(settings.bodyId).imageAspect, scale)
    : [];
  const detailsTop = sideBySide ? (finderRowBottom(rects, scale) + 14 * scale) / scale : null;
  return (
    <div className="hud" style={{ '--hud-scale': scale } as CSSProperties}>
      <SceneChips timeOfDay={timeOfDay} />
      <Hints />
      {debug ? <DebugOverlay frameWidth={frameWidth} /> : <FpsCounter />}
      {settings.view === 'camera' && <RefineBar />}
      {(settings.view === 'camera' || sideBySide) && <AfDistance />}
      <ExposureStack />
      <LensLoadout />
      <Details top={detailsTop} />
    </div>
  );
}
