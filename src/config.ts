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
  /**
   * Samples render in batches, each ending in a fence. The batch size adapts (1 to `maxSamplesPerBatch`) so a
   * batch is done within ~`targetFrameMs` of being issued, queue wait included: that bounds how long a change
   * waits behind refinement. Two batches stay queued so the GPU never idles between them.
   */
  maxSamplesPerBatch: 16,
  refineBatchesInFlight: 2,
  targetFrameMs: 33,
  /** Frames without optical change before INTERACTIVE switches to REFINING. */
  stillFrames: 2,
  /** Per-sample residual blur against dotted bokeh (§10.3). */
  residualBlur: true,
  /** Radius = k·|b_px|/√target. Larger k smooths bokeh texture but makes discs lumpy. */
  residualBlurK: 0.45,
  residualBlurMaxPx: 8,

  /** While refining, after the crossfade, show progress at most this often; presents compete with sampling. */
  refinePresentIntervalMs: 100,

  /**
   * Interactive resolution scaling (§10.2), see DynamicResolution.ts. Scales multiply the internal resolution
   * of the preview and the eye view only; refinement always renders at full resolution.
   */
  dynamicResolution: {
    enabled: true,
    scales: [1, 0.85, 0.7, 0.6, 0.5],
    /** Measurement window: at least this long and this many frames. */
    windowMs: 500,
    minFrames: 8,
    /** Frames left out of the measurement after a change (the first one reallocates render targets). */
    skipFrames: 2,
    downFps: 45,
    upFps: 57,
    /**
     * A longer gap between interactive frames is a hiccup (a background tab, a GC), not frame cost. Pauses in
     * the interaction don't need it: a frame without a change already ends the run of measured frames.
     */
    maxIntervalMs: 1000,
    /** Main-thread time above this share of the frame means the CPU is the limit; a smaller image won't help. */
    cpuBoundFraction: 0.7,
    /** A step down must raise fps by this factor, or it's undone and the scale held for `floorHoldMs`. */
    minGain: 1.08,
    floorHoldMs: 10000,
    /** Time at `upFps` before stepping up; doubles (to the max) each time a step up has to be undone. */
    upHoldMs: 1500,
    maxUpHoldMs: 24000,
    /** A step down this soon after a step up undoes it. */
    stepUpTrialMs: 2500,
  },

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
