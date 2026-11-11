import { formatDistanceM } from '../optics/focusScale';
import { formatEvThirds } from '../optics/stops';
import type { DerivedOptics } from '../optics/types';

export function fovText(o: DerivedOptics): string {
  return `${o.hfovDeg.toFixed(1)}° × ${o.vfovDeg.toFixed(1)}°`;
}

/** Why the f-number isn't the requested one; the value next to it says what it is. */
export function fNumberHint(o: DerivedOptics): string | null {
  const f = Math.round(o.focalMm);
  if (o.clamped === 'widest') return `widest at ${f} mm`;
  if (o.clamped === 'narrowest') return `narrowest at ${f} mm`;
  return null;
}

/** Av at the end of the body's shutter range: the camera can't expose correctly and over- or underexposes. */
export function avOutOfRange(o: DerivedOptics): boolean {
  return o.exposureMode === 'Av' && Math.round(o.evOffset * 3) !== 0;
}

/** ISO, plus the exposure error in M or at an Av shutter limit. */
export function exposureNote(o: DerivedOptics): string {
  return o.exposureMode === 'M' || avOutOfRange(o) ? `ISO 100 · ${formatEvThirds(o.evOffset)}` : 'ISO 100';
}

function lengthText(m: number): string {
  if (m < 0.01) return `${(m * 1000).toFixed(1)} mm`;
  if (m < 1) return `${Math.round(m * 100)} cm`;
  return formatDistanceM(m);
}

export function dofText(o: DerivedOptics): string {
  if (!Number.isFinite(o.dofFarM)) return `${formatDistanceM(o.dofNearM)} – ∞`;
  return `${formatDistanceM(o.dofNearM, false)} – ${formatDistanceM(o.dofFarM)}`;
}

export function dofDepthText(o: DerivedOptics): string {
  return Number.isFinite(o.dofFarM) ? `${lengthText(o.dofFarM - o.dofNearM)} deep` : 'to infinity';
}

export function centreText(d: number | null): string {
  return d === null ? '∞ (sky)' : formatDistanceM(d);
}
