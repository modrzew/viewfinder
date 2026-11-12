import {
  AgXToneMapping, BufferGeometry, DepthTexture, Float32BufferAttribute, FloatType, Group, HalfFloatType, Mesh,
  NoBlending, PerspectiveCamera, RGBAFormat, ShaderMaterial, Vector3, WebGLRenderer, WebGLRenderTarget, type Scene,
  type Texture,
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
import type { TimeOfDay } from '../scene/timeOfDay';
import type { Lighting, SceneSetup } from '../scene/types';
import { compileWithoutStalling, gpuIdle, syncSignaled } from './compileShaders';
import { DynamicResolution } from './DynamicResolution';
import { FpsController, type Pose } from './FpsController';
import { FrameStats } from './FrameStats';
import { applyThinLensSample, type ThinLens } from './jitteredProjection';
import { eyeVfovDeg, frameRect, renderSize, type Rect } from './layout';
import { Accumulator } from './passes/Accumulator';
import { GatherDofPass } from './passes/GatherDofPass';
import { LensPass } from './passes/LensPass';
import { Rangefinder } from './Rangefinder';
import { FULLSCREEN_VERT, type BlurParams } from './shaders/common';

const RAD = Math.PI / 180;

export interface ViewerOptions {
  loadScene: (
    renderer: WebGLRenderer,
    timeOfDay: TimeOfDay,
    onProgress: (loadedBytes: number, totalBytes: number) => void,
  ) => Promise<SceneSetup>;
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
  private readonly stats: FrameStats;

  /** Full resolution: refinement samples. */
  private sceneRT: WebGLRenderTarget;
  /** The interactive preview and eye view at the dynamic-resolution scale; null while that's 1 (sceneRT is used). */
  private scaledSceneRT: WebGLRenderTarget | null = null;
  private readonly previewRT = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false });
  private readonly dynamicResolution = new DynamicResolution();
  private previewScale = 1;
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
  private lighting: Lighting | null = null;
  /** Time of day on screen, and one whose sky is loading or whose shaders are compiling. */
  private timeOfDay: TimeOfDay | null = null;
  private pendingTimeOfDay: TimeOfDay | null = null;
  /** Set while new lighting's shaders compile in the background; the old image stays up meanwhile. */
  private compiling = false;
  private rangefinder: Rangefinder | null = null;
  private disposed = false;
  private raf = 0;
  private lastTime = 0;

  private mode: RenderMode = 'INTERACTIVE';
  private stillFrames = 0;
  /**
   * Refinement batch size and queue depth as one level, adapted by adaptRefineLevel(): 0 is one sample with
   * one batch queued, n ≥ 1 is n samples per batch with `refineBatchesInFlight` batches queued.
   */
  private refineLevel = 1;
  private refineBatchesInFlight: number = CONFIG.refineBatchesInFlight;
  /** Sample batches the GPU hasn't finished, oldest first, each with its fence and when it was issued. */
  private readonly batches: { sync: WebGLSync; issuedAt: number }[] = [];
  private fadeStart: number | null = null;
  private presentedMix = -1;
  private presentedCount = -1;
  private presentedAt = 0;
  private opticalKey: unknown[] = [];
  private exposureKey: unknown[] = [];
  /** What's on screen, so an exposure-only change can re-run LensPass on it. */
  private shown: { preview: Texture; refined: Texture | null; mix: number } | null = null;
  private poseKey: number[] = [];
  private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private settings: Settings | null = null;
  private opticsEv100 = 0;
  private optics: DerivedOptics | null = null;

  private apertureKey = '';
  private aperture: Float32Array = new Float32Array(0);
  private readonly jitter = pixelJitter(CONFIG.apertureSampleCount);
  private readonly refineTarget = Math.min(Math.max(CONFIG.refineTarget, CONFIG.refineTargetRange[0]), CONFIG.refineTargetRange[1]);

  private lastRangeTime = 0;
  private rangePoseKey: number[] = [];
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
    this.stats = new FrameStats(this.renderer);
    useStore.getState().setRuntime({ refine: { samples: 0, target: this.refineTarget } });

    this.controller = new FpsController(container);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.onLockChange);

    // A disposed viewer's load (React StrictMode mounts twice in dev) must not bring the loading screen back.
    const onProgress = (loadedBytes: number, totalBytes: number) => {
      if (!this.disposed) useStore.getState().setRuntime({ loading: { loadedBytes, totalBytes } });
    };
    options.loadScene(this.renderer, useStore.getState().settings.timeOfDay, onProgress)
      .then(async (setup) => {
        if (this.disposed) return setup.dispose();
        // The loading screen stays up while shaders compile, so the first frame doesn't freeze the page.
        const loading = useStore.getState().runtime.loading;
        if (loading) useStore.getState().setRuntime({ loading: { ...loading, stage: 'shaders' } });
        this.rangefinder = new Rangefinder(setup.scene);
        await this.precompile(setup.scene);
        if (this.disposed) return setup.dispose();
        this.setup = setup;
        this.timeOfDay = setup.timeOfDay?.initial ?? null;
        this.controller.setWorld(setup.spawn, setup.colliders, setup.walkArea);
        this.setLighting(setup.lighting);
        // The first frame still compiles what precompile() can't reach (shadow-map depth, the sky background, the
        // output pass) and whatever the driver builds on first draw. Keep the loading screen over it.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await gpuIdle(this.renderer);
        if (!this.disposed) useStore.getState().setRuntime({ loading: null });
      })
      .catch((err: unknown) => {
        if (!this.disposed) useStore.getState().setRuntime({ error: String(err) });
      });

    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.dropBatches();
    this.controller.dispose();
    this.container.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.rangefinder?.dispose();
    this.setup?.dispose();
    this.sceneRT.dispose();
    this.scaledSceneRT?.dispose();
    this.previewRT.dispose();
    this.accumulator.dispose();
    this.gather.dispose();
    this.lensPass.dispose();
    this.output.dispose();
    this.copyMaterial.dispose();
    this.copyQuad.dispose();
    this.stats.dispose();
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

  /** Back to the scene's spawn point. */
  resetPose(): void {
    this.controller.resetToSpawn();
  }

  get pose(): Readonly<Pose> {
    return this.controller.pose;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** The time of day on screen once the scene is loaded and nothing is switching; null otherwise. */
  get settledTimeOfDay(): TimeOfDay | null {
    return this.setup && !this.compiling && !this.pendingTimeOfDay ? this.timeOfDay : null;
  }

  /** Whether the scene is loaded and on screen. */
  get ready(): boolean {
    return this.setup !== null && useStore.getState().runtime.loading === null;
  }

  /** Frame counters since start (FrameStats). */
  get frameTotals(): Readonly<FrameStats['totals']> {
    return this.stats.totals;
  }

  /** The GPU as the browser reports it (Firefox and Safari round it to a family, e.g. "Apple M1, or similar"). */
  get gpuName(): string {
    const gl = this.renderer.getContext();
    const name = String(gl.getParameter(gl.RENDERER));
    if (name !== 'WebKit WebGL') return name;
    // Chrome masks RENDERER but still has the debug extension (which Firefox deprecates and doesn't need).
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : name;
  }

  private setLighting(lighting: Lighting): void {
    this.lighting = lighting;
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
    useStore.getState().setRuntime({ ev100: lighting.ev100 });
  }

  /**
   * Follows the requested time of day: download its sky, relight the scene, compile the new shaders without
   * blocking, then show it. A newer request supersedes one still in flight.
   */
  private syncTimeOfDay(wanted: TimeOfDay): void {
    const control = this.setup?.timeOfDay;
    if (!control || this.compiling || wanted === this.pendingTimeOfDay) return;
    const setRuntime = useStore.getState().setRuntime;
    if (wanted === this.timeOfDay) {
      if (this.pendingTimeOfDay) setRuntime({ timeOfDayLoading: null });
      this.pendingTimeOfDay = null;
      return;
    }
    this.pendingTimeOfDay = wanted;
    setRuntime({ timeOfDayLoading: { timeOfDay: wanted, loadedBytes: 0, totalBytes: 0 } });
    control
      .load(wanted, (loadedBytes, totalBytes) => {
        if (this.pendingTimeOfDay === wanted) setRuntime({ timeOfDayLoading: { timeOfDay: wanted, loadedBytes, totalBytes } });
      })
      .then(async () => {
        if (this.disposed || this.pendingTimeOfDay !== wanted) return;
        const lighting = control.apply(wanted);
        this.timeOfDay = wanted;
        this.compiling = true;
        try {
          await compileWithoutStalling(this.renderer, [{ object: this.setup!.scene, camera: this.camera, target: this.sceneRT }]);
        } finally {
          this.compiling = false;
        }
        if (this.disposed) return;
        this.pendingTimeOfDay = null;
        setRuntime({ timeOfDayLoading: null });
        this.setLighting(lighting);
      })
      .catch((err: unknown) => {
        if (this.pendingTimeOfDay !== wanted) return;
        this.pendingTimeOfDay = null;
        setRuntime({ timeOfDayLoading: null, error: `Couldn't load the ${wanted} sky: ${String(err)}` });
      });
  }

  /** Compiles the scene's materials and the passes' without blocking the main thread (see compileShaders.ts). */
  private precompile(scene: Scene): Promise<void> {
    // Attributes select the program variant too: like FullScreenQuad's triangle, position and uv but no normals.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    const passes = new Group();
    for (const m of [...this.gather.materials, ...this.accumulator.materials, ...this.lensPass.materials, this.copyMaterial]) {
      passes.add(new Mesh(geometry, m));
    }
    // The camera only selects lights by layer; its pose doesn't matter here.
    return compileWithoutStalling(this.renderer, [
      { object: scene, camera: this.camera, target: this.sceneRT },
      // Every pass draws into a render target, so any one selects the right variant.
      { object: passes, camera: this.camera, target: this.previewRT },
    ]).finally(() => geometry.dispose());
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
    this.stats.begin();
    this.tick(now);
    this.stats.end(now);
  };

  private tick(now: number): void {
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = now;

    const state = useStore.getState();
    const { settings, runtime } = state;
    const ev100 = this.lighting?.ev100 ?? runtime.ev100;
    if (settings !== this.settings || ev100 !== this.opticsEv100) {
      this.settings = settings;
      this.opticsEv100 = ev100;
      this.optics = deriveOptics(getBody(settings.bodyId), getLens(settings.lensId), settings, ev100);
    }
    const optics = this.optics!;
    const view = settings.view;

    this.layout(runtime.viewport.width, runtime.viewport.height, view, optics.imageAspect);
    if (!this.setup || this.rect.width <= 0) return;
    this.syncTimeOfDay(settings.timeOfDay);
    // The scene is already relit for the new time of day, but its shaders aren't ready: keep the last image.
    if (this.compiling) return;

    const activeVfov = view === 'eye' ? this.eyeCamera.fov : optics.vfovDeg;
    this.controller.update(dt, Math.tan((activeVfov / 2) * RAD) / Math.tan((CONFIG.lookReferenceVfovDeg / 2) * RAD));
    this.updateCameras(optics);

    const p = this.controller.pose;
    const passes = state.debug.passes;
    this.poseKey = [p.x, p.z, p.eyeHeight, p.yaw, p.pitch];
    const key = [...this.poseKey, optics.lens.id, optics.focalMm, optics.fNumber, optics.focusM, view,
      this.sceneRT.width, this.sceneRT.height, this.previewRT.width, this.previewRT.height,
      passes.gather, passes.refine, passes.residual];
    const changed = !sameKey(key, this.opticalKey);
    this.opticalKey = key;
    const exposureKey = [optics.exposureFactor, optics.vignetteEv, passes.vignette, this.lighting!.baseExposure];
    const exposureChanged = !sameKey(exposureKey, this.exposureKey);
    this.exposureKey = exposureKey;

    if (view === 'eye') this.renderEye(changed);
    else this.renderCamera(changed, now, optics, passes.refine);
    // Exposure-only change (§10.1): re-run LensPass on what's shown; the accumulation is kept.
    if (exposureChanged && !changed && this.shown) this.present(this.shown.preview, this.shown.refined, this.shown.mix);

    // Runs of interactive frames set the preview resolution; layout() applies a new scale next frame.
    if (!changed) this.dynamicResolution.idle();
    else if (this.dynamicResolution.frame(now, this.stats.lastCpuMs)) this.previewScale = this.dynamicResolution.scale;

    this.updateRangefinder(now);
    // Compare what would be published, or every frame outside REFINING writes the store and re-renders the HUD.
    const samplesPerFrame = this.mode === 'REFINING' ? this.batchSize : 0;
    const d = state.debug;
    if (d.mode !== this.mode || d.samplesPerFrame !== samplesPerFrame || d.previewScale !== this.previewScale) {
      state.setDebug({ mode: this.mode, samplesPerFrame, previewScale: this.previewScale });
    }
  }

  /** Where the preview and eye view render: full resolution, or scaled down while frames are slow. */
  private get previewSceneRT(): WebGLRenderTarget {
    return this.scaledSceneRT ?? this.sceneRT;
  }

  private renderEye(changed: boolean): void {
    if (changed) {
      const target = this.previewSceneRT;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.setup!.scene, this.eyeCamera);
      this.present(target.texture, null, 0);
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
      this.dropBatches();
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
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      this.collectBatches(now);
      const depth = this.refineLevel === 0 ? 1 : this.refineBatchesInFlight;
      while (this.batches.length < depth && acc.count < this.refineTarget) {
        this.renderSamples(optics, Math.min(this.batchSize, this.refineTarget - acc.count));
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        if (!sync) break;
        this.batches.push({ sync, issuedAt: now });
      }
      this.publishSamples(acc.count);
      if (acc.count >= CONFIG.previewUntilSamples) {
        this.fadeStart ??= now;
        const t = Math.min((now - this.fadeStart) / CONFIG.crossfadeMs, 1);
        const finished = acc.count >= this.refineTarget;
        // Present only when the image changed, so presents don't compete with sampling. After the crossfade,
        // progress shows at a lower rate: each present also makes the browser composite the whole window.
        const due = t < 1 || finished || now - this.presentedAt >= CONFIG.refinePresentIntervalMs;
        if (due && (t !== this.presentedMix || acc.count !== this.presentedCount)) {
          this.present(this.previewRT.texture, acc.texture, t);
          this.presentedMix = t;
          this.presentedCount = acc.count;
          this.presentedAt = now;
        }
        if (t >= 1 && finished) this.mode = 'DONE';
      }
    }
  }

  /** Centred render → gather DoF (or a plain copy when disabled) → preview buffer, at the preview scale. */
  private renderPreview(o: DerivedOptics): void {
    const target = this.previewSceneRT;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.setup!.scene, this.camera);
    if (useStore.getState().debug.passes.gather) {
      this.updateApertureShape(o);
      // The clamp is in full-resolution px, so it covers the same share of the frame at any scale.
      const maxRadiusPx = (CONFIG.gatherMaxRadiusPx * target.width) / this.sceneRT.width;
      this.gather.render(this.renderer, target.texture, target.depthTexture!, this.previewRT,
        this.blurParams(o, target.width), maxRadiusPx);
    } else {
      this.copyMaterial.uniforms.tSrc.value = target.texture;
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

  private get batchSize(): number {
    return Math.max(1, this.refineLevel);
  }

  /**
   * Nothing reaches the screen while samples accumulate, so the browser applies no back-pressure and the
   * frame interval says nothing about GPU load. Instead each batch ends with a fence (§10.1). Finished batches
   * are noticed once per frame, so with one batch queued the GPU idles from finishing it until the next frame
   * issues another, and longer in Firefox, where commands also pass through its GPU process. With two queued
   * it moves straight on to the next.
   */
  private collectBatches(now: number): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    while (this.batches.length && syncSignaled(gl, this.batches[0].sync)) {
      const b = this.batches.shift()!;
      gl.deleteSync(b.sync);
      this.adaptRefineLevel(now - b.issuedAt, this.batches.length === 0);
    }
  }

  /**
   * `latencyMs`: from issuing a batch to seeing it done, queue wait included, which is how long a change could
   * wait behind refinement; it should stay near targetFrameMs. `drained`: nothing else was queued, so the GPU
   * may have idled; a bigger batch keeps it busier.
   */
  private adaptRefineLevel(latencyMs: number, drained: boolean): void {
    const target = CONFIG.targetFrameMs;
    const level = this.refineLevel;
    if (latencyMs > target * 1.5) {
      // Down to 0 when even one sample per batch is too slow to keep two queued.
      this.refineLevel = Math.floor((level * target) / latencyMs);
    } else if (latencyMs <= target * 0.6 || (drained && this.refineBatchesInFlight > 1 && latencyMs <= target)) {
      this.refineLevel = Math.min(level + 1, CONFIG.maxSamplesPerBatch);
    }
  }

  private dropBatches(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    for (const b of this.batches) gl.deleteSync(b.sync);
    this.batches.length = 0;
  }

  /** Benchmark: how many sample batches to keep queued (1 is the old scheme); restarts the adaptation. */
  setRefineBatchesInFlight(n: number): void {
    this.refineBatchesInFlight = n;
    this.refineLevel = 1;
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
    const blur = this.blurParams(o, w);
    const passes = useStore.getState().debug.passes;
    const residual = CONFIG.residualBlur && passes.residual ? CONFIG.residualBlurK / Math.sqrt(this.refineTarget) : 0;
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

  private blurParams(o: DerivedOptics, renderWidthPx: number): BlurParams {
    return {
      focalMm: o.focalMm,
      apertureMm: o.apertureMm,
      focusM: o.focusM,
      sensorWidthMm: o.sensorWidthMm,
      renderWidthPx,
      near: CONFIG.nearM,
      far: CONFIG.farM,
    };
  }

  private present(preview: Texture, refined: Texture | null, mix: number): void {
    const o = this.optics!;
    const vignette = this.settings!.view === 'camera' && useStore.getState().debug.passes.vignette;
    this.lensPass.render(this.renderer, preview, refined, {
      mix,
      exposure: this.lighting!.baseExposure * o.exposureFactor,
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
      this.accumulator.setSize(size.width, size.height);
      this.lensPass.setSize(size.width, size.height);
      useStore.getState().setRuntime({ renderPx: size });
    }
    // LensPass upsamples the preview bilinearly; the refined image is always full size.
    const pw = Math.max(1, Math.round(size.width * this.previewScale));
    const ph = Math.max(1, Math.round(size.height * this.previewScale));
    if (pw !== this.previewRT.width || ph !== this.previewRT.height) {
      this.previewRT.setSize(pw, ph);
      this.gather.setSize(pw, ph);
      this.scaledSceneRT?.dispose();
      this.scaledSceneRT = this.previewScale < 1 ? this.makeSceneTarget(pw, ph) : null;
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
