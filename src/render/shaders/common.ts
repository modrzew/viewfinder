// GLSL shared by the DoF passes. `blurDiscPx` mirrors optics.ts blurDiscMm / blurDiscPx (§8.4).

export const BLUR_GLSL = /* glsl */ `
uniform float uFocalMm;
uniform float uApertureMm;
uniform float uInvFocusMm;     // 1 / s, 0 when focused at infinity
uniform float uSensorWidthMm;
uniform float uRenderWidthPx;
uniform float uNear;
uniform float uFar;

// Signed blur-disc diameter on the sensor: b = A·f/(s − f) · (d − s)/d, written with 1/s so s = ∞ works.
float blurDiscMm(float dMm) {
  return uApertureMm * uFocalMm * (dMm * uInvFocusMm - 1.0) / ((1.0 - uFocalMm * uInvFocusMm) * dMm);
}

float blurDiscPx(float dMm) {
  return blurDiscMm(dMm) / uSensorWidthMm * uRenderWidthPx;
}

// Planar depth in metres from a [0, 1] perspective depth-buffer value.
float planarDepthM(float depth) {
  return (uNear * uFar) / (uFar - (uFar - uNear) * depth);
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Uniform values for BLUR_GLSL. */
export interface BlurParams {
  focalMm: number;
  apertureMm: number;
  focusM: number;
  sensorWidthMm: number;
  renderWidthPx: number;
  near: number;
  far: number;
}

export function blurUniforms() {
  return {
    uFocalMm: { value: 50 },
    uApertureMm: { value: 1 },
    uInvFocusMm: { value: 0 },
    uSensorWidthMm: { value: 22.3 },
    uRenderWidthPx: { value: 1 },
    uNear: { value: 0.03 },
    uFar: { value: 2000 },
  };
}

export function setBlurUniforms(u: ReturnType<typeof blurUniforms>, p: BlurParams): void {
  u.uFocalMm.value = p.focalMm;
  u.uApertureMm.value = p.apertureMm;
  u.uInvFocusMm.value = Number.isFinite(p.focusM) ? 1 / (p.focusM * 1000) : 0;
  u.uSensorWidthMm.value = p.sensorWidthMm;
  u.uRenderWidthPx.value = p.renderWidthPx;
  u.uNear.value = p.near;
  u.uFar.value = p.far;
}
