import type { CameraBody, Lens } from './types';

export const EF_50_18_STM: Lens = {
  id: 'ef-50-1.8-stm',
  name: 'EF 50mm f/1.8 STM',
  mount: 'EF',
  focalMm: { min: 50, max: 50 },
  maxAperture: [{ fromFocalMm: 50, fNumber: 1.8 }],
  minAperture: [{ fromFocalMm: 50, fNumber: 22 }],
  closestFocusM: 0.35,
  blades: 7,
  roundness: { wideOpen: 1, stoppedDown: 0.1, stopsToStoppedDown: 2 },
  vignetteCornerEv: [{ focalMm: 50, ev: 0.8 }],
  info: { maxMagnification: '0.21×', construction: '6 elements / 5 groups', filterMm: 49, weightG: 160 },
  estimated: ['roundness', 'vignetteCornerEv'],
};

export const EF_S_18_55_STM: Lens = {
  id: 'ef-s-18-55-4-5.6-is-stm',
  name: 'EF-S 18-55mm f/4-5.6 IS STM',
  mount: 'EF-S',
  focalMm: { min: 18, max: 55 },
  // Canon publishes only the endpoints; the breakpoints follow N ∝ f^0.311 (SPEC §7.3).
  maxAperture: [
    { fromFocalMm: 18, fNumber: 4 },
    { fromFocalMm: 22, fNumber: 4.5 },
    { fromFocalMm: 32, fNumber: 5 },
    { fromFocalMm: 46, fNumber: 5.6 },
  ],
  minAperture: [
    { fromFocalMm: 18, fNumber: 22 },
    { fromFocalMm: 22, fNumber: 25 },
    { fromFocalMm: 32, fNumber: 29 },
    { fromFocalMm: 46, fNumber: 32 },
  ],
  closestFocusM: 0.25,
  blades: 7,
  roundness: { wideOpen: 1, stoppedDown: 0.1, stopsToStoppedDown: 2 },
  vignetteCornerEv: [
    { focalMm: 18, ev: 1.0 },
    { focalMm: 55, ev: 0.6 },
  ],
  info: { maxMagnification: '0.25× (at 55 mm)', construction: '12 elements / 10 groups', filterMm: 58, weightG: 215 },
  estimated: ['maxAperture', 'minAperture', 'roundness', 'vignetteCornerEv'],
};

export const LENSES: Lens[] = [EF_50_18_STM, EF_S_18_55_STM];

export function canMount(body: CameraBody, lens: Lens): boolean {
  return body.acceptsMounts.includes(lens.mount);
}

export function lensesFor(body: CameraBody): Lens[] {
  return LENSES.filter((l) => canMount(body, l));
}

export function getLens(id: string): Lens {
  return LENSES.find((l) => l.id === id) ?? LENSES[0];
}

export function isZoom(lens: Lens): boolean {
  return lens.focalMm.max > lens.focalMm.min;
}
