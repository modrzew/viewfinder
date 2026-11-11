import type { Scene } from 'three';

/** Colliders on the ground plane (x, z in metres). Boxes may be rotated about y. */
export type Collider =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'box'; x: number; z: number; halfW: number; halfD: number; rotY?: number };

export interface WalkArea { minX: number; maxX: number; minZ: number; maxZ: number }

export interface Spawn { x: number; z: number; eyeHeightM: number; yawDeg: number; pitchDeg: number }

export interface SceneSetup {
  id: 'test' | 'courtyard';
  scene: Scene;
  spawn: Spawn;
  colliders: Collider[];
  walkArea: WalkArea;
  /** Scene brightness at ISO 100 (§8.5). */
  ev100: number;
  /** Linear exposure multiplier applied by LensPass (§10.6). */
  baseExposure: number;
  dispose(): void;
}
