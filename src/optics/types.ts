export type Mount = 'EF' | 'EF-S';

export interface CameraBody {
  id: string;
  name: string;
  acceptsMounts: Mount[];            // lens mounts that physically fit
  sensorWidthMm: number;             // active image width
  imageAspect: number;               // width / height of the recorded image
  imagePx: { width: number; height: number };
  cocMm: number;                     // circle of confusion for DoF readouts
  cropFactorNominal: number;         // for "equivalent focal length" display
  shutterRangeS: { fastest: number; slowest: number };  // nominal powers of two behind the labels (§8.5)
}

export interface FocalStep { fromFocalMm: number; fNumber: number }

export interface Lens {
  id: string;
  name: string;
  mount: Mount;
  focalMm: { min: number; max: number };          // min === max for primes
  maxAperture: FocalStep[];                       // widest f-number by focal length
  minAperture: FocalStep[];                       // smallest f-number by focal length
  closestFocusM: number;
  blades: number;
  roundness: { wideOpen: number; stoppedDown: number; stopsToStoppedDown: number };
  vignetteCornerEv: { focalMm: number; ev: number }[];  // at widest aperture; interpolate linearly
  info: { maxMagnification: string; construction: string; filterMm: number; weightG: number };
  estimated: string[];                            // fields that are estimates, not published specs
}

export type ExposureMode = 'Av' | 'M';

export interface ManualLock { fNumber: number; shutterS: number }

/** The part of the user's settings that the optics depend on. */
export interface OpticsSettings {
  focalMm: number;
  requestedFNumber: number;
  focusM: number;                                 // Infinity allowed
  exposureMode: ExposureMode;
  manualLock: ManualLock | null;
}

export interface DerivedOptics {
  body: CameraBody;
  lens: Lens;
  focalMm: number;                                // clamped to the lens's range
  equivalentFocalMm: number;
  sensorWidthMm: number;
  sensorHeightMm: number;
  imageAspect: number;
  hfovDeg: number;
  vfovDeg: number;
  dfovDeg: number;
  requestedFNumber: number;
  fNumber: number;                                // effective, after clamping
  widestFNumber: number;                          // at this focal length
  narrowestFNumber: number;                       // at this focal length
  clamped: 'widest' | 'narrowest' | null;
  stopsDown: number;                              // Δ, stops down from wide open
  apertureMm: number;                             // entrance pupil diameter A = f / N
  focusM: number;                                 // clamped to closest focus; Infinity allowed
  cocMm: number;
  hyperfocalM: number;
  dofNearM: number;
  dofFarM: number;                                // Infinity allowed
  blades: number;
  roundness: number;                              // 1 = round, 0 = straight blades
  vignetteEv: number;                             // corner falloff in EV (§10.6)
  exposureMode: ExposureMode;
  shutterS: number;                               // within the body's range
  exposureFactor: number;                         // linear brightness vs a correct exposure
  evOffset: number;                               // exposure error in EV: M vs the lock, Av at a shutter limit
}
