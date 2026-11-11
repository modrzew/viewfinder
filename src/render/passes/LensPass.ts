import { HalfFloatType, NoBlending, RGBAFormat, ShaderMaterial, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERT } from '../shaders/common';

// Linear-light lens and exposure stage before OutputPass (§10.6): crossfades preview → refined,
// then applies exposure × vignetting.

const FRAG = /* glsl */ `
uniform sampler2D tPreview;
uniform sampler2D tRefined;
uniform float uMix;
uniform float uExposure;
uniform float uVignetteEv;   // corner falloff; 0 disables
uniform float uAspect;
varying vec2 vUv;

void main() {
  vec3 c = uMix <= 0.0 ? texture2D(tPreview, vUv).rgb
    : uMix >= 1.0 ? texture2D(tRefined, vUv).rgb
    : mix(texture2D(tPreview, vUv).rgb, texture2D(tRefined, vUv).rgb, uMix);
  // ρ: distance from the frame centre, 1 at the corners.
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float rho2 = dot(p, p) / (0.25 * (uAspect * uAspect + 1.0));
  gl_FragColor = vec4(c * uExposure * exp2(-uVignetteEv * rho2), 1.0);
}
`;

export interface LensParams {
  mix: number;
  exposure: number;
  vignetteEv: number;
}

export class LensPass {
  readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
  private readonly material = new ShaderMaterial({
    uniforms: {
      tPreview: { value: null },
      tRefined: { value: null },
      uMix: { value: 0 },
      uExposure: { value: 1 },
      uVignetteEv: { value: 0 },
      uAspect: { value: 1.5 },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: FRAG,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  private readonly quad = new FullScreenQuad(this.material);

  setSize(w: number, h: number): void {
    this.target.setSize(w, h);
    this.material.uniforms.uAspect.value = w / h;
  }

  render(renderer: WebGLRenderer, preview: Texture, refined: Texture | null, p: LensParams): void {
    const u = this.material.uniforms;
    u.tPreview.value = preview;
    u.tRefined.value = refined ?? preview;
    u.uMix.value = refined ? p.mix : 0;
    u.uExposure.value = p.exposure;
    u.uVignetteEv.value = p.vignetteEv;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
