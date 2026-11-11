import type { PointerEvent, ReactNode } from 'react';
import { BODIES, getBody } from '../optics/bodies';
import { FOCUS_SLIDER_MAX, focusMToSlider, formatDistanceM, sliderToFocusM } from '../optics/focusScale';
import { isZoom, lensesFor } from '../optics/lenses';
import { formatFNumber, stopsWithin } from '../optics/stops';
import { useOptics, useStore } from '../state/store';
import { Readout } from './Readout';

// Hand focus back to the page after a mouse interaction, so shortcuts keep working (§9.3).
const release = (e: PointerEvent<HTMLElement>) => e.currentTarget.blur();

const ZOOM_TICKS = [18, 24, 35, 45, 55];
const FOCUS_TICKS = [1, 3, 10, 100, Infinity];
const FULL_STOPS = [1.8, 2.8, 4, 5.6, 8, 11, 16, 22, 32];

function Field({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        {value !== undefined && <span className="field-value">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function Ticks({ ticks }: { ticks: { at: number; label: string }[] }) {
  // Drop labels that would collide with the previous one.
  const shown = ticks.filter((t, i) => i === 0 || t.at - ticks[i - 1].at >= 0.07);
  return (
    <div className="ticks" aria-hidden="true">
      {shown.map((t) => (
        <span key={t.label} style={{ left: `calc(8px + (100% - 16px) * ${t.at})` }}>{t.label}</span>
      ))}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          title={o.hint}
          onClick={() => onChange(o.value)}
          onPointerUp={release}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ControlPanel() {
  const settings = useStore((s) => s.settings);
  const o = useOptics();
  const s = useStore.getState();
  const body = getBody(settings.bodyId);
  const lens = o.lens;

  const stops = stopsWithin(o.widestFNumber, o.narrowestFNumber);
  const stopIndex = Math.max(0, stops.indexOf(o.fNumber));
  const focusPos = focusMToSlider(o.focusM, lens.closestFocusM);
  const zoomRange = lens.focalMm.max - lens.focalMm.min;

  return (
    <aside className="panel">
      <header className="panel-title">
        <span>Viewfinder</span>
        <button type="button" className="help-button" onClick={() => s.setHelpOpen(true)} onPointerUp={release}>
          Help <kbd>H</kbd>
        </button>
      </header>

      <Field label="Camera">
        <select value={settings.bodyId} onChange={(e) => { s.setBody(e.target.value); e.target.blur(); }}>
          {BODIES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>

      <Field label="Lens">
        <select value={settings.lensId} onChange={(e) => { s.setLens(e.target.value); e.target.blur(); }}>
          {lensesFor(body).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>

      {isZoom(lens) && (
        <Field label="Zoom" value={`${Math.round(o.focalMm)} mm`}>
          <input
            type="range"
            min={lens.focalMm.min}
            max={lens.focalMm.max}
            step={1}
            value={o.focalMm}
            onChange={(e) => s.setFocal(Number(e.target.value))}
            onPointerUp={release}
            aria-label="Zoom"
          />
          <Ticks ticks={ZOOM_TICKS.filter((t) => t >= lens.focalMm.min && t <= lens.focalMm.max)
            .map((t) => ({ at: (t - lens.focalMm.min) / zoomRange, label: String(t) }))} />
        </Field>
      )}

      <Field label="Aperture" value={formatFNumber(o.fNumber)}>
        <input
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={stopIndex}
          onChange={(e) => s.setRequestedFNumber(stops[Number(e.target.value)])}
          onPointerUp={release}
          aria-label="Aperture"
        />
        <Ticks ticks={stops.flatMap((n, i) => FULL_STOPS.includes(n) || i === 0 || i === stops.length - 1
          ? [{ at: i / (stops.length - 1), label: String(n) }] : [])} />
      </Field>

      <Field label="Focus" value={formatDistanceM(o.focusM)}>
        <input
          type="range"
          min={0}
          max={FOCUS_SLIDER_MAX}
          step={1}
          value={focusPos}
          onChange={(e) => s.setFocusM(sliderToFocusM(Number(e.target.value), lens.closestFocusM))}
          onPointerUp={release}
          aria-label="Focus distance"
        />
        <Ticks ticks={[lens.closestFocusM, ...FOCUS_TICKS].map((d) => ({
          at: focusMToSlider(d, lens.closestFocusM) / FOCUS_SLIDER_MAX,
          label: Number.isFinite(d) ? String(d) : '∞',
        }))} />
      </Field>

      <Field label="Exposure">
        <Segmented
          value={settings.exposureMode}
          onChange={s.setExposureMode}
          options={[
            { value: 'Av', label: 'Av', hint: 'Aperture priority: brightness stays constant (X)' },
            { value: 'M', label: 'M', hint: 'Manual: exposure locked, stopping down darkens (X)' },
          ]}
        />
      </Field>

      <Field label="View">
        <Segmented
          value={settings.view}
          onChange={s.setView}
          options={[
            { value: 'camera', label: 'Camera', hint: 'Through the viewfinder (V)' },
            { value: 'eye', label: 'Eye', hint: 'Wide human view with frame lines (V)' },
          ]}
        />
      </Field>

      <Readout />
    </aside>
  );
}
