import { BufferGeometry, Mesh, Raycaster, Vector3, type Camera, type Object3D } from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { CONFIG } from '../config';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

/** Centre-distance readout: planar depth of whatever the centre ray hits (§10.7). */
export class Rangefinder {
  private readonly raycaster = new Raycaster();
  private readonly dir = new Vector3();
  private readonly origin = new Vector3();
  private readonly geometries: BufferGeometry[] = [];

  private readonly root: Object3D;

  constructor(root: Object3D) {
    this.root = root;
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && mesh.geometry && !mesh.geometry.boundsTree) {
        mesh.geometry.computeBoundsTree();
        this.geometries.push(mesh.geometry);
      }
    });
    this.raycaster.firstHitOnly = true;
    this.raycaster.far = CONFIG.farM;
  }

  /** Returns metres along the view axis, or null for sky. */
  measure(camera: Camera): number | null {
    camera.getWorldPosition(this.origin);
    camera.getWorldDirection(this.dir);
    this.raycaster.set(this.origin, this.dir);
    const hits = this.raycaster.intersectObject(this.root, true);
    const hit = hits.find((h) => h.object.visible && !h.object.userData.noRangefinder);
    if (!hit) return null;
    return hit.point.sub(this.origin).dot(this.dir);
  }

  dispose(): void {
    for (const g of this.geometries) g.disposeBoundsTree();
  }
}
