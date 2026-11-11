import {
  AgXToneMapping, DepthTexture, FloatType, HalfFloatType, NoBlending, PerspectiveCamera, RGBAFormat, ShaderMaterial,
  Vector3, WebGLRenderer, WebGLRenderTarget, type Texture,
} from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CONFIG } from '../config';
import { apertureSamples, gatherKernel, makeApertureShape, pixelJitter } from '../optics/aperture';
import { getBody } from '../optics/bodies';
import { getLens } from '../optics/lenses';
import { deriveOptics } from '../optics/optics';
import type { DerivedOptics } from '../optics/types';
import { useStore, type RenderMode, type Settings } from '../state/store';
import type { SceneSetup } from '../scene/types';
import { FpsController } from './FpsController';
import { applyThinLensSample, type ThinLens } from './jitteredProjection';
import { eyeVfovDeg, frameRect, renderSize, type Rect } from './layout';
import { Accumulator } from './passes/Accumulator';
import { GatherDofPass } from './passes/GatherDofPass';
import { LensPass } from './passes/LensPass';
import { Rangefinder } from './Rangefinder';
import { FULLSCREEN_VERT, type BlurParams } from './shaders/common';

const RAD = Math.PI / 180;

export interface ViewerOptions {
  loadScene: () => Promise<SceneSetup>;
}

/**
 * Drives Three.js imperatively; React only renders the UI (§5, §6).
 * Camera view runs INTERACTIVE → REFINING → DONE (§10.1); eye view is a plain render.
 */
export class Viewer {
  private readonly container: HTMLElement;
  private readonly canvas = document.createElement('canvas');
  private readonly renderer: WebGLRenderer;
  private readonly camera = new PerspectiveCamera();
  private readonly eyeCamera = new PerspectiveCamera();
  private readonly basePosition = new Vector3();
  private readonly controller: FpsController;

  private sceneRT: WebGLRenderTarget;
  private readonly previewRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
  private readonly accumulator: Accumulator;
  private readonly gather = new GatherDofPass();
  private readonly lensPass = new LensPass();
  private readonly output = new OutputPass();
  private readonly copyMaterial = new ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }',
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  private readonly copyQuad = new FullScreenQuad(this.copyMaterial);

  private setup: SceneSetup | null = null;
  private rangefinder: Rangefinder | null = null;
  private disposed = false;
  private raf = 0;
  private lastTime = 0;
  private frameMs = 16;

  private mode: RenderMode = 'INTERACTIVE';
  private stillFrames = 0;
  private samplesPerFrame = 1;
  /** GPU fence after the last sample batch, and how many frames it has been pending. */
  private fence: WebGLSync | null = null;
  private fenceFrames = 0;
  private fadeStart: number | null = null;
  private presentedMix = -1;
  private presentedCount = -1;
  private opticalKey: unknown[] = [];
  private exposureKey: unknown[] = [];
  /** What's on screen, so an exposure-only change can re-run LensPass on it. */
  private shown: { preview: Texture; refined: Texture | null; mix: number } | null = null;
  private poseKey: number[] = [];
  private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private settings: Settings | null = null;
  private optics: DerivedOptics | null = null;

  private apertureKey = '';
  private aperture: Float32Array = new Float32Array(0);
  private readonly jitter = pixelJitter(CONFIG.apertureSampleCount);
  private readonly refineTarget = Math.min(Math.max(CONFIG.refineTarget, CONFIG.refineTargetRange[0]), CONFIG.refineTargetRange[1]);

  private lastRangeTime = 0;
  private rangePoseKey: number[] = [];
  private fpsFrames = 0;
  private fpsTime = 0;
  private wheelAccum = 0;

  constructor(container: HTMLElement, options: ViewerOptions) {
    this.container = container;
    this.canvas.className = 'viewer-canvas';
    container.appendChild(this.canvas);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = AgXToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;

    this.sceneRT = this.makeSceneTarget(1, 1);
    this.accumulator = new Accumulator(this.supportsFloat32Targets());
    this.output.renderToScreen = true;
    useStore.getState().setRuntime({ refine: { samples: 0, target: this.refineTarget } });

    this.controller = new FpsController(container);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.onLockChange);

    options.loadScene().then(
      (setup) => {
        if (this.disposed) return setup.dispose();
        this.setup = setup;
        this.controller.setWorld(setup.spawn, setup.colliders, setup.walkArea);
        this.rangefinder = new Rangefinder(setup.scene);
        this.renderer.shadowMap.needsUpdate = true;
        this.settings = null;
        this.invalidate();
      },
      (err: unknown) => useStore.getState().setRuntime({ error: String(err) }),
    );

    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.dropFence();
    this.controller.dispose();
    this.container.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.rangefinder?.dispose();
    this.setup?.dispose();
    this.sceneRT.dispose();
    this.previewRT.dispose();
    this.accumulator.dispose();
    this.gather.dispose();
    this.lensPass.dispose();
    this.output.dispose();
    this.copyMaterial.dispose();
    this.copyQuad.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  /** Debug hook (`?debug=1`): set the pose directly, angles in degrees. */
  setPose(p: { x?: number; z?: number; eyeHeight?: number; yawDeg?: number; pitchDeg?: number }): void {
    const pose = this.controller.pose;
    if (p.x !== undefined) pose.x = p.x;
    if (p.z !== undefined) pose.z = p.z;
    if (p.eyeHeight !== undefined) pose.eyeHeight = p.eyeHeight;
    if (p.yawDeg !== undefined) pose.yaw = p.yawDeg * RAD;
    if (p.pitchDeg !== undefined) pose.pitch = p.pitchDeg * RAD;
  }

  /** Forces an optical reset on the next frame. */
  invalidate(): void {
    this.opticalKey = [];
  }

  private supportsFloat32Targets(): boolean {
    const gl = this.renderer.getContext();
    return !!gl.getExtension('EXT_color_buffer_float');
  }

  private makeSceneTarget(w: number, h: number): WebGLRenderTarget {
    const rt = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: true });
    rt.depthTexture = new DepthTexture(w, h, FloatType);
    return rt;
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.1) : 0;
    this.frameMs = this.lastTime ? now - this.lastTime : 16;
    this.lastTime = now;
    this.trackFps(now);

    const state = useStore.getState();
    const { settings, runtime } = state;
    if (settings !== this.settings) {
      this.settings = settings;
      this.optics = deriveOptics(getBody(settings.bodyId), getLens(settings.lensId), settings, this.setup?.ev100);
    }
    const optics = this.optics!;
    const view = settings.view;

    this.layout(runtime.viewport.width, runtime.viewport.height, view, optics.imageAspect);
    if (!this.setup || this.rect.width <= 0) return;

    const activeVfov = view === 'eye' ? this.eyeCamera.fov : optics.vfovDeg;
    this.controller.update(dt, Math.tan((activeVfov / 2) * RAD) / Math.tan((CONFIG.lookReferenceVfovDeg / 2) * RAD));
    this.updateCameras(optics);

    const p = this.controller.pose;
    const passes = state.debug.passes;
    this.poseKey = [p.x, p.z, p.eyeHeight, p.yaw, p.pitch];
    const key = [...this.poseKey, optics.lens.id, optics.focalMm, optics.fNumber, optics.focusM, view,
      this.sceneRT.width, this.sceneRT.height, passes.gather, passes.refine, passes.residual];
    const changed = !sameKey(key, this.opticalKey);
    this.opticalKey = key;
    const exposureKey = [optics.exposureFactor, optics.vignetteEv, passes.vignette, this.setup.baseExposure];
    const exposureChanged = !sameKey(exposureKey, this.exposureKey);
    this.exposureKey = exposureKey;

    if (view === 'eye') this.renderEye(changed);
    else this.renderCamera(changed, now, optics, passes.refine);
    // Exposure-only change (§10.1): re-run LensPass on what's shown; the accumulation is kept.
    if (exposureChanged && !changed && this.shown) this.present(this.shown.preview, this.shown.refined, this.shown.mix);

    this.updateRangefinder(now);
    if (state.debug.mode !== this.mode || state.debug.samplesPerFrame !== this.samplesPerFrame) {
      state.setDebug({ mode: this.mode, samplesPerFrame: this.mode === 'REFINING' ? this.samplesPerFrame : 0 });
    }
  };

  private renderEye(changed: boolean): void {
    if (changed) {
      this.renderer.setRenderTarget(this.sceneRT);
      this.renderer.render(this.setup!.scene, this.eyeCamera);
      this.present(this.sceneRT.texture, null, 0);
    }
    this.mode = 'DONE';
    this.publishSamples(0);
  }

  private renderCamera(changed: boolean, now: number, optics: DerivedOptics, refineEnabled: boolean): void {
    if (changed) {
      this.mode = 'INTERACTIVE';
      this.stillFrames = 0;
      this.fadeStart = null;
      this.presentedMix = this.presentedCount = -1;
      this.dropFence();
      this.accumulator.reset();
      this.publishSamples(0);
      this.renderPreview(optics);
      this.present(this.previewRT.texture, null, 0);
      return;
    }

    if (this.mode === 'INTERACTIVE') {
      if (++this.stillFrames >= CONFIG.stillFrames) this.mode = refineEnabled ? 'REFINING' : 'DONE';
      return;
    }

    if (this.mode === 'REFINING') {
      const acc = this.accumulator;
      if (acc.count < this.refineTarget && this.batchDone()) {
        const n = Math.min(this.samplesPerFrame, this.refineTarget - acc.count);
        this.renderSamples(optics, n);
        this.publishSamples(acc.count);
        const gl = this.renderer.getContext() as WebGL2RenderingContext;
        this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      }
      if (acc.count >= CONFIG.previewUntilSamples) {
        this.fadeStart ??= now;
        const t = Math.min((now - this.fadeStart) / CONFIG.crossfadeMs, 1);
        // Present only when the image changed, so presents don't compete with sampling.
        if (t !== this.presentedMix || acc.count !== this.presentedCount) {
          this.present(this.previewRT.texture, acc.texture, t);
          this.presentedMix = t;
          this.presentedCount = acc.count;
        }
        if (t >= 1 && acc.count >= this.refineTarget) this.mode = 'DONE';
      }
    }
  }

  /** Centred render → gather DoF (or a plain copy when disabled) → preview buffer. */
  private renderPreview(o: DerivedOptics): void {
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.render(this.setup!.scene, this.camera);
    if (useStore.getState().debug.passes.gather) {
      this.updateApertureShape(o);
      this.gather.render(this.renderer, this.sceneRT.texture, this.sceneRT.depthTexture!, this.previewRT,
        this.blurParams(o), CONFIG.gatherMaxRadiusPx);
    } else {
      this.copyMaterial.uniforms.tSrc.value = this.sceneRT.texture;
      this.renderer.setRenderTarget(this.previewRT);
      this.copyQuad.render(this.renderer);
    }
  }

  /** Regenerates aperture samples and the gather kernel when the blade shape changes (§10.5). */
  private updateApertureShape(o: DerivedOptics): void {
    const key = `${o.blades}:${o.roundness}`;
    if (key === this.apertureKey) return;
    this.apertureKey = key;
    const shape = makeApertureShape(o.blades, o.roundness);
    this.aperture = apertureSamples(shape, CONFIG.apertureSampleCount);
    this.gather.setKernel(gatherKernel(shape, CONFIG.gatherKernelSize), shape.areaScale);
  }

  /**
   * Nothing reaches the screen while samples accumulate, so the browser applies no back-pressure and the
   * frame interval says nothing about GPU load. Instead each batch ends with a fence, and k ∈ [1, 16]
   * adapts so a batch completes within ~33 ms (§10.1). Returns false while the last batch is in flight.
   */
  private batchDone(): boolean {
    if (!this.fence) return true;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.fenceFrames++;
    if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
    gl.deleteSync(this.fence);
    this.fence = null;
    const batchMs = this.fenceFrames * this.frameMs;
    const k = this.samplesPerFrame;
    if (batchMs <= CONFIG.targetFrameMs * 0.6) this.samplesPerFrame = Math.min(CONFIG.maxSamplesPerFrame, k + 1);
    else if (batchMs > CONFIG.targetFrameMs * 1.5) {
      this.samplesPerFrame = Math.max(1, Math.floor((k * CONFIG.targetFrameMs) / batchMs));
    }
    this.fenceFrames = 0;
    return true;
  }

  private dropFence(): void {
    if (!this.fence) return;
    (this.renderer.getContext() as WebGL2RenderingContext).deleteSync(this.fence);
    this.fence = null;
    this.fenceFrames = 0;
  }

  private renderSamples(o: DerivedOptics, count: number): void {
    this.updateApertureShape(o);
    const w = this.sceneRT.width;
    const h = this.sceneRT.height;
    const lens: ThinLens = {
      focalM: o.focalMm / 1000,
      apertureM: o.apertureMm / 1000,
      focusM: o.focusM,
      tanHalfH: Math.tan((o.hfovDeg / 2) * RAD),
      tanHalfV: Math.tan((o.vfovDeg / 2) * RAD),
      near: CONFIG.nearM,
      far: CONFIG.farM,
      widthPx: w,
      heightPx: h,
    };
    const blur = this.blurParams(o);
    const passes = useStore.getState().debug.passes;
    const residual = CONFIG.residualBlur && passes.residual ? 0.45 / Math.sqrt(this.refineTarget) : 0;
    const { scene } = this.setup!;
    this.basePosition.copy(this.camera.position);

    for (let i = 0; i < count; i++) {
      const s = this.accumulator.count % CONFIG.apertureSampleCount;
      applyThinLensSample(this.camera, this.basePosition, lens,
        this.aperture[s * 2], this.aperture[s * 2 + 1], this.jitter[s * 2], this.jitter[s * 2 + 1]);
      this.renderer.setRenderTarget(this.sceneRT);
      this.renderer.render(scene, this.camera);
      this.accumulator.add(this.renderer, this.sceneRT.texture, this.sceneRT.depthTexture!, blur, residual, CONFIG.residualBlurMaxPx);
    }

    // Restore the centred camera.
    this.camera.position.copy(this.basePosition);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  private blurParams(o: DerivedOptics): BlurParams {
    return {
      focalMm: o.focalMm,
      apertureMm: o.apertureMm,
      focusM: o.focusM,
      sensorWidthMm: o.sensorWidthMm,
      renderWidthPx: this.sceneRT.width,
      near: CONFIG.nearM,
      far: CONFIG.farM,
    };
  }

  private present(preview: Texture, refined: Texture | null, mix: number): void {
    const o = this.optics!;
    const vignette = this.settings!.view === 'camera' && useStore.getState().debug.passes.vignette;
    this.lensPass.render(this.renderer, preview, refined, {
      mix,
      exposure: this.setup!.baseExposure * o.exposureFactor,
      vignetteEv: vignette ? o.vignetteEv : 0,
    });
    this.output.render(this.renderer, null as never, this.lensPass.target, 0, false);
    this.shown = { preview, refined, mix };
  }

  private publishSamples(samples: number): void {
    const state = useStore.getState();
    if (state.runtime.refine.samples !== samples) state.setRuntime({ refine: { samples, target: this.refineTarget } });
  }

  private layout(vw: number, vh: number, view: Settings['view'], aspect: number): void {
    const r = frameRect(vw, vh, view, aspect);
    if (r.x !== this.rect.x || r.y !== this.rect.y || r.width !== this.rect.width || r.height !== this.rect.height) {
      this.rect = r;
      Object.assign(this.canvas.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
    const size = renderSize(r.width, r.height, window.devicePixelRatio || 1);
    if (size.width !== this.sceneRT.width || size.height !== this.sceneRT.height) {
      this.renderer.setSize(size.width, size.height, false);
      this.sceneRT.dispose();
      this.sceneRT = this.makeSceneTarget(size.width, size.height);
      this.previewRT.setSize(size.width, size.height);
      this.accumulator.setSize(size.width, size.height);
      this.gather.setSize(size.width, size.height);
      this.lensPass.setSize(size.width, size.height);
      useStore.getState().setRuntime({ renderPx: size });
    }
  }

  private updateCameras(o: DerivedOptics): void {
    const p = this.controller.pose;
    for (const cam of [this.camera, this.eyeCamera]) {
      cam.position.set(p.x, p.eyeHeight, p.z);
      cam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
      cam.near = CONFIG.nearM;
      cam.far = CONFIG.farM;
    }
    this.camera.fov = o.vfovDeg;
    this.camera.aspect = o.imageAspect;
    const eyeAspect = this.rect.width / Math.max(this.rect.height, 1);
    this.eyeCamera.fov = eyeVfovDeg(eyeAspect);
    this.eyeCamera.aspect = eyeAspect;
    for (const cam of [this.camera, this.eyeCamera]) {
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    }
  }

  private updateRangefinder(now: number): void {
    if (!this.rangefinder || now - this.lastRangeTime < 1000 / CONFIG.rangefinderHz) return;
    if (sameKey(this.poseKey, this.rangePoseKey)) return;
    this.lastRangeTime = now;
    this.rangePoseKey = this.poseKey;
    const d = this.rangefinder.measure(this.camera);
    const state = useStore.getState();
    if (d !== state.runtime.centreDistanceM) state.setRuntime({ centreDistanceM: d });
  }

  private trackFps(now: number): void {
    this.fpsFrames++;
    if (!this.fpsTime) this.fpsTime = now;
    if (now - this.fpsTime >= 500) {
      const fps = (this.fpsFrames * 1000) / (now - this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = now;
      useStore.getState().setDebug({ fps });
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const state = useStore.getState();
    const lens = getLens(state.settings.lensId);
    if (lens.focalMm.max === lens.focalMm.min) return;
    // Shift+wheel arrives as horizontal scroll in some browsers.
    const delta = e.deltaY || e.deltaX;
    const px = e.deltaMode === 1 ? delta * 33 : e.deltaMode === 2 ? delta * 100 : delta;
    this.wheelAccum += px;
    const notches = Math.trunc(this.wheelAccum / 50);
    if (notches === 0) return;
    this.wheelAccum = 0;
    const step = Math.sign(notches) * Math.max(1, Math.round(Math.abs(notches) / 2));
    state.stepFocal(-step * (e.shiftKey ? 5 : 1));
  };

  private onLockChange = () => {
    useStore.getState().setRuntime({ pointerLocked: this.controller.locked });
  };
}

function sameKey(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
