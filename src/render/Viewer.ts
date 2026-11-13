import {
  AgXToneMapping, BufferGeometry, DepthTexture, Float32BufferAttribute, FloatType, Group, HalfFloatType, Mesh,
  PerspectiveCamera, RGBAFormat, WebGLRenderer, WebGLRenderTarget, type Scene,
} from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from '../config';
import { pixelJitter } from '../optics/aperture';
import { getLens } from '../optics/lenses';
import type { DerivedOptics } from '../optics/types';
import { hudScaleOf, opticsFor, useStore, type RenderMode, type RefineProgress, type Settings } from '../state/store';
import type { TimeOfDay } from '../scene/timeOfDay';
import type { Lighting, SceneSetup } from '../scene/types';
import { compileWithoutStalling, gpuIdle, syncSignaled } from './compileShaders';
import { DynamicResolution } from './DynamicResolution';
import { FpsController, type Pose } from './FpsController';
import { Finder, previewSize, sameKey, type Passes } from './Finder';
import { FrameStats } from './FrameStats';
import { eyeVfovDeg, finderRects, frameLineFractions, frameRect, renderSize, type Rect } from './layout';
import { CropPass } from './passes/CropPass';
import { LensPass } from './passes/LensPass';
import { Rangefinder } from './Rangefinder';

const RAD = Math.PI / 180;

/** What's on screen: the camera view, the plain eye view, or the eye view with finders side by side (§9.1). */
type Screen = 'camera' | 'eye' | 'sideBySide';

export interface ViewerOptions {
  loadScene: (
    renderer: WebGLRenderer,
    timeOfDay: TimeOfDay,
    onProgress: (loadedBytes: number, totalBytes: number) => void,
  ) => Promise<SceneSetup>;
}

/**
 * Drives Three.js imperatively; React only renders the UI (§5, §6).
 * Each view of a lens is a Finder running INTERACTIVE → REFINING → DONE (§10.1): one full-size finder in camera
 * view, one per shown lens side by side (§10.9). The eye view behind them is a plain render. The Viewer owns
 * the scene render targets, the sample budget and the canvas, and redraws the canvas whenever anything on it
 * changes.
 */
export class Viewer {
  private readonly container: HTMLElement;
  private readonly canvas = document.createElement('canvas');
  private readonly renderer: WebGLRenderer;
  private readonly eyeCamera = new PerspectiveCamera();
  private readonly controller: FpsController;
  private readonly stats: FrameStats;
  private readonly float32: boolean;

  /**
   * The eye image, kept so side by side can crop it; and the scratch target finders render samples into, at
   * their full size. While dynamic resolution has scaled things down (§10.2), moving renders the eye image into
   * `eyeScaledRT` and previews into `previewSceneRT`; both are null at scale 1, when the full-size ones serve.
   */
  private eyeRT: WebGLRenderTarget;
  private eyeScaledRT: WebGLRenderTarget | null = null;
  /** Whichever eye target holds the current eye image. */
  private eyeImage: WebGLRenderTarget;
  private sceneRT: WebGLRenderTarget;
  private previewSceneRT: WebGLRenderTarget | null = null;
  private readonly dynamicResolution = new DynamicResolution();
  private previewScale = 1;
  /** Whether this frame rendered something new because something optical changed, for dynamic resolution. */
  private interactiveFrame = false;
  private readonly eyeLens = new LensPass();
  private readonly crop = new CropPass();
  private readonly output = new OutputPass();

  /** Camera view's finder, and side by side's by lens id. Each keeps its image while off screen. */
  private cameraFinder: Finder | null = null;
  private readonly finders = new Map<string, Finder>();

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

  private screen: Screen | null = null;
  /**
   * Refinement batch size and queue depth as one level, adapted by adaptRefineLevel(): 0 is one sample with
   * one batch queued, n ≥ 1 is n samples per batch with `refineBatchesInFlight` batches queued.
   */
  private refineLevel = 1;
  private refineBatchesInFlight: number = CONFIG.refineBatchesInFlight;
  /** Sample batches the GPU hasn't finished, oldest first, each with its fence and when it was issued. */
  private readonly batches: { sync: WebGLSync; issuedAt: number }[] = [];
  private eyeKey: unknown[] = [];
  private eyeExposureKey: unknown[] = [];
  private poseKey: number[] = [];
  /** The canvas: where it sits in the viewport (CSS px), and its buffer size. */
  private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private size = { width: 0, height: 0 };
  private settings: Settings | null = null;
  private opticsEv100 = 0;
  /** Derived optics of the selected lens and the shown ones, by lens id. */
  private optics = new Map<string, DerivedOptics>();

  private readonly jitter = pixelJitter(CONFIG.apertureSampleCount);
  private readonly refineTarget = clampTarget(CONFIG.refineTarget);
  private readonly finderRefineTarget = clampTarget(CONFIG.sideBySide.refineTarget);

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

    this.eyeRT = makeSceneTarget(1, 1);
    this.eyeImage = this.eyeRT;
    this.sceneRT = makeSceneTarget(1, 1);
    this.float32 = !!this.renderer.getContext().getExtension('EXT_color_buffer_float');
    this.output.renderToScreen = true;
    this.stats = new FrameStats(this.renderer);
    useStore.getState().setRuntime({ refine: { samples: 0, target: this.refineTarget } });

    // The lens wheel takes over the mouse while it's open (§9.2); the touch UI has no use for it (§9.5).
    this.controller = new FpsController(container, () => {
      const s = useStore.getState();
      return s.wheel !== null || s.input === 'touch';
    });
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
    this.eyeRT.dispose();
    this.eyeScaledRT?.dispose();
    this.sceneRT.dispose();
    this.previewSceneRT?.dispose();
    this.cameraFinder?.dispose();
    for (const f of this.finders.values()) f.dispose();
    this.eyeLens.dispose();
    this.crop.dispose();
    this.output.dispose();
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

  /** Forces an optical reset of every view on the next frame. */
  invalidate(): void {
    this.eyeKey = [];
    this.cameraFinder?.invalidate();
    for (const f of this.finders.values()) f.invalidate();
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

  /** Benchmark: how many sample batches to keep queued (1 is the old scheme); restarts the adaptation. */
  setRefineBatchesInFlight(n: number): void {
    this.refineBatchesInFlight = n;
    this.refineLevel = 1;
  }

  /**
   * Compiles the scene's materials and the passes' without blocking the main thread (see compileShaders.ts).
   * Finders share their passes' programs, and the camera view's finder lives as long as the viewer, so finders
   * made later (side by side) find them compiled.
   */
  private precompile(scene: Scene): Promise<void> {
    const s = useStore.getState().settings;
    this.cameraFinder ??= new Finder(s.lensId, this.refineTarget, this.float32);
    // Attributes select the program variant too: like FullScreenQuad's triangle, position and uv but no normals.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    const passes = new Group();
    for (const m of [...this.cameraFinder.materials, ...this.eyeLens.materials, ...this.crop.materials]) {
      passes.add(new Mesh(geometry, m));
    }
    // The camera only selects lights by layer; its pose doesn't matter here.
    return compileWithoutStalling(this.renderer, [
      { object: scene, camera: this.eyeCamera, target: this.sceneRT },
      // Every pass draws into a render target, so any one selects the right variant.
      { object: passes, camera: this.eyeCamera, target: this.cameraFinder.previewRT },
    ]).finally(() => geometry.dispose());
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
          await compileWithoutStalling(this.renderer, [{ object: this.setup!.scene, camera: this.eyeCamera, target: this.sceneRT }]);
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
      this.optics.clear();
      for (const id of new Set([settings.lensId, ...settings.sideBySideLensIds])) {
        this.optics.set(id, opticsFor(settings, ev100, id));
      }
    }
    const selected = this.optics.get(settings.lensId)!;
    const screen: Screen = settings.view === 'camera' ? 'camera' : settings.sideBySide ? 'sideBySide' : 'eye';
    const finders = this.syncFinders(screen, settings);

    let redraw = this.layout(runtime.viewport.width, runtime.viewport.height, screen, selected.imageAspect, finders);
    if (!this.setup || this.rect.width <= 0) return;
    this.syncTimeOfDay(settings.timeOfDay);
    // The scene is already relit for the new time of day, but its shaders aren't ready: keep the last image.
    if (this.compiling) return;

    const activeVfov = screen === 'camera' ? selected.vfovDeg : this.eyeCamera.fov;
    const tanHalfVfov = Math.tan((activeVfov / 2) * RAD);
    // A finger dragged across the view's height turns it by about its vertical field of view (§9.5).
    this.controller.update(
      dt, tanHalfVfov / Math.tan((CONFIG.lookReferenceVfovDeg / 2) * RAD), (2 * tanHalfVfov) / Math.max(this.rect.height, 1),
    );
    const p = this.controller.pose;
    this.poseKey = [p.x, p.z, p.eyeHeight, p.yaw, p.pitch];
    this.updateEyeCamera();

    redraw ||= screen !== this.screen;
    this.screen = screen;
    const passes = state.debug.passes;
    this.interactiveFrame = false;
    if (screen !== 'camera') redraw = this.updateEye(selected) || redraw;
    if (finders.length) redraw = this.updateFinders(finders, screen, now, passes, settings.lensId) || redraw;
    if (redraw) this.draw(screen, finders);

    // Runs of interactive frames set the preview resolution; layout() applies a new scale next frame.
    if (!this.interactiveFrame) this.dynamicResolution.idle();
    else if (this.dynamicResolution.frame(now, this.stats.lastCpuMs)) this.previewScale = this.dynamicResolution.scale;

    this.updateRangefinder(now);
    this.publish(screen, finders);
  }

  /** The finders on screen, in loadout order, created as lenses appear; side by side drops lenses no longer shown. */
  private syncFinders(screen: Screen, s: Settings): Finder[] {
    if (screen === 'camera') {
      this.cameraFinder ??= new Finder(s.lensId, this.refineTarget, this.float32);
      this.cameraFinder.lensId = s.lensId;
      return [this.cameraFinder];
    }
    for (const [id, f] of this.finders) {
      if (!s.sideBySideLensIds.includes(id)) {
        f.dispose();
        this.finders.delete(id);
      }
    }
    if (screen === 'eye') return [];
    return s.sideBySideLensIds.map((id) => {
      let f = this.finders.get(id);
      if (!f) this.finders.set(id, (f = new Finder(id, this.finderRefineTarget, this.float32)));
      return f;
    });
  }

  /**
   * Sizes the canvas (the camera frame, or the whole viewport for the eye view), the targets and the finders.
   * Returns true if anything moved or was resized, so the canvas has to be redrawn.
   */
  private layout(vw: number, vh: number, screen: Screen, aspect: number, finders: Finder[]): boolean {
    let changed = false;
    const r = frameRect(vw, vh, screen === 'camera' ? 'camera' : 'eye', aspect);
    if (r.x !== this.rect.x || r.y !== this.rect.y || r.width !== this.rect.width || r.height !== this.rect.height) {
      this.rect = r;
      Object.assign(this.canvas.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
      changed = true;
    }
    const size = renderSize(r.width, r.height, window.devicePixelRatio || 1);
    if (size.width !== this.size.width || size.height !== this.size.height) {
      this.size = size;
      this.renderer.setSize(size.width, size.height, false);
      useStore.getState().setRuntime({ renderPx: size });
      changed = true;
    }
    if (screen !== 'camera' && (this.eyeRT.width !== size.width || this.eyeRT.height !== size.height)) {
      this.eyeRT.dispose();
      this.eyeRT = makeSceneTarget(size.width, size.height);
      this.eyeLens.setSize(size.width, size.height);
      this.eyeImage = this.eyeRT;
    }
    if (screen !== 'camera') {
      const s = this.previewScale;
      const scaled = scaledTarget(this.eyeScaledRT, previewSize(size.width, s), previewSize(size.height, s), s < 1);
      if (scaled !== this.eyeScaledRT) {
        // The eye image may have been in the old one: render it again.
        this.eyeScaledRT = scaled;
        this.eyeImage = this.eyeRT;
        this.eyeKey = [];
      }
    }

    // Finder rectangles in buffer px, snapped to whole pixels so each is drawn 1:1.
    const state = useStore.getState();
    const k = size.width / Math.max(r.width, 1);
    const rects = screen === 'camera'
      ? [{ x: 0, y: 0, ...size }]
      : finderRects(vw, vh, finders.length, aspect, hudScaleOf(state), state.runtime.safeArea).map((f) => ({
        x: Math.round(f.x * k), y: Math.round(f.y * k), width: Math.round(f.width * k), height: Math.round(f.height * k),
      }));
    finders.forEach((f, i) => {
      if (f.setRect(rects[i], this.previewScale)) changed = true;
    });
    // Every finder is the same size: samples render at it, previews at it times the preview scale.
    const scene = rects[0];
    if (scene && (this.sceneRT.width !== scene.width || this.sceneRT.height !== scene.height)) {
      this.sceneRT.dispose();
      this.sceneRT = makeSceneTarget(scene.width, scene.height);
    }
    if (scene) {
      const s = this.previewScale;
      this.previewSceneRT = scaledTarget(this.previewSceneRT, previewSize(scene.width, s), previewSize(scene.height, s), s < 1);
    }
    return changed;
  }

  private updateEyeCamera(): void {
    const p = this.controller.pose;
    const cam = this.eyeCamera;
    cam.position.set(p.x, p.eyeHeight, p.z);
    cam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    cam.near = CONFIG.nearM;
    cam.far = CONFIG.farM;
    const aspect = this.rect.width / Math.max(this.rect.height, 1);
    cam.fov = eyeVfovDeg(aspect);
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /**
   * The eye image: rendered only when the pose, the size or the lighting changed, at the selected lens's
   * exposure without vignetting (§10.6). While moving it renders at the dynamic-resolution scale, and once
   * still, once more at full resolution. Returns true if it changed.
   */
  private updateEye(selected: DerivedOptics): boolean {
    const key = [...this.poseKey, this.eyeRT.width, this.eyeRT.height];
    const moved = !sameKey(key, this.eyeKey);
    this.eyeKey = key;
    const target = moved ? (this.eyeScaledRT ?? this.eyeRT) : this.eyeImage !== this.eyeRT ? this.eyeRT : null;
    if (target) {
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.setup!.scene, this.eyeCamera);
      this.eyeImage = target;
    }
    if (moved) this.interactiveFrame = true;
    const exposure = this.lighting!.baseExposure * selected.exposureFactor;
    const exposureChanged = !sameKey([exposure], this.eyeExposureKey);
    this.eyeExposureKey = [exposure];
    if (target || exposureChanged) {
      this.eyeLens.render(this.renderer, this.eyeImage.texture, null, { mix: 0, exposure, vignetteEv: 0 });
    }
    return !!target || exposureChanged;
  }

  /** One frame of every finder's state machine (§10.1). Returns true if what any of them shows changed. */
  private updateFinders(finders: Finder[], screen: Screen, now: number, passes: Passes, selectedId: string): boolean {
    const baseExposure = this.lighting!.baseExposure;
    for (const f of finders) {
      const changed = f.sync(this.controller.pose, this.optics.get(f.lensId)!, passes, baseExposure);
      if (changed) {
        this.renderPreview(f, screen === 'sideBySide', passes.gather);
        this.interactiveFrame = true;
      } else {
        f.settle(passes.refine);
      }
    }
    this.refine(finders, selectedId, passes.residual, now);
    let changed = false;
    for (const f of finders) {
      f.fade(now);
      if (!f.dirty) continue;
      f.present(this.renderer, baseExposure, passes.vignette);
      changed = true;
    }
    return changed;
  }

  /**
   * Scene → gather DoF (or a plain copy when disabled) → the finder's preview. Side by side, the scene is a crop
   * of the eye image, so moving costs one scene render however many finders there are, and changing a lens
   * costs none (§10.9). Long lenses on small windows would upscale the crop too much, and very wide windows
   * cut off a lens's frame; those get a render of their own.
   */
  private renderPreview(f: Finder, sideBySide: boolean, gather: boolean): void {
    const o = f.optics!;
    // At the preview scale; the eye image may be scaled too, so the upscale is measured on what's there.
    const target = this.previewSceneRT ?? this.sceneRT;
    const eye = this.eyeImage;
    const crop = sideBySide ? frameLineFractions(o.hfovDeg, o.vfovDeg, this.eyeCamera.aspect) : null;
    const cropOk = crop && crop.halfWidth <= 1 && crop.halfHeight <= 1
      && target.width / (crop.halfWidth * eye.width) <= CONFIG.sideBySide.cropMaxUpscale;
    if (cropOk) {
      this.crop.render(this.renderer, eye, target, crop.halfWidth, crop.halfHeight);
    } else {
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.setup!.scene, f.camera);
    }
    if (gather) f.gatherPreview(this.renderer, target);
    else this.crop.render(this.renderer, target, f.previewRT, 1, 1);
  }

  /**
   * Thin-lens samples for the refining finders (§10.3), sharing the batches. The finder with the fewest samples
   * goes next, the selected lens first on a tie, so they converge together.
   */
  private refine(finders: Finder[], selectedId: string, residual: boolean, now: number): void {
    const queue = finders.filter((f) => f.needsSamples);
    if (queue.length === 0) {
      this.dropBatches();
      return;
    }
    this.collectBatches(now);
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const rank = (f: Finder) => (f.lensId === selectedId ? -1 : finders.indexOf(f));
    const depth = this.refineLevel === 0 ? 1 : this.refineBatchesInFlight;
    while (this.batches.length < depth && queue.length) {
      const sampled = new Set<Finder>();
      for (let i = 0; i < this.batchSize && queue.length; i++) {
        queue.sort((a, b) => a.samples - b.samples || rank(a) - rank(b));
        const f = queue[0];
        f.renderSample(this.renderer, this.setup!.scene, this.sceneRT, this.jitter, CONFIG.residualBlur && residual);
        sampled.add(f);
        if (!f.needsSamples) queue.shift();
      }
      for (const f of sampled) f.restoreCamera();
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      if (!sync) break;
      this.batches.push({ sync, issuedAt: now });
    }
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

  /**
   * Redraws the canvas from what's cached: the drawing buffer isn't preserved, so everything goes again
   * whenever anything changed. The eye image fills it, then each finder goes into its rectangle.
   */
  private draw(screen: Screen, finders: Finder[]): void {
    const r = this.renderer;
    if (screen !== 'camera') this.output.render(r, null as never, this.eyeLens.target, 0, false);
    for (const f of finders) f.draw(r, this.output, this.size.height);
    r.setViewport(0, 0, this.size.width, this.size.height);
    r.setScissor(0, 0, this.size.width, this.size.height);
    r.setScissorTest(false);
  }

  /** Mode and refinement progress of the whole screen, and of each finder side by side. */
  private publish(screen: Screen, finders: Finder[]): void {
    const state = useStore.getState();
    const mode: RenderMode = finders.some((f) => f.mode === 'INTERACTIVE') ? 'INTERACTIVE'
      : finders.some((f) => f.mode === 'REFINING') ? 'REFINING' : 'DONE';
    const samplesPerFrame = mode === 'REFINING' ? this.batchSize : 0;
    const d = state.debug;
    if (d.mode !== mode || d.samplesPerFrame !== samplesPerFrame || d.previewScale !== this.previewScale) {
      state.setDebug({ mode, samplesPerFrame, previewScale: this.previewScale });
    }

    const refine = finders.length
      ? { samples: sum(finders, (f) => f.samples), target: sum(finders, (f) => f.refineTarget) }
      : { samples: 0, target: this.refineTarget };
    const finderRefine: Record<string, RefineProgress> = {};
    if (screen === 'sideBySide') for (const f of finders) finderRefine[f.lensId] = { samples: f.samples, target: f.refineTarget };
    const rt = state.runtime;
    const patch: Partial<typeof rt> = {};
    if (rt.refine.samples !== refine.samples || rt.refine.target !== refine.target) patch.refine = refine;
    if (!sameProgress(rt.finderRefine, finderRefine)) patch.finderRefine = finderRefine;
    if (patch.refine || patch.finderRefine) state.setRuntime(patch);
  }

  private updateRangefinder(now: number): void {
    if (!this.rangefinder || now - this.lastRangeTime < 1000 / CONFIG.rangefinderHz) return;
    if (sameKey(this.poseKey, this.rangePoseKey)) return;
    this.lastRangeTime = now;
    this.rangePoseKey = this.poseKey;
    const d = this.rangefinder.measure(this.eyeCamera);
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

function makeSceneTarget(w: number, h: number): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: true });
  rt.depthTexture = new DepthTexture(w, h, FloatType);
  return rt;
}

/** `rt` at w × h when `want`, else null; reuses it if the size matches and disposes it otherwise. */
function scaledTarget(rt: WebGLRenderTarget | null, w: number, h: number, want: boolean): WebGLRenderTarget | null {
  if (want && rt && rt.width === w && rt.height === h) return rt;
  rt?.dispose();
  return want ? makeSceneTarget(w, h) : null;
}

function clampTarget(n: number): number {
  return Math.min(Math.max(n, CONFIG.refineTargetRange[0]), CONFIG.refineTargetRange[1]);
}

function sum<T>(items: T[], f: (item: T) => number): number {
  return items.reduce((acc, item) => acc + f(item), 0);
}

function sameProgress(a: Record<string, RefineProgress>, b: Record<string, RefineProgress>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && a[k].samples === b[k].samples && a[k].target === b[k].target);
}
