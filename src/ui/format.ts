import { formatDistanceM } from '../optics/focusScale';
import { formatEvThirds, formatFNumber, shutterLabel } from '../optics/stops';
import type { DerivedOptics } from '../optics/types';

export function focalText(o: DerivedOptics): string {
  return `${Math.round(o.focalMm)} mm (${Math.round(o.equivalentFocalMm)} mm equiv.)`;
}

export function fovText(o: DerivedOptics): string {
  return `H ${o.hfovDeg.toFixed(1)}° · V ${o.vfovDeg.toFixed(1)}° · D ${o.dfovDeg.toFixed(1)}°`;
}

export function fNumberHint(o: DerivedOptics): string | null {
  const f = Math.round(o.focalMm);
  if (o.clamped === 'widest') return `widest at ${f} mm: ${formatFNumber(o.widestFNumber)}`;
  if (o.clamped === 'narrowest') return `narrowest at ${f} mm: ${formatFNumber(o.narrowestFNumber)}`;
  return null;
}

/** Av at the end of the body's shutter range: the camera can't expose correctly and over- or underexposes. */
export function avOutOfRange(o: DerivedOptics): boolean {
  return o.exposureMode === 'Av' && Math.round(o.evOffset * 3) !== 0;
}

export function shutterText(o: DerivedOptics): string {
  const t = shutterLabel(o.shutterS);
  if (o.exposureMode === 'M') return `${t} · ${formatEvThirds(o.evOffset)}`;
  return avOutOfRange(o) ? `${t} · ISO 100 · ${formatEvThirds(o.evOffset)}` : `${t} · ISO 100`;
}

function lengthText(m: number): string {
  if (m < 0.01) return `${(m * 1000).toFixed(1)} mm`;
  if (m < 1) return `${Math.round(m * 100)} cm`;
  return formatDistanceM(m);
}

export function dofText(o: DerivedOptics): string {
  if (!Number.isFinite(o.dofFarM)) return `${formatDistanceM(o.dofNearM)} – ∞`;
  return `${formatDistanceM(o.dofNearM, false)} – ${formatDistanceM(o.dofFarM)} (${lengthText(o.dofFarM - o.dofNearM)})`;
}

export function centreText(d: number | null): string {
  return d === null ? '∞ (sky)' : formatDistanceM(d);
}
