import {
  AgXToneMapping, DepthTexture, FloatType, HalfFloatType, PerspectiveCamera, RGBAFormat, WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from '../config';
import { pixelJitter } from '../optics/aperture';
import { getLens } from '../optics/lenses';
import type { DerivedOptics } from '../optics/types';
import { opticsFor, useStore, type RenderMode, type RefineProgress, type Settings } from '../state/store';
import type { TimeOfDay } from '../scene/timeOfDay';
import type { Lighting, SceneSetup } from '../scene/types';
import { FpsController } from './FpsController';
import { Finder, sameKey, type Passes } from './Finder';
import { FrameStats } from './FrameStats';
import { eyeVfovDeg, finderRects, frameLineFractions, frameRect, hudScale, renderSize, type Rect } from './layout';
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

  /** The eye image, kept so side by side can crop it; and the scratch target finders render into. */
  private eyeRT: WebGLRenderTarget;
  private sceneRT: WebGLRenderTarget;
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
  private frameMs = 16;

  private screen: Screen | null = null;
  private samplesPerFrame = 1;
  /** GPU fence after the last sample batch, and how many frames it has been pending. */
  private fence: WebGLSync | null = null;
  private fenceFrames = 0;
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
    this.sceneRT = makeSceneTarget(1, 1);
    this.float32 = !!this.renderer.getContext().getExtension('EXT_color_buffer_float');
    this.output.renderToScreen = true;
    this.stats = new FrameStats(this.renderer);
    useStore.getState().setRuntime({ refine: { samples: 0, target: this.refineTarget } });

    // The lens wheel takes over the mouse while it's open (§9.2).
    this.controller = new FpsController(container, () => useStore.getState().wheel !== null);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.onLockChange);

    // A disposed viewer's load (React StrictMode mounts twice in dev) must not bring the loading screen back.
    const onProgress = (loadedBytes: number, totalBytes: number) => {
      if (!this.disposed) useStore.getState().setRuntime({ loading: { loadedBytes, totalBytes } });
    };
    options.loadScene(this.renderer, useStore.getState().settings.timeOfDay, onProgress).then(
      (setup) => {
        if (this.disposed) return setup.dispose();
        this.setup = setup;
        this.timeOfDay = setup.timeOfDay?.initial ?? null;
        this.controller.setWorld(setup.spawn, setup.colliders, setup.walkArea);
        this.rangefinder = new Rangefinder(setup.scene);
        this.setLighting(setup.lighting);
        useStore.getState().setRuntime({ loading: null });
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
    this.eyeRT.dispose();
    this.sceneRT.dispose();
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
          await this.renderer.compileAsync(this.setup!.scene, this.eyeCamera);
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
    this.frameMs = this.lastTime ? now - this.lastTime : 16;
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
    this.controller.update(dt, Math.tan((activeVfov / 2) * RAD) / Math.tan((CONFIG.lookReferenceVfovDeg / 2) * RAD));
    const p = this.controller.pose;
    this.poseKey = [p.x, p.z, p.eyeHeight, p.yaw, p.pitch];
    this.updateEyeCamera();

    redraw ||= screen !== this.screen;
    this.screen = screen;
    const passes = state.debug.passes;
    if (screen !== 'camera') redraw = this.updateEye(selected) || redraw;
    if (finders.length) redraw = this.updateFinders(finders, screen, now, passes, settings.lensId) || redraw;
    if (redraw) this.draw(screen, finders);

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
    }

    // Finder rectangles in buffer px, snapped to whole pixels so each is drawn 1:1.
    const k = size.width / Math.max(r.width, 1);
    const rects = screen === 'camera'
      ? [{ x: 0, y: 0, ...size }]
      : finderRects(vw, vh, finders.length, aspect, hudScale(vh)).map((f) => ({
        x: Math.round(f.x * k), y: Math.round(f.y * k), width: Math.round(f.width * k), height: Math.round(f.height * k),
      }));
    finders.forEach((f, i) => {
      if (f.setRect(rects[i])) changed = true;
    });
    const scene = rects[0];
    if (scene && (this.sceneRT.width !== scene.width || this.sceneRT.height !== scene.height)) {
      this.sceneRT.dispose();
      this.sceneRT = makeSceneTarget(scene.width, scene.height);
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
   * exposure without vignetting (§10.6). Returns true if it changed.
   */
  private updateEye(selected: DerivedOptics): boolean {
    const key = [...this.poseKey, this.eyeRT.width, this.eyeRT.height];
    const changed = !sameKey(key, this.eyeKey);
    this.eyeKey = key;
    if (changed) {
      this.renderer.setRenderTarget(this.eyeRT);
      this.renderer.render(this.setup!.scene, this.eyeCamera);
    }
    const exposure = this.lighting!.baseExposure * selected.exposureFactor;
    const exposureChanged = !sameKey([exposure], this.eyeExposureKey);
    this.eyeExposureKey = [exposure];
    if (changed || exposureChanged) this.eyeLens.render(this.renderer, this.eyeRT.texture, null, { mix: 0, exposure, vignetteEv: 0 });
    return changed || exposureChanged;
  }

  /** One frame of every finder's state machine (§10.1). Returns true if what any of them shows changed. */
  private updateFinders(finders: Finder[], screen: Screen, now: number, passes: Passes, selectedId: string): boolean {
    const baseExposure = this.lighting!.baseExposure;
    for (const f of finders) {
      const changed = f.sync(this.controller.pose, this.optics.get(f.lensId)!, passes, baseExposure);
      if (changed) this.renderPreview(f, screen === 'sideBySide', passes.gather);
      else f.settle(passes.refine);
    }
    this.refine(finders, selectedId, passes.residual);
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
    const crop = sideBySide ? frameLineFractions(o.hfovDeg, o.vfovDeg, this.eyeCamera.aspect) : null;
    const cropOk = crop && crop.halfWidth <= 1 && crop.halfHeight <= 1
      && f.rect.width / (crop.halfWidth * this.eyeRT.width) <= CONFIG.sideBySide.cropMaxUpscale;
    if (cropOk) {
      this.crop.render(this.renderer, this.eyeRT, this.sceneRT, crop.halfWidth, crop.halfHeight);
    } else {
      this.renderer.setRenderTarget(this.sceneRT);
      this.renderer.render(this.setup!.scene, f.camera);
    }
    if (gather) f.gatherPreview(this.renderer, this.sceneRT);
    else this.crop.render(this.renderer, this.sceneRT, f.previewRT, 1, 1);
  }

  /**
   * Thin-lens samples for the refining finders (§10.3), sharing one batch per frame. The finder with the fewest
   * samples goes next, the selected lens first on a tie, so they converge together.
   */
  private refine(finders: Finder[], selectedId: string, residual: boolean): void {
    const queue = finders.filter((f) => f.needsSamples);
    if (queue.length === 0) {
      this.dropFence();
      return;
    }
    if (!this.batchDone()) return;
    const rank = (f: Finder) => (f.lensId === selectedId ? -1 : finders.indexOf(f));
    const sampled = new Set<Finder>();
    for (let i = 0; i < this.samplesPerFrame && queue.length; i++) {
      queue.sort((a, b) => a.samples - b.samples || rank(a) - rank(b));
      const f = queue[0];
      f.renderSample(this.renderer, this.setup!.scene, this.sceneRT, this.jitter, CONFIG.residualBlur && residual);
      sampled.add(f);
      if (!f.needsSamples) queue.shift();
    }
    for (const f of sampled) f.restoreCamera();
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
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
    const samplesPerFrame = mode === 'REFINING' ? this.samplesPerFrame : 0;
    if (state.debug.mode !== mode || state.debug.samplesPerFrame !== samplesPerFrame) state.setDebug({ mode, samplesPerFrame });

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
