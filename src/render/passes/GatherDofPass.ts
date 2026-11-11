import { HalfFloatType, LinearFilter, NoBlending, RGBAFormat, ShaderMaterial, Vector2, Vector4, WebGLRenderTarget, type Texture, type WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CONFIG } from '../../config';
import { BLUR_GLSL, FULLSCREEN_VERT, blurUniforms, setBlurUniforms, type BlurParams } from '../shaders/common';

// Interactive DoF preview, after Gustafsson's single-pass bokeh (2018); SPEC §10.4.
//   1. CoC (half res): colour + signed CoC radius in full-res px.
//   2. Tile max (1/16 res) + dilate: the largest CoC that can reach each tile, so the kernel is sized per
//      pixel and small blur is sampled as densely as large blur.
//   3. Gather (half res): aperture-shaped kernel; a sample counts if its own bokeh covers this pixel.
//   4. Fill (half res): a small blur, about half the tap spacing, that closes the gaps 64 taps leave
//      around small bright sources (as in Jimenez 2014).
//   5. Composite (full res): sharp colour → blurred colour by smoothstep(0.5, 1.5, |CoC|).

export const KERNEL_SIZE = CONFIG.gatherKernelSize;

const COC_FRAG = /* glsl */ `
${BLUR_GLSL}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uFullTexel;
uniform float uMaxRadius;   // full-res px
varying vec2 vUv;

void main() {
  // Bilinear at the 2×2 block centre averages the four colours; depth takes the nearest of the four.
  vec3 c = texture2D(tColor, vUv).rgb;
  vec2 h = 0.5 * uFullTexel;
  float d = min(min(texture2D(tDepth, vUv + vec2(-h.x, -h.y)).r, texture2D(tDepth, vUv + vec2(h.x, -h.y)).r),
                min(texture2D(tDepth, vUv + vec2(-h.x, h.y)).r, texture2D(tDepth, vUv + vec2(h.x, h.y)).r));
  float coc = 0.5 * blurDiscPx(planarDepthM(d) * 1000.0);
  gl_FragColor = vec4(c, clamp(coc, -uMaxRadius, uMaxRadius));
}
`;

/** Tile edge in full-res px. */
const TILE = 16;

const TILE_FRAG = /* glsl */ `
uniform sampler2D tCoc;
uniform vec2 uHalfTexel;
varying vec2 vUv;

void main() {
  // vUv is the tile centre; the tile covers ${TILE / 2}×${TILE / 2} half-res texels.
  float m = 0.0;
  for (int y = 0; y < ${TILE / 2}; y++) {
    for (int x = 0; x < ${TILE / 2}; x++) {
      vec2 o = (vec2(float(x), float(y)) - ${((TILE / 2 - 1) / 2).toFixed(1)}) * uHalfTexel;
      m = max(m, abs(texture2D(tCoc, vUv + o).a));
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

const DILATE_FRAG = /* glsl */ `
uniform sampler2D tTiles;
uniform vec2 uTileTexel;
uniform int uReach;          // tiles
varying vec2 vUv;

void main() {
  float m = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      if (abs(x) > uReach || abs(y) > uReach) continue;
      m = max(m, texture2D(tTiles, vUv + vec2(float(x), float(y)) * uTileTexel).r);
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

const GATHER_FRAG = /* glsl */ `
uniform sampler2D tCoc;
uniform vec2 uHalfTexel;
uniform vec4 uKernel[${KERNEL_SIZE}];   // xy: offset in the circumradius-1 shape; z/w: far/near shape distance
uniform sampler2D tTileMax;            // largest CoC radius that reaches this tile, full-res px
uniform float uAreaScale;
varying vec2 vUv;

void main() {
  vec4 centre = texture2D(tCoc, vUv);
  float centreCoc = centre.a;
  float centreR = abs(centreCoc);
  vec3 color = centre.rgb;
  float tot = 1.0;
  float nearCover = 0.0;
  float kernelR = texture2D(tTileMax, vUv).r;
  if (kernelR < 0.5) { gl_FragColor = vec4(color, 0.0); return; }
  // Kernel extent in half-res px: the bokeh shape's circumradius at the largest CoC.
  float k = 0.5 * kernelR * uAreaScale;
  for (int i = 0; i < ${KERNEL_SIZE}; i++) {
    vec4 o = uKernel[i];
    vec4 s = texture2D(tCoc, vUv + o.xy * k * uHalfTexel);
    float r = abs(s.a);
    // Stop the background bleeding over an in-focus foreground.
    if (s.a > centreCoc) r = min(r, 2.0 * centreR);
    float dist = (s.a >= 0.0 ? o.z : o.w) * k;
    float m = smoothstep(dist - 0.5, dist + 0.5, uAreaScale * 0.5 * r);
    color += mix(color / tot, s.rgb, m);
    tot += 1.0;
    if (s.a < centreCoc) nearCover = max(nearCover, m * r);
  }
  // Alpha: how far a blurred foreground reaches over this pixel, for the composite.
  gl_FragColor = vec4(color / tot, nearCover);
}
`;

const FILL_FRAG = /* glsl */ `
uniform sampler2D tBlur;
uniform sampler2D tCoc;
uniform sampler2D tTileMax;
uniform vec2 uHalfTexel;
uniform float uSpacing;      // tap spacing per full-res px of kernel radius, in half-res px
varying vec2 vUv;

const int TAPS = 12;
const float GOLDEN_ANGLE = 2.39996323;

float blurRadius(vec2 uv) {
  return max(abs(texture2D(tCoc, uv).a), texture2D(tBlur, uv).a);
}

void main() {
  vec4 centre = texture2D(tBlur, vUv);
  float rc = blurRadius(vUv);
  float rf = min(0.6 * uSpacing * texture2D(tTileMax, vUv).r, 0.25 * rc);
  if (rf < 0.5) { gl_FragColor = centre; return; }
  vec3 sum = centre.rgb;
  float wsum = 1.0;
  for (int i = 0; i < TAPS; i++) {
    float a = float(i) * GOLDEN_ANGLE;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / float(TAPS)) * rf * uHalfTexel;
    // Only mix with neighbours that are blurred about as much (keeps in-focus edges intact).
    float w = smoothstep(0.5, 1.0, blurRadius(uv) / rc);
    sum += texture2D(tBlur, uv).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, centre.a);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${BLUR_GLSL}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tBlur;
uniform float uMaxRadius;
varying vec2 vUv;

void main() {
  vec3 sharp = texture2D(tColor, vUv).rgb;
  vec4 blur = texture2D(tBlur, vUv);
  float coc = min(abs(0.5 * blurDiscPx(planarDepthM(texture2D(tDepth, vUv).r) * 1000.0)), uMaxRadius);
  float t = smoothstep(0.5, 1.5, max(coc, blur.a));
  gl_FragColor = vec4(mix(sharp, blur.rgb, t), 1.0);
}
`;

function material(fragmentShader: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

export class GatherDofPass {
  private readonly cocRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private readonly blurRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private readonly tileRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
  private readonly tileMaxRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private readonly fillRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private readonly cocMat = material(COC_FRAG, { ...blurUniforms(), tColor: { value: null }, tDepth: { value: null }, uFullTexel: { value: new Vector2() }, uMaxRadius: { value: 48 } });
  private readonly tileMat = material(TILE_FRAG, { tCoc: { value: null }, uHalfTexel: { value: new Vector2() } });
  private readonly dilateMat = material(DILATE_FRAG, { tTiles: { value: null }, uTileTexel: { value: new Vector2() }, uReach: { value: 3 } });
  private readonly gatherMat = material(GATHER_FRAG, {
    tCoc: { value: null },
    tTileMax: { value: null },
    uHalfTexel: { value: new Vector2() },
    uKernel: { value: Array.from({ length: KERNEL_SIZE }, () => new Vector4()) },
    uAreaScale: { value: 1 },
  });
  private readonly fillMat = material(FILL_FRAG, { tBlur: { value: null }, tCoc: { value: null }, tTileMax: { value: null }, uHalfTexel: { value: new Vector2() }, uSpacing: { value: 1 } });
  private readonly compositeMat = material(COMPOSITE_FRAG, { ...blurUniforms(), tColor: { value: null }, tDepth: { value: null }, tBlur: { value: null }, uMaxRadius: { value: 48 } });
  private readonly quad = new FullScreenQuad();

  setSize(w: number, h: number): void {
    const hw = Math.ceil(w / 2);
    const hh = Math.ceil(h / 2);
    this.cocRT.setSize(hw, hh);
    this.blurRT.setSize(hw, hh);
    this.fillRT.setSize(hw, hh);
    const tw = Math.ceil(w / TILE);
    const th = Math.ceil(h / TILE);
    this.tileRT.setSize(tw, th);
    this.tileMaxRT.setSize(tw, th);
    (this.tileMat.uniforms.uHalfTexel.value as Vector2).set(1 / hw, 1 / hh);
    (this.dilateMat.uniforms.uTileTexel.value as Vector2).set(1 / tw, 1 / th);
    (this.cocMat.uniforms.uFullTexel.value as Vector2).set(1 / w, 1 / h);
    (this.gatherMat.uniforms.uHalfTexel.value as Vector2).set(1 / hw, 1 / hh);
    (this.fillMat.uniforms.uHalfTexel.value as Vector2).set(1 / hw, 1 / hh);
  }

  /** `kernel` is gatherKernel() output; `areaScale` is the aperture shape's equal-area factor. */
  setKernel(kernel: Float32Array, areaScale: number): void {
    const k = this.gatherMat.uniforms.uKernel.value as Vector4[];
    for (let i = 0; i < KERNEL_SIZE; i++) k[i].fromArray(kernel, i * 4);
    this.gatherMat.uniforms.uAreaScale.value = areaScale;
  }

  /** Renders the preview into `target`. `maxRadiusPx` (full res) clamps all CoC radii (§10.4). */
  render(renderer: WebGLRenderer, color: Texture, depth: Texture, target: WebGLRenderTarget, blur: BlurParams,
    maxRadiusPx: number): void {
    setBlurUniforms(this.cocMat.uniforms as never, blur);
    setBlurUniforms(this.compositeMat.uniforms as never, blur);
    this.cocMat.uniforms.tColor.value = color;
    this.cocMat.uniforms.tDepth.value = depth;
    this.cocMat.uniforms.uMaxRadius.value = maxRadiusPx;
    this.quad.material = this.cocMat;
    renderer.setRenderTarget(this.cocRT);
    this.quad.render(renderer);

    this.tileMat.uniforms.tCoc.value = this.cocRT.texture;
    this.quad.material = this.tileMat;
    renderer.setRenderTarget(this.tileRT);
    this.quad.render(renderer);
    this.dilateMat.uniforms.tTiles.value = this.tileRT.texture;
    this.dilateMat.uniforms.uReach.value = Math.min(3, Math.ceil(maxRadiusPx / TILE));
    this.quad.material = this.dilateMat;
    renderer.setRenderTarget(this.tileMaxRT);
    this.quad.render(renderer);

    this.gatherMat.uniforms.tCoc.value = this.cocRT.texture;
    this.gatherMat.uniforms.tTileMax.value = this.tileMaxRT.texture;
    this.quad.material = this.gatherMat;
    renderer.setRenderTarget(this.blurRT);
    this.quad.render(renderer);

    // Mean spacing of the kernel's taps per full-res px of kernel radius, in half-res px.
    const areaScale = this.gatherMat.uniforms.uAreaScale.value as number;
    this.fillMat.uniforms.uSpacing.value = 0.5 * areaScale * Math.sqrt(Math.PI / KERNEL_SIZE);
    this.fillMat.uniforms.tBlur.value = this.blurRT.texture;
    this.fillMat.uniforms.tCoc.value = this.cocRT.texture;
    this.fillMat.uniforms.tTileMax.value = this.tileMaxRT.texture;
    this.quad.material = this.fillMat;
    renderer.setRenderTarget(this.fillRT);
    this.quad.render(renderer);

    const c = this.compositeMat.uniforms;
    c.tColor.value = color;
    c.tDepth.value = depth;
    c.tBlur.value = this.fillRT.texture;
    c.uMaxRadius.value = maxRadiusPx;
    this.quad.material = this.compositeMat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.cocRT.dispose();
    this.blurRT.dispose();
    this.fillRT.dispose();
    this.tileRT.dispose();
    this.tileMaxRT.dispose();
    this.tileMat.dispose();
    this.dilateMat.dispose();
    this.cocMat.dispose();
    this.gatherMat.dispose();
    this.fillMat.dispose();
    this.compositeMat.dispose();
    this.quad.dispose();
  }
}
