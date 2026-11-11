import { apertureRoundness } from './aperture';
import type { CameraBody, DerivedOptics, FocalStep, Lens, OpticsSettings } from './types';

// All lengths in mm unless the name says otherwise (SPEC §8).

const DEG = 180 / Math.PI;

export const DEFAULT_EV100 = 12;

export function sensorHeightMm(body: CameraBody): number {
  return body.sensorWidthMm / body.imageAspect;
}

export function fovDeg(sizeMm: number, focalMm: number): number {
  return 2 * Math.atan(sizeMm / (2 * focalMm)) * DEG;
}

export function fieldOfView(body: CameraBody, focalMm: number) {
  const w = body.sensorWidthMm;
  const h = sensorHeightMm(body);
  return {
    hfovDeg: fovDeg(w, focalMm),
    vfovDeg: fovDeg(h, focalMm),
    dfovDeg: fovDeg(Math.hypot(w, h), focalMm),
  };
}

export function clampFocal(lens: Lens, focalMm: number): number {
  return Math.min(Math.max(focalMm, lens.focalMm.min), lens.focalMm.max);
}

function stepAt(steps: FocalStep[], focalMm: number): number {
  let n = steps[0].fNumber;
  for (const s of steps) if (focalMm >= s.fromFocalMm - 1e-9) n = s.fNumber;
  return n;
}

/** Widest (smallest) f-number available at this focal length. */
export function widestAt(lens: Lens, focalMm: number): number {
  return stepAt(lens.maxAperture, focalMm);
}

/** Narrowest (largest) f-number available at this focal length. */
export function narrowestAt(lens: Lens, focalMm: number): number {
  return stepAt(lens.minAperture, focalMm);
}

export function effectiveFNumber(lens: Lens, focalMm: number, requested: number): number {
  return Math.min(Math.max(requested, widestAt(lens, focalMm)), narrowestAt(lens, focalMm));
}

/** Δ = 2·log2(N / N_widest). */
export function stopsDown(fNumber: number, widest: number): number {
  return 2 * Math.log2(fNumber / widest);
}

export function hyperfocalMm(f: number, n: number, c: number): number {
  return (f * f) / (n * c) + f;
}

/** Near and far DoF limits in mm; `s` may be Infinity. */
export function dofLimitsMm(f: number, n: number, c: number, s: number) {
  const h = hyperfocalMm(f, n, c);
  if (!Number.isFinite(s)) return { hyperfocal: h, near: h - f, far: Infinity };
  const near = (s * (h - f)) / (h + s - 2 * f);
  const far = s < h ? (s * (h - f)) / (h - s) : Infinity;
  return { hyperfocal: h, near, far };
}

/**
 * Signed blur-disc diameter on the sensor in mm (SPEC §8.4): negative in the
 * near field (d < s), positive in the far field. `s` and `d` may be Infinity.
 */
export function blurDiscMm(f: number, n: number, s: number, d: number): number {
  const a = f / n;
  // Focused at ∞, everything finite is in the near field.
  if (!Number.isFinite(s)) return Number.isFinite(d) ? -(a * f) / d : 0;
  const k = (a * f) / (s - f);
  if (!Number.isFinite(d)) return k;
  return (k * (d - s)) / d;
}

export function blurDiscPx(bMm: number, sensorWidthMm: number, renderWidthPx: number): number {
  return (bMm / sensorWidthMm) * renderWidthPx;
}

/** Linear interpolation over the lens's corner-falloff table. */
export function vignetteCornerEvAt(lens: Lens, focalMm: number): number {
  const t = lens.vignetteCornerEv;
  if (focalMm <= t[0].focalMm) return t[0].ev;
  for (let i = 1; i < t.length; i++) {
    if (focalMm <= t[i].focalMm) {
      const u = (focalMm - t[i - 1].focalMm) / (t[i].focalMm - t[i - 1].focalMm);
      return t[i - 1].ev + u * (t[i].ev - t[i - 1].ev);
    }
  }
  return t[t.length - 1].ev;
}

/** §10.6: v = cornerEv(f)·clamp(1 − Δ/2, 0, 1) + 0.15 */
export function vignetteEv(lens: Lens, focalMm: number, delta: number): number {
  return vignetteCornerEvAt(lens, focalMm) * Math.min(Math.max(1 - delta / 2, 0), 1) + 0.15;
}

/** Correct shutter time at ISO 100: t = N² / 2^EV100. */
export function avShutterS(fNumber: number, ev100: number): number {
  return (fNumber * fNumber) / Math.pow(2, ev100);
}

export function clampShutterS(body: CameraBody, tS: number): number {
  return Math.min(Math.max(tS, body.shutterRangeS.fastest), body.shutterRangeS.slowest);
}

export function clampFocusM(lens: Lens, focusM: number): number {
  return Math.max(focusM, lens.closestFocusM);
}

export function deriveOptics(
  body: CameraBody,
  lens: Lens,
  settings: OpticsSettings,
  ev100: number = DEFAULT_EV100,
): DerivedOptics {
  const f = clampFocal(lens, settings.focalMm);
  const widest = widestAt(lens, f);
  const narrowest = narrowestAt(lens, f);
  const n = effectiveFNumber(lens, f, settings.requestedFNumber);
  const delta = stopsDown(n, widest);
  const c = body.cocMm;
  const focusM = clampFocusM(lens, settings.focusM);
  const dof = dofLimitsMm(f, n, c, focusM * 1000);
  const fov = fieldOfView(body, f);

  // Av picks the correct time unless the body's range stops it; M keeps the locked time. Either way the
  // image brightness is the actual time over the correct one, so M at the lock's EV gives (N_lock / N)².
  const lock = settings.exposureMode === 'M' ? settings.manualLock : null;
  const correctS = avShutterS(n, ev100);
  const shutterS = lock ? lock.shutterS : clampShutterS(body, correctS);
  const exposureFactor = shutterS / correctS;
  const evOffset = Math.log2(exposureFactor);

  return {
    body,
    lens,
    focalMm: f,
    equivalentFocalMm: f * body.cropFactorNominal,
    sensorWidthMm: body.sensorWidthMm,
    sensorHeightMm: sensorHeightMm(body),
    imageAspect: body.imageAspect,
    ...fov,
    requestedFNumber: settings.requestedFNumber,
    fNumber: n,
    widestFNumber: widest,
    narrowestFNumber: narrowest,
    clamped:
      settings.requestedFNumber < n - 1e-9 ? 'widest' : settings.requestedFNumber > n + 1e-9 ? 'narrowest' : null,
    stopsDown: delta,
    apertureMm: f / n,
    focusM,
    cocMm: c,
    hyperfocalM: dof.hyperfocal / 1000,
    dofNearM: dof.near / 1000,
    dofFarM: dof.far / 1000,
    blades: lens.blades,
    roundness: apertureRoundness(lens, delta),
    vignetteEv: vignetteEv(lens, f, delta),
    exposureMode: settings.exposureMode,
    shutterS,
    exposureFactor,
    evOffset,
  };
}

/** Signed blur-disc diameter in render pixels for a subject at `dM` metres. */
export function blurPxAt(o: DerivedOptics, dM: number, renderWidthPx: number): number {
  const b = blurDiscMm(o.focalMm, o.fNumber, o.focusM * 1000, dM * 1000);
  return blurDiscPx(b, o.sensorWidthMm, renderWidthPx);
}
