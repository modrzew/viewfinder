import { HalfFloatType, PerspectiveCamera, RGBAFormat, Vector3, WebGLRenderTarget, type Object3D, type WebGLRenderer } from 'three';
import type { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from '../config';
import { apertureSamples, gatherKernel, makeApertureShape } from '../optics/aperture';
import type { DerivedOptics } from '../optics/types';
import type { DebugInfo, RenderMode } from '../state/store';
import type { Pose } from './FpsController';
import { applyThinLensSample, type ThinLens } from './jitteredProjection';
import type { Rect } from './layout';
import { Accumulator } from './passes/Accumulator';
import { GatherDofPass } from './passes/GatherDofPass';
import { LensPass } from './passes/LensPass';
import type { BlurParams } from './shaders/common';

const RAD = Math.PI / 180;

export type Passes = DebugInfo['passes'];

/**
 * One lens's view on screen: the whole frame in camera view, or one of the finders side by side. It owns
 * the buffers and the INTERACTIVE → REFINING → DONE state of that view (§10.1); the Viewer owns the scene
 * render targets, schedules the work and draws the result.
 */
export class Finder {
  /** The lens it shows. Camera view's finder follows the selection; a lens change resets it like any other. */
  lensId: string;
  readonly refineTarget: number;
  /** The centred camera; thin-lens samples move it and shear its frustum, then restore it. */
  readonly camera = new PerspectiveCamera();
  mode: RenderMode = 'INTERACTIVE';
  /** Where it's drawn on the canvas, buffer px from the top left; its buffers are this size. */
  rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  optics: DerivedOptics | null = null;
  /** What it shows changed: LensPass has to run again and the screen be redrawn. */
  dirty = false;

  readonly previewRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
  private readonly accumulator: Accumulator;
  private readonly gather = new GatherDofPass();
  private readonly lensPass = new LensPass();
  private readonly basePosition = new Vector3();

  private stillFrames = 0;
  private fadeStart: number | null = null;
  /** Crossfade from the preview to the accumulation (§10.1), and the sample count it was presented at. */
  private mix = 0;
  private presentedCount = 0;
  private opticalKey: unknown[] = [];
  private exposureKey: unknown[] = [];

  /** Aperture samples and gather kernel for the current blade shape (§10.5). */
  private apertureKey = '';
  private aperture: Float32Array = new Float32Array(0);

  constructor(lensId: string, refineTarget: number, float32: boolean) {
    this.lensId = lensId;
    this.refineTarget = refineTarget;
    this.accumulator = new Accumulator(float32);
  }

  get samples(): number {
    return this.accumulator.count;
  }

  get needsSamples(): boolean {
    return this.mode === 'REFINING' && this.accumulator.count < this.refineTarget;
  }

  /** Places it on the canvas, resizing its buffers if needed. Returns true if anything moved. */
  setRect(r: Rect): boolean {
    const same = r.x === this.rect.x && r.y === this.rect.y && r.width === this.rect.width && r.height === this.rect.height;
    if (same) return false;
    if (r.width !== this.rect.width || r.height !== this.rect.height) {
      this.previewRT.setSize(r.width, r.height);
      this.accumulator.setSize(r.width, r.height);
      this.gather.setSize(r.width, r.height);
      this.lensPass.setSize(r.width, r.height);
    }
    this.rect = r;
    return true;
  }

  /**
   * Takes this frame's pose and optics and poses the centred camera. An optical change (pose, lens, focal
   * length, effective f-number, focus, size) resets to INTERACTIVE and returns true; an exposure-only change
   * just marks it dirty (§10.1).
   */
  sync(p: Pose, o: DerivedOptics, passes: Passes, baseExposure: number): boolean {
    this.optics = o;
    const cam = this.camera;
    cam.position.set(p.x, p.eyeHeight, p.z);
    cam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    cam.near = CONFIG.nearM;
    cam.far = CONFIG.farM;
    cam.fov = o.vfovDeg;
    cam.aspect = o.imageAspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.basePosition.copy(cam.position);

    const key = [p.x, p.z, p.eyeHeight, p.yaw, p.pitch, o.lens.id, o.focalMm, o.fNumber, o.focusM,
      this.rect.width, this.rect.height, passes.gather, passes.refine, passes.residual];
    const changed = !sameKey(key, this.opticalKey);
    this.opticalKey = key;
    const exposureKey = [o.exposureFactor, o.vignetteEv, passes.vignette, baseExposure];
    if (!sameKey(exposureKey, this.exposureKey)) this.dirty = true;
    this.exposureKey = exposureKey;
    if (changed) {
      this.mode = 'INTERACTIVE';
      this.stillFrames = 0;
      this.fadeStart = null;
      this.mix = 0;
      this.presentedCount = 0;
      this.accumulator.reset();
      this.dirty = true;
    }
    return changed;
  }

  /** Forces an optical reset at the next sync. */
  invalidate(): void {
    this.opticalKey = [];
  }

  /** Gather DoF from a scene render or crop of this view at this finder's size (§10.4). */
  gatherPreview(renderer: WebGLRenderer, scene: WebGLRenderTarget): void {
    this.updateApertureShape();
    this.gather.render(renderer, scene.texture, scene.depthTexture!, this.previewRT, this.blurParams(), CONFIG.gatherMaxRadiusPx);
  }

  /** INTERACTIVE → REFINING (or DONE without refinement) after a few frames without an optical change. */
  settle(refine: boolean): void {
    if (this.mode === 'INTERACTIVE' && ++this.stillFrames >= CONFIG.stillFrames) this.mode = refine ? 'REFINING' : 'DONE';
  }

  /**
   * Renders the next thin-lens sample into `scene`, at this finder's size, and adds it to the accumulation
   * (§10.3). Call restoreCamera() after the batch.
   */
  renderSample(renderer: WebGLRenderer, root: Object3D, scene: WebGLRenderTarget, jitter: Float32Array, residual: boolean): void {
    this.updateApertureShape();
    const o = this.optics!;
    const lens: ThinLens = {
      focalM: o.focalMm / 1000,
      apertureM: o.apertureMm / 1000,
      focusM: o.focusM,
      tanHalfH: Math.tan((o.hfovDeg / 2) * RAD),
      tanHalfV: Math.tan((o.vfovDeg / 2) * RAD),
      near: CONFIG.nearM,
      far: CONFIG.farM,
      widthPx: this.rect.width,
      heightPx: this.rect.height,
    };
    const s = this.accumulator.count % CONFIG.apertureSampleCount;
    applyThinLensSample(this.camera, this.basePosition, lens,
      this.aperture[s * 2], this.aperture[s * 2 + 1], jitter[s * 2], jitter[s * 2 + 1]);
    renderer.setRenderTarget(scene);
    renderer.render(root, this.camera);
    const residualScale = residual ? CONFIG.residualBlurK / Math.sqrt(this.refineTarget) : 0;
    this.accumulator.add(renderer, scene.texture, scene.depthTexture!, this.blurParams(), residualScale, CONFIG.residualBlurMaxPx);
  }

  restoreCamera(): void {
    this.camera.position.copy(this.basePosition);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Shows the preview until enough samples are in, then crossfades to the accumulation, then DONE. */
  fade(now: number): void {
    if (this.mode !== 'REFINING') return;
    const n = this.accumulator.count;
    if (n < CONFIG.previewUntilSamples) return;
    this.fadeStart ??= now;
    const t = Math.min((now - this.fadeStart) / CONFIG.crossfadeMs, 1);
    // Present only when the image changed, so presents don't compete with sampling.
    if (t !== this.mix || n !== this.presentedCount) {
      this.mix = t;
      this.presentedCount = n;
      this.dirty = true;
    }
    if (t >= 1 && n >= this.refineTarget) this.mode = 'DONE';
  }

  /** Exposure and vignetting on what it shows (§10.6). */
  present(renderer: WebGLRenderer, baseExposure: number, vignette: boolean): void {
    const o = this.optics!;
    const refined = this.presentedCount >= CONFIG.previewUntilSamples ? this.accumulator.texture : null;
    this.lensPass.render(renderer, this.previewRT.texture, refined, {
      mix: this.mix,
      exposure: baseExposure * o.exposureFactor,
      vignetteEv: vignette ? o.vignetteEv : 0,
    });
    this.dirty = false;
  }

  /** Tone maps it onto the canvas at its rectangle. The caller restores the viewport and scissor. */
  draw(renderer: WebGLRenderer, output: OutputPass, canvasHeight: number): void {
    const r = this.rect;
    // GL's origin is the bottom left. OutputPass clears before drawing, so the scissor keeps that inside too.
    const y = canvasHeight - r.y - r.height;
    renderer.setViewport(r.x, y, r.width, r.height);
    renderer.setScissor(r.x, y, r.width, r.height);
    renderer.setScissorTest(true);
    output.render(renderer, null as never, this.lensPass.target, 0, false);
  }

  dispose(): void {
    this.previewRT.dispose();
    this.accumulator.dispose();
    this.gather.dispose();
    this.lensPass.dispose();
  }

  private blurParams(): BlurParams {
    const o = this.optics!;
    return {
      focalMm: o.focalMm,
      apertureMm: o.apertureMm,
      focusM: o.focusM,
      sensorWidthMm: o.sensorWidthMm,
      renderWidthPx: this.rect.width,
      near: CONFIG.nearM,
      far: CONFIG.farM,
    };
  }

  /** Regenerates aperture samples and the gather kernel when the blade shape changes (§10.5). */
  private updateApertureShape(): void {
    const o = this.optics!;
    const key = `${o.blades}:${o.roundness}`;
    if (key === this.apertureKey) return;
    this.apertureKey = key;
    const shape = makeApertureShape(o.blades, o.roundness);
    this.aperture = apertureSamples(shape, CONFIG.apertureSampleCount);
    this.gather.setKernel(gatherKernel(shape, CONFIG.gatherKernelSize), shape.areaScale);
  }
}

export function sameKey(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
