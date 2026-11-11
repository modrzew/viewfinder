// Quality and performance constants.

export const CONFIG = {
  /** Internal resolution: frame CSS px × min(devicePixelRatio, maxPixelRatio), capped in width. */
  maxPixelRatio: 1.5,
  maxRenderWidthPx: 2560,

  nearM: 0.03,
  farM: 2000,

  /** Refined DoF (§10.1, §10.3). */
  refineTarget: 256,
  refineTargetRange: [64, 1024] as const,
  apertureSampleCount: 1024,
  previewUntilSamples: 32,
  crossfadeMs: 150,
  maxSamplesPerFrame: 16,
  targetFrameMs: 33,
  /** Frames without optical change before INTERACTIVE switches to REFINING. */
  stillFrames: 2,
  /** Per-sample residual blur against dotted bokeh (§10.3). */
  residualBlur: true,
  /** Radius = k·|b_px|/√target. Larger k smooths bokeh texture but makes discs lumpy. */
  residualBlurK: 0.45,
  residualBlurMaxPx: 8,

  /** Interactive DoF (§10.4): blur radius clamp in full-res px. */
  gatherMaxRadiusPx: 48,
  gatherKernelSize: 64,

  /** Eye view (§9.1). */
  eyeHfovDeg: 90,

  /** Rangefinder (§10.7). */
  rangefinderHz: 10,

  /** Movement (§9.3, §11.6). */
  walkSpeedMps: 1.4,
  runMultiplier: 2.5,
  moveSmoothingS: 0.1,
  eyeHeightM: { min: 0.3, max: 1.9, default: 1.2 },
  eyeHeightSpeedMps: 0.6,
  pitchLimitDeg: 85,
  /** Look speed in rad per mouse px at the reference vertical FOV; scales with tan(vfov/2). */
  lookRadPerPx: 0.0022,
  lookReferenceVfovDeg: 45,
  playerRadiusM: 0.15,
} as const;
