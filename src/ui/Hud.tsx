import { useEffect, type CSSProperties, type ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { MdPinch } from 'react-icons/md';
import {
  TbAperture, TbArrowsExchange, TbCamera, TbChartDonut, TbChevronDown, TbChevronLeft, TbChevronRight, TbChevronUp,
  TbColumns2, TbEye, TbEyeOff, TbFocus2, TbHelp, TbHome, TbListDetails, TbMaximize, TbMinimize, TbMoonStars,
  TbStopwatch, TbSun, TbSunLow, TbSunset2, TbWalk,
} from 'react-icons/tb';
import { PiMouseScrollBold } from 'react-icons/pi';
import { getBody } from '../optics/bodies';
import { FOCUS_SLIDER_MAX, focusMToSlider, formatDistanceM, sliderToFocusM } from '../optics/focusScale';
import { isZoom, lensesFor } from '../optics/lenses';
import { formatFNumber, shutterLabel, stopsWithin } from '../optics/stops';
import type { DerivedOptics } from '../optics/types';
import { finderRects, finderRowBottom } from '../render/layout';
import { TIMES_OF_DAY, type TimeOfDay } from '../scene/timeOfDay';
import { sideBySideOnScreen, useHudScale, useOptics, useStore } from '../state/store';
import { touchPad } from '../state/touchPad';
import { DebugOverlay, FpsCounter } from './DebugOverlay';
import {
  avOutOfRange, centreText, dofDepthText, dofText, exposureNote, fNumberHint, fovText, lensFocalLabel,
} from './format';
import { fullscreenSupported, toggleFullscreen, useFullscreen } from './input';
import { useSliderDrag, type Slider } from './slider';
import { HoldButton, RepeatButton, TouchButton } from './TouchButtons';

const TIME_ICONS: Record<TimeOfDay, IconType> = { noon: TbSun, golden: TbSunLow, evening: TbSunset2, night: TbMoonStars };

/** Segments on the focus and zoom bars. */
const FOCUS_SEGMENTS = 24;
const ZOOM_SEGMENTS = 14;
/** The exposure meter spans ±3 EV in thirds, like the camera's level indicator. */
const METER_THIRDS = 9;

type SegmentState = 'lit' | 'mark' | 'warn' | null;

const useTouch = () => useStore((s) => s.input === 'touch');

/** A bar of segments, like a health bar. Touch sliders find the segment under the finger by `data-seg`. */
function Segments({ count, state, className, children }: {
  count: number;
  state: (i: number) => SegmentState;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={className ? `hud-segments ${className}` : 'hud-segments'}>
      {Array.from({ length: count }, (_, i) => <span key={i} data-seg={i} className={state(i) ?? undefined} />)}
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

/** Touch: steps a setting either way, in place of its keys; ‹ moves the bar's mark left. */
interface Stepper {
  labels: [string, string];
  step: (dir: -1 | 1, big: boolean) => void;
}

/**
 * One setting in the bottom-left stack: icon, keys, value, and a bar showing where it sits in its range.
 * Touch (§9.5): steppers take the keys' place, and the row is a slider over its bar, or a button.
 */
function Row({ icon: Icon, keys, children, note, warn, bar, stepper, slider, onTap }: {
  icon: IconType;
  keys: string[];
  children: ReactNode;
  note?: string | null;
  warn?: boolean;
  bar: ReactNode;
  stepper?: Stepper;
  slider?: Slider;
  onTap?: { label: string; action: () => void };
}) {
  const touch = useTouch();
  const drag = useSliderDrag(touch ? slider : undefined, useHudScale());
  let prompt: ReactNode = <span className="hud-keys">{keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>;
  if (touch && stepper) {
    prompt = (
      <span className="hud-keys">
        <RepeatButton className="hud-step" label={stepper.labels[0]} onStep={(big) => stepper.step(-1, big)}>
          <TbChevronLeft />
        </RepeatButton>
        <RepeatButton className="hud-step" label={stepper.labels[1]} onStep={(big) => stepper.step(1, big)}>
          <TbChevronRight />
        </RepeatButton>
      </span>
    );
  } else if (touch && onTap) {
    prompt = <span className="hud-keys"><span className="hud-step"><TbArrowsExchange /></span></span>;
  }
  const content = (
    <>
      <div className="hud-icon"><Icon /></div>
      <div className="hud-row-body">
        <div className="hud-row-head">
          {prompt}
          {children}
          {note && <span className={warn ? 'hud-row-note warn' : 'hud-row-note'}>{note}</span>}
        </div>
        {bar}
      </div>
    </>
  );
  if (touch && onTap) {
    return <TouchButton className="hud-row" label={onTap.label} onTap={onTap.action}>{content}</TouchButton>;
  }
  return <div className={touch && slider ? 'hud-row hud-slider' : 'hud-row'} {...drag}>{content}</div>;
}

function ApertureRow({ o }: { o: DerivedOptics }) {
  const stops = stopsWithin(o.widestFNumber, o.narrowestFNumber);
  const index = stops.indexOf(o.fNumber);
  const last = Math.max(stops.length - 1, 1);
  return (
    <Row
      icon={TbAperture}
      keys={['[', ']']}
      note={fNumberHint(o)}
      warn
      bar={<Segments count={stops.length} state={level(index)} />}
      stepper={{
        labels: ['Aperture wider', 'Aperture narrower'],
        step: (dir) => useStore.getState().stepAperture(dir),
      }}
      slider={{
        count: stops.length,
        fraction: Math.max(index, 0) / last,
        set: (f) => useStore.getState().setRequestedFNumber(stops[Math.round(f * last)]),
      }}
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
      stepper={{
        labels: ['Focus nearer', 'Focus farther'],
        step: (dir, big) => useStore.getState().stepFocus(dir * (big ? 10 : 1)),
      }}
      slider={{
        count: FOCUS_SEGMENTS,
        fraction: focusMToSlider(o.focusM, closest) / FOCUS_SLIDER_MAX,
        set: (f) => useStore.getState().setFocusM(sliderToFocusM(Math.round(f * FOCUS_SLIDER_MAX), closest)),
      }}
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
      onTap={{ label: 'Exposure mode Av / M', action: () => useStore.getState().toggleExposureMode() }}
    >
      <Flash className="hud-row-mode" value={o.exposureMode} />
      {/* Blinks like the camera's display when Av runs out of shutter speeds. */}
      <Flash className={outOfRange ? 'hud-row-value warn blink' : 'hud-row-value'} value={shutterLabel(o.shutterS)} />
    </Row>
  );
}

/** Touch: where the walking joystick appears when nothing holds it (§9.5). */
function StickGhost() {
  const held = useStore((s) => s.touchStick !== null);
  return (
    <div className={held ? 'hud-stick-ghost held' : 'hud-stick-ghost'}>
      <span><TbWalk /></span>
    </div>
  );
}

/** Bottom left: the body, then aperture, focus and exposure. */
function ExposureStack() {
  const o = useOptics();
  const touch = useTouch();
  const body = getBody(useStore((s) => s.settings.bodyId));
  return (
    <div className="hud-stack">
      {touch && <StickGhost />}
      <div className="hud-heading"><TbCamera />{body.name}</div>
      <ApertureRow o={o} />
      <FocusRow o={o} />
      <ExposureRow o={o} />
    </div>
  );
}

/** Touch: Q and E as buttons, held to lower or raise the eye. */
function EyeHeight() {
  useEffect(() => () => {
    touchPad.height = 0;
  }, []);
  const hold = (dir: -1 | 1) => (down: boolean) => {
    touchPad.height = down ? dir : 0;
  };
  return (
    <div className="hud-height">
      <HoldButton className="hud-plate" label="Raise eye height" onHold={hold(1)}><TbChevronUp /></HoldButton>
      <HoldButton className="hud-plate" label="Lower eye height" onHold={hold(-1)}><TbChevronDown /></HoldButton>
      <span className="hud-height-label">Height</span>
    </div>
  );
}

/**
 * Bottom right, like a weapon loadout: the lens, its focal length, and the lenses L cycles through. Side by
 * side, the slots of lenses with a finder are outlined. Space opens the lens wheel. Touch: the slots select,
 * the wheel has a button, and the zoom bar is a slider.
 */
function LensLoadout() {
  const o = useOptics();
  const touch = useTouch();
  const scale = useHudScale();
  const settings = useStore((s) => s.settings);
  const body = getBody(settings.bodyId);
  const shown = sideBySideOnScreen(settings) ? settings.sideBySideLensIds : [];
  const lens = o.lens;
  const zoom = isZoom(lens);
  const range = lens.focalMm.max - lens.focalMm.min;
  const zoomFraction = zoom ? (o.focalMm - lens.focalMm.min) / range : 0;
  const zoomAt = Math.round(zoomFraction * (ZOOM_SEGMENTS - 1));
  const zoomDrag = useSliderDrag(touch && zoom ? {
    count: ZOOM_SEGMENTS,
    fraction: zoomFraction,
    set: (f) => useStore.getState().setFocal(lens.focalMm.min + f * range),
  } : undefined, scale);
  const WheelPrompt = touch ? MdPinch : PiMouseScrollBold;
  return (
    <div className="hud-lens">
      {touch && <EyeHeight />}
      <Flash className="hud-lens-name" value={lens.name} />
      <div className="hud-lens-focal">
        {zoom && <WheelPrompt className="hud-wheel" />}
        <Flash value={String(Math.round(o.focalMm))} />
        <small>mm</small>
      </div>
      <div className="hud-lens-sub">{Math.round(o.equivalentFocalMm)} mm equiv. · {fovText(o)}</div>
      {zoom && (
        <div className={touch ? 'hud-zoom-slider hud-slider' : 'hud-zoom-slider'} {...zoomDrag}>
          <Segments className="hud-zoom" count={ZOOM_SEGMENTS} state={level(zoomAt)} />
        </div>
      )}
      <div className="hud-slots">
        {touch ? (
          <TouchButton className="hud-plate hud-wheel-button" label="Lens wheel" onTap={() => useStore.getState().openWheel()}>
            <TbChartDonut />
          </TouchButton>
        ) : (
          <>
            <kbd>Space</kbd>
            <TbChartDonut className="hud-wheel-icon" />
            <kbd>L</kbd>
          </>
        )}
        {lensesFor(body).map((l) => {
          const className = l.id === lens.id ? 'on' : shown.includes(l.id) ? 'shown' : undefined;
          const label = <>{lensFocalLabel(l)}<small>mm</small></>;
          return touch ? (
            <TouchButton key={l.id} className={className ? `hud-slot ${className}` : 'hud-slot'} label={l.name} onTap={() => useStore.getState().setLens(l.id)}>
              {label}
            </TouchButton>
          ) : (
            <span key={l.id} className={className ? `hud-slot ${className}` : 'hud-slot'}>{label}</span>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ keyLabel, icon: Icon, label, status, off, onTap }: {
  keyLabel: string;
  icon: IconType;
  label: string;
  status?: string | null;
  /** A toggle that's off: dimmed. */
  off?: boolean;
  /** Touch: the chip is a button. */
  onTap: () => void;
}) {
  const touch = useTouch();
  const className = off ? 'hud-chip off' : 'hud-chip';
  const content = (
    <>
      {!touch && <kbd>{keyLabel}</kbd>}
      <span className="hud-badge"><Icon /></span>
      <Flash key={off ? 'off' : 'on'} className="hud-chip-label" value={label} />
      {status && <span className="hud-chip-status">{status}</span>}
    </>
  );
  return touch
    ? <TouchButton className={className} label={label} onTap={onTap}>{content}</TouchButton>
    : <div className={className}>{content}</div>;
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
  const s = useStore.getState;
  return (
    <div className="hud-chips">
      <Chip
        keyLabel="V"
        icon={view === 'camera' ? TbCamera : TbEye}
        label={view === 'camera' ? 'Camera' : 'Eye'}
        onTap={() => s().toggleView()}
      />
      <Chip keyLabel="C" icon={TbColumns2} label="Side by side" off={!sideBySide} onTap={() => s().toggleSideBySide()} />
      {timeOfDay && (
        <Chip
          keyLabel="T"
          icon={TIME_ICONS[tod]}
          label={t.label}
          status={todLoading && loadingText(todLoading)}
          onTap={() => s().nextTimeOfDay()}
        />
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

/** Touch: the hints as buttons, plus R and full screen, which have no other way in. */
function TouchHints() {
  const details = useStore((s) => s.detailsOpen);
  const fullscreen = useFullscreen();
  const s = useStore.getState;
  return (
    <div className="hud-hints">
      <TouchButton className="hud-plate" label="Back to spawn" onTap={() => { touchPad.respawn = true; }}>
        <TbHome />
      </TouchButton>
      {fullscreenSupported && (
        <TouchButton className="hud-plate" label={fullscreen ? 'Leave full screen' : 'Full screen'} onTap={toggleFullscreen}>
          {fullscreen ? <TbMinimize /> : <TbMaximize />}
        </TouchButton>
      )}
      <TouchButton className={details ? 'hud-plate on' : 'hud-plate'} label="Details" onTap={() => s().setDetailsOpen(!details)}>
        <TbListDetails />
      </TouchButton>
      <TouchButton className="hud-plate" label="Hide the HUD" onTap={() => s().setHudVisible(false)}>
        <TbEyeOff />
      </TouchButton>
      <TouchButton className="hud-plate" label="Help" onTap={() => s().setHelpOpen(true)}>
        <TbHelp />
      </TouchButton>
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

/**
 * Hold Tab: the full readout (§9.2). Side by side, it opens under the finders rather than over them, unless
 * there's no room left there. Touch: its button toggles it, and a tap on it closes it.
 */
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
    <div
      className={top === null ? 'hud-details' : 'hud-details below'}
      style={top === null ? undefined : { top }}
      onClick={() => useStore.getState().setDetailsOpen(false)}
    >
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

/** The details card's height at HUD scale 1, about, to tell whether it fits under the finders. */
const DETAILS_HEIGHT_PX = 330;

/**
 * Everything on screen besides the image (§9.1). U hides it; the AF point and frame lines belong to the view.
 * Touch (§9.5): the same clusters, operated by tapping and dragging them.
 */
export function Hud({ debug, timeOfDay, frameWidth }: { debug: boolean; timeOfDay: boolean; frameWidth: number }) {
  const visible = useStore((s) => s.hudVisible);
  const touch = useTouch();
  const settings = useStore((s) => s.settings);
  const viewport = useStore((s) => s.runtime.viewport);
  const safeArea = useStore((s) => s.runtime.safeArea);
  const scale = useHudScale();
  const sideBySide = sideBySideOnScreen(settings);
  const view = settings.view;
  const classes = ['hud'];
  if (touch) classes.push('touch');
  if (viewport.height > viewport.width) classes.push('portrait');
  const style = { '--hud-scale': scale } as CSSProperties;
  if (!visible) {
    // Touch has no U key, so a button brings it back.
    return touch ? (
      <div className={classes.join(' ')} style={style}>
        <TouchButton className="hud-plate hud-show" label="Show the HUD" onTap={() => useStore.getState().setHudVisible(true)}>
          <TbEye />
        </TouchButton>
      </div>
    ) : null;
  }
  // Side by side, the details card goes under the finder row; it's zoomed with the HUD, hence ÷ scale.
  const aspect = getBody(settings.bodyId).imageAspect;
  const rects = sideBySide
    ? finderRects(viewport.width, viewport.height, settings.sideBySideLensIds.length, aspect, scale, safeArea)
    : [];
  const below = sideBySide ? finderRowBottom(rects, scale) + 14 * scale : null;
  const detailsTop = below !== null && below + DETAILS_HEIGHT_PX * scale <= viewport.height ? below / scale : null;
  return (
    <div className={classes.join(' ')} style={style}>
      <SceneChips timeOfDay={timeOfDay} />
      {touch ? <TouchHints /> : <Hints />}
      {debug ? <DebugOverlay frameWidth={frameWidth} /> : <FpsCounter />}
      {view === 'camera' && <RefineBar />}
      {(view === 'camera' || sideBySide) && <AfDistance />}
      <ExposureStack />
      <LensLoadout />
      <Details top={detailsTop} />
    </div>
  );
}
