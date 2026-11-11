import {
  AgXToneMapping, DepthTexture, FloatType, HalfFloatType, PerspectiveCamera, RGBAFormat, WebGLRenderer,
  WebGLRenderTarget, type Texture,
} from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from '../config';
import { getBody } from '../optics/bodies';
import { getLens } from '../optics/lenses';
import { deriveOptics } from '../optics/optics';
import type { DerivedOptics } from '../optics/types';
import { useStore, type RenderMode, type Settings } from '../state/store';
import type { SceneSetup } from '../scene/types';
import { FpsController } from './FpsController';
import { eyeVfovDeg, frameRect, renderSize, type Rect } from './layout';
import { Rangefinder } from './Rangefinder';

const RAD = Math.PI / 180;

export interface ViewerOptions {
  loadScene: () => Promise<SceneSetup>;
}

/** Drives Three.js imperatively; React only renders the UI (§5, §6). */
export class Viewer {
  private readonly canvas = document.createElement('canvas');
  private readonly renderer: WebGLRenderer;
  private readonly camera = new PerspectiveCamera();
  private readonly eyeCamera = new PerspectiveCamera();
  private readonly controller: FpsController;
  private readonly output = new OutputPass();
  private sceneRT: WebGLRenderTarget;

  private setup: SceneSetup | null = null;
  private rangefinder: Rangefinder | null = null;
  private disposed = false;
  private raf = 0;
  private lastTime = 0;

  private mode: RenderMode = 'INTERACTIVE';
  private opticalKey: unknown[] = [];
  private poseKey: number[] = [];
  private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private settings: Settings | null = null;
  private optics: DerivedOptics | null = null;

  private lastRangeTime = 0;
  private rangePoseKey: number[] = [];
  private fpsFrames = 0;
  private fpsTime = 0;
  private wheelAccum = 0;

  private readonly container: HTMLElement;

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
    this.output.renderToScreen = true;

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
        this.invalidate();
      },
      (err: unknown) => useStore.getState().setRuntime({ error: String(err) }),
    );

    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controller.dispose();
    this.container.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.rangefinder?.dispose();
    this.setup?.dispose();
    this.sceneRT.dispose();
    this.output.dispose();
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

  private makeSceneTarget(w: number, h: number): WebGLRenderTarget {
    const rt = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: true });
    rt.depthTexture = new DepthTexture(w, h, FloatType);
    return rt;
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.1) : 0;
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
    const poseKey = [p.x, p.z, p.eyeHeight, p.yaw, p.pitch];
    const key = [...poseKey, optics.lens.id, optics.focalMm, optics.fNumber, optics.focusM, view,
      this.sceneRT.width, this.sceneRT.height];
    const changed = !sameKey(key, this.opticalKey);
    this.opticalKey = key;
    this.poseKey = poseKey;

    if (changed) this.mode = 'INTERACTIVE';
    if (this.mode !== 'DONE') {
      this.renderPinhole(view === 'eye' ? this.eyeCamera : this.camera);
      this.present(this.sceneRT.texture);
      if (!changed) this.mode = 'DONE';
    }

    this.updateRangefinder(now);
    if (state.debug.mode !== this.mode) state.setDebug({ mode: this.mode });
  };

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

  private renderPinhole(cam: PerspectiveCamera): void {
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.render(this.setup!.scene, cam);
  }

  private present(tex: Texture): void {
    this.output.render(this.renderer, null as never, { texture: tex } as WebGLRenderTarget, 0, false);
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
