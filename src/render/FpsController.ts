import { CONFIG } from '../config';
import type { Collider, Spawn, WalkArea } from '../scene/types';

const DEG = Math.PI / 180;

/** True when a form control has focus, so shortcuts should be ignored (§9.3). */
export function formControlFocused(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
    || (el as HTMLElement).isContentEditable;
}

export interface Pose { x: number; z: number; eyeHeight: number; yaw: number; pitch: number }

/**
 * FPS-style input: pointer-lock mouse look, WASD walking with smoothing,
 * Q/E eye height, and circle-vs-collider push-out (§9.3, §11.6).
 * Yaw 0 looks down −z; positive yaw turns left.
 */
export class FpsController {
  readonly pose: Pose = { x: 0, z: 0, eyeHeight: CONFIG.eyeHeightM.default, yaw: 0, pitch: 0 };
  private vx = 0;
  private vz = 0;
  private lookDx = 0;
  private lookDy = 0;
  /** Browsers can report a bogus jump on the first move after locking. */
  private skipMove = false;
  private readonly keys = new Set<string>();
  private colliders: Collider[] = [];
  private area: WalkArea = { minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 };
  private spawn: Spawn = { x: 0, z: 0, eyeHeightM: CONFIG.eyeHeightM.default, yawDeg: 0, pitchDeg: 0 };

  private readonly target: HTMLElement;

  constructor(target: HTMLElement) {
    this.target = target;
    target.addEventListener('click', this.onClick);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.target.removeEventListener('click', this.onClick);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  setWorld(spawn: Spawn, colliders: Collider[], area: WalkArea): void {
    this.spawn = spawn;
    this.colliders = colliders;
    this.area = area;
    this.resetToSpawn();
  }

  resetToSpawn(): void {
    const s = this.spawn;
    Object.assign(this.pose, { x: s.x, z: s.z, eyeHeight: s.eyeHeightM, yaw: s.yawDeg * DEG, pitch: s.pitchDeg * DEG });
    this.vx = this.vz = 0;
  }

  /** Advances the pose by `dt` seconds. `lookScale` = tan(vfov/2) / tan(vfov_ref/2). */
  update(dt: number, lookScale: number): void {
    const p = this.pose;

    if (this.lookDx !== 0 || this.lookDy !== 0) {
      const k = CONFIG.lookRadPerPx * lookScale;
      p.yaw -= this.lookDx * k;
      p.pitch = Math.min(Math.max(p.pitch - this.lookDy * k, -CONFIG.pitchLimitDeg * DEG), CONFIG.pitchLimitDeg * DEG);
      this.lookDx = this.lookDy = 0;
    }

    const k = this.keys;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const speed = CONFIG.walkSpeedMps * (k.has('ShiftLeft') || k.has('ShiftRight') ? CONFIG.runMultiplier : 1);
    let tx = 0;
    let tz = 0;
    if (fwd !== 0 || strafe !== 0) {
      const len = Math.hypot(fwd, strafe);
      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      // forward = (−sin, −cos), right = (cos, −sin)
      tx = ((-sin * fwd + cos * strafe) / len) * speed;
      tz = ((-cos * fwd - sin * strafe) / len) * speed;
    }
    const a = 1 - Math.exp(-dt / CONFIG.moveSmoothingS);
    this.vx += (tx - this.vx) * a;
    this.vz += (tz - this.vz) * a;
    if (tx === 0 && tz === 0 && Math.hypot(this.vx, this.vz) < 0.01) this.vx = this.vz = 0;

    if (this.vx !== 0 || this.vz !== 0) {
      p.x += this.vx * dt;
      p.z += this.vz * dt;
      this.collide();
    }

    const dh = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (dh !== 0) {
      const { min, max } = CONFIG.eyeHeightM;
      p.eyeHeight = Math.min(Math.max(p.eyeHeight + dh * CONFIG.eyeHeightSpeedMps * dt, min), max);
    }
  }

  private collide(): void {
    const p = this.pose;
    const r = CONFIG.playerRadiusM;
    for (let iter = 0; iter < 4; iter++) {
      for (const c of this.colliders) {
        if (c.kind === 'circle') {
          const dx = p.x - c.x;
          const dz = p.z - c.z;
          const d = Math.hypot(dx, dz);
          const min = c.r + r;
          if (d < min) {
            if (d < 1e-6) p.x += min;
            else {
              p.x += (dx / d) * (min - d);
              p.z += (dz / d) * (min - d);
            }
          }
        } else {
          const rot = c.rotY ?? 0;
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          // into box space (inverse rotation about y)
          const wx = p.x - c.x;
          const wz = p.z - c.z;
          let lx = cos * wx - sin * wz;
          let lz = sin * wx + cos * wz;
          const cx = Math.min(Math.max(lx, -c.halfW), c.halfW);
          const cz = Math.min(Math.max(lz, -c.halfD), c.halfD);
          const dx = lx - cx;
          const dz = lz - cz;
          const d = Math.hypot(dx, dz);
          if (d >= r) continue;
          if (d > 1e-6) {
            lx += (dx / d) * (r - d);
            lz += (dz / d) * (r - d);
          } else {
            // centre inside the box: leave by the nearest face
            const ex = c.halfW - Math.abs(lx);
            const ez = c.halfD - Math.abs(lz);
            if (ex < ez) lx = Math.sign(lx || 1) * (c.halfW + r);
            else lz = Math.sign(lz || 1) * (c.halfD + r);
          }
          p.x = c.x + cos * lx + sin * lz;
          p.z = c.z - sin * lx + cos * lz;
        }
      }
      const a = this.area;
      p.x = Math.min(Math.max(p.x, a.minX + r), a.maxX - r);
      p.z = Math.min(Math.max(p.z, a.minZ + r), a.maxZ - r);
    }
  }

  private onClick = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!this.locked) this.target.requestPointerLock()?.catch?.(() => {});
  };

  private onLockChange = () => {
    this.skipMove = this.locked;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    if (this.skipMove || Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) {
      this.skipMove = false;
      return;
    }
    this.lookDx += e.movementX;
    this.lookDy += e.movementY;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || formControlFocused()) return;
    this.keys.add(e.code);
    if (e.code === 'KeyR' && !e.repeat) this.resetToSpawn();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
  };
}
