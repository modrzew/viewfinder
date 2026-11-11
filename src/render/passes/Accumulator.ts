import { FloatType, HalfFloatType, NoBlending, RGBAFormat, ShaderMaterial, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BLUR_GLSL, FULLSCREEN_VERT, blurUniforms, setBlurUniforms, type BlurParams } from '../shaders/common';

// Running mean of jittered thin-lens samples (§10.2, §10.3), with an optional per-sample residual
// blur so sparse samples don't show as dotted bokeh on point lights.

const FRAG = /* glsl */ `
${BLUR_GLSL}
uniform sampler2D tSample;
uniform sampler2D tDepth;
uniform sampler2D tPrev;
uniform float uWeight;          // 1 / n
uniform float uResidualScale;   // 0.45 / sqrt(target), or 0 when disabled
uniform float uResidualMax;     // px
uniform float uRotation;        // per-sample kernel rotation, so tap patterns average out
uniform vec2 uTexel;
varying vec2 vUv;

const int TAPS = 16;
const float GOLDEN_ANGLE = 2.39996323;

float residualRadius(vec2 uv) {
  float dMm = planarDepthM(texture2D(tDepth, uv).r) * 1000.0;
  return min(abs(blurDiscPx(dMm)) * uResidualScale, uResidualMax);
}

void main() {
  vec3 x = texture2D(tSample, vUv).rgb;
  if (uResidualScale > 0.0) {
    float rc = residualRadius(vUv);
    if (rc > 0.5) {
      vec3 sum = x;
      float wsum = 1.0;
      for (int i = 0; i < TAPS; i++) {
        float t = (float(i) + 0.5) / float(TAPS);
        float a = float(i) * GOLDEN_ANGLE + uRotation;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(t) * rc;
        vec2 uv = vUv + o * uTexel;
        // A tap counts only if its own residual disc reaches this pixel.
        float w = smoothstep(-0.5, 0.5, residualRadius(uv) - length(o));
        sum += texture2D(tSample, uv).rgb * w;
        wsum += w;
      }
      x = sum / wsum;
    }
  }
  if (uWeight >= 1.0) {
    gl_FragColor = vec4(x, 1.0);
  } else {
    vec3 prev = texture2D(tPrev, vUv).rgb;
    gl_FragColor = vec4(prev + (x - prev) * uWeight, 1.0);
  }
}
`;

export class Accumulator {
  count = 0;
  private targets: [WebGLRenderTarget, WebGLRenderTarget];
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(float32: boolean) {
    const make = () =>
      new WebGLRenderTarget(1, 1, { type: float32 ? FloatType : HalfFloatType, format: RGBAFormat, depthBuffer: false });
    this.targets = [make(), make()];
    this.material = new ShaderMaterial({
      uniforms: {
        ...blurUniforms(),
        tSample: { value: null },
        tDepth: { value: null },
        tPrev: { value: null },
        uWeight: { value: 1 },
        uResidualScale: { value: 0 },
        uResidualMax: { value: 8 },
        uRotation: { value: 0 },
        uTexel: { value: [1, 1] },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get texture(): Texture {
    return this.targets[0].texture;
  }

  setSize(w: number, h: number): void {
    for (const t of this.targets) t.setSize(w, h);
    this.material.uniforms.uTexel.value = [1 / w, 1 / h];
    this.count = 0;
  }

  reset(): void {
    this.count = 0;
  }

  /** Adds one sample. `residualScale` = 0.45/√target (0 disables the residual blur). */
  add(renderer: WebGLRenderer, sample: Texture, depth: Texture, blur: BlurParams, residualScale: number, residualMax: number): void {
    this.count++;
    const u = this.material.uniforms;
    setBlurUniforms(u as never, blur);
    u.tSample.value = sample;
    u.tDepth.value = depth;
    u.tPrev.value = this.targets[0].texture;
    u.uWeight.value = 1 / this.count;
    u.uResidualScale.value = residualScale;
    u.uResidualMax.value = residualMax;
    u.uRotation.value = (this.count * 0.618033988749895 % 1) * Math.PI * 2;
    renderer.setRenderTarget(this.targets[1]);
    this.quad.render(renderer);
    this.targets.reverse();
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
