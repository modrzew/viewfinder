import type { Scene } from 'three';
import type { TimeOfDay } from './timeOfDay';

/** Colliders on the ground plane (x, z in metres). Boxes may be rotated about y. */
export type Collider =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'box'; x: number; z: number; halfW: number; halfD: number; rotY?: number };

export interface WalkArea { minX: number; maxX: number; minZ: number; maxZ: number }

export interface Spawn { x: number; z: number; eyeHeightM: number; yawDeg: number; pitchDeg: number }

export interface Lighting {
  /** Scene brightness at ISO 100 (§8.5). */
  ev100: number;
  /** Linear exposure multiplier applied by LensPass (§10.6). */
  baseExposure: number;
}

/** Switches a scene between times of day. */
export interface TimeOfDayControl {
  /** The time of day the scene was built with. */
  initial: TimeOfDay;
  /** Downloads what `t` needs (its sky) without touching the scene. */
  load(t: TimeOfDay, onProgress: (loadedBytes: number, totalBytes: number) => void): Promise<void>;
  /** Relights the scene for `t`, which must have loaded. Shadow maps need a re-render afterwards. */
  apply(t: TimeOfDay): Lighting;
}

export interface SceneSetup {
  id: 'test' | 'courtyard';
  scene: Scene;
  spawn: Spawn;
  colliders: Collider[];
  walkArea: WalkArea;
  /** Lighting as built. */
  lighting: Lighting;
  timeOfDay?: TimeOfDayControl;
  dispose(): void;
}
