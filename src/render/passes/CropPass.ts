import { AlwaysDepth, NoBlending, ShaderMaterial, Vector2, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERT, SCENE_COLOR_GLSL } from '../shaders/common';

// Side by side (§10.9): a lens's pinhole view is the centred crop of the eye view from the same pose, and
// both share near and far planes, so a crop of the eye render's colour and depth stands in for a scene render
// of the lens. Colour is bilinear; depth is the nearest texel, written as the target's depth.

const FRAG = /* glsl */ `
${SCENE_COLOR_GLSL}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uScale;    // crop half extents as fractions of the source's
varying vec2 vUv;

void main() {
  vec2 uv = 0.5 + (vUv - 0.5) * uScale;
  gl_FragColor = vec4(sceneColor(tColor, uv), 1.0);
  gl_FragDepth = texture2D(tDepth, uv).r;
}
`;

export class CropPass {
  private readonly material = new ShaderMaterial({
    uniforms: { tColor: { value: null }, tDepth: { value: null }, uScale: { value: new Vector2(1, 1) } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: FRAG,
    blending: NoBlending,
    // Depth writes need the depth test on; Always lets every fragment through.
    depthTest: true,
    depthFunc: AlwaysDepth,
    depthWrite: true,
  });
  private readonly quad = new FullScreenQuad(this.material);

  /** For precompiling. */
  get materials(): ShaderMaterial[] {
    return [this.material];
  }

  /** Copies the centred crop with half extents `scaleX`, `scaleY` of `source` into `target`, filling it. */
  render(renderer: WebGLRenderer, source: WebGLRenderTarget, target: WebGLRenderTarget, scaleX: number, scaleY: number): void {
    const u = this.material.uniforms;
    u.tColor.value = source.texture;
    u.tDepth.value = source.depthTexture;
    (u.uScale.value as Vector2).set(scaleX, scaleY);
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
