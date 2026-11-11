import { HalfFloatType, NoBlending, RGBAFormat, ShaderMaterial, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERT } from '../shaders/common';

// Linear-light lens and exposure stage before OutputPass. Also crossfades preview → refined.

const FRAG = /* glsl */ `
uniform sampler2D tPreview;
uniform sampler2D tRefined;
uniform float uMix;
varying vec2 vUv;

void main() {
  vec3 c = uMix <= 0.0 ? texture2D(tPreview, vUv).rgb
    : uMix >= 1.0 ? texture2D(tRefined, vUv).rgb
    : mix(texture2D(tPreview, vUv).rgb, texture2D(tRefined, vUv).rgb, uMix);
  gl_FragColor = vec4(c, 1.0);
}
`;

export interface LensParams {
  mix: number;
}

export class LensPass {
  readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
  private readonly material = new ShaderMaterial({
    uniforms: {
      tPreview: { value: null },
      tRefined: { value: null },
      uMix: { value: 0 },
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
  }

  render(renderer: WebGLRenderer, preview: Texture, refined: Texture | null, p: LensParams): void {
    const u = this.material.uniforms;
    u.tPreview.value = preview;
    u.tRefined.value = refined ?? preview;
    u.uMix.value = refined ? p.mix : 0;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
