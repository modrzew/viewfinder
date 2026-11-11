import { Vector3, type PerspectiveCamera } from 'three';

// One sample of accumulation-buffer DoF (Haeberli & Akeley 1990; SPEC §10.3): the camera moves to a point
// on the aperture and its frustum is sheared so the plane at the focus distance stays fixed.

export interface ThinLens {
  focalM: number;
  apertureM: number;           // entrance pupil diameter A
  focusM: number;              // Infinity allowed
  tanHalfH: number;            // tan(hfov / 2)
  tanHalfV: number;            // tan(vfov / 2)
  near: number;
  far: number;
  widthPx: number;
  heightPx: number;
}

const right = new Vector3();
const up = new Vector3();

/** Effective aperture radius: makes the image blur equal b(d) exactly (→ A/2 at s = ∞). */
export function effectiveApertureRadiusM(l: ThinLens): number {
  const s = l.focusM;
  return Number.isFinite(s) ? ((l.apertureM / 2) * s) / (s - l.focalM) : l.apertureM / 2;
}

/**
 * Applies sample (ax, ay) on the unit-area aperture with pixel jitter (jx, jy) ∈ [−½, ½]. `basePosition`
 * is the centred camera position; orientation is left unchanged. Don't call updateProjectionMatrix()
 * afterwards: it would overwrite the sheared matrix.
 */
export function applyThinLensSample(
  camera: PerspectiveCamera,
  basePosition: Vector3,
  l: ThinLens,
  ax: number,
  ay: number,
  jx: number,
  jy: number,
): void {
  const r = effectiveApertureRadiusM(l);
  const u = r * ax;
  const v = r * ay;
  const invS = Number.isFinite(l.focusM) ? 1 / l.focusM : 0;
  const n = l.near;
  const { tanHalfH: tx, tanHalfV: ty } = l;

  const left = n * (-tx - u * invS) + jx * ((2 * n * tx) / l.widthPx);
  const rightEdge = n * (tx - u * invS) + jx * ((2 * n * tx) / l.widthPx);
  const bottom = n * (-ty - v * invS) + jy * ((2 * n * ty) / l.heightPx);
  const top = n * (ty - v * invS) + jy * ((2 * n * ty) / l.heightPx);

  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.position.copy(basePosition).addScaledVector(right, u).addScaledVector(up, v);
  camera.updateMatrixWorld();

  camera.projectionMatrix.makePerspective(left, rightEdge, top, bottom, n, l.far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
