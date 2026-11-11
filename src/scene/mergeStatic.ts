import { BufferAttribute, BufferGeometry, Mesh, type Material, type Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Refinement renders the whole scene hundreds of times, so draw calls matter: bake static meshes that share
// a material into one mesh each.

const ATTRIBUTES = ['position', 'normal', 'uv'];

/** Float copy (quantised glTF attributes don't survive applyMatrix4) with world transform applied. */
function bakedGeometry(mesh: Mesh): BufferGeometry | null {
  const src = mesh.geometry;
  const out = new BufferGeometry();
  for (const name of ATTRIBUTES) {
    const a = src.getAttribute(name);
    if (!a) return null;
    const n = a.itemSize;
    const arr = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) {
      arr[i * n] = a.getX(i);
      if (n > 1) arr[i * n + 1] = a.getY(i);
      if (n > 2) arr[i * n + 2] = a.getZ(i);
    }
    out.setAttribute(name, new BufferAttribute(arr, n));
  }
  const count = src.getAttribute('position').count;
  const index = src.index ? Array.from(src.index.array) : Array.from({ length: count }, (_, i) => i);
  out.setIndex(index);
  out.applyMatrix4(mesh.matrixWorld);
  return out;
}

/**
 * Merges meshes under `root` (which must have an identity world transform) that share a material.
 * `keep` excludes meshes that must stay separate.
 */
export function mergeStaticMeshes(root: Object3D, keep: (m: Mesh) => boolean): { before: number; after: number } {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<Material, Mesh[]>();
  let before = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    before++;
    if ((m as { isInstancedMesh?: boolean }).isInstancedMesh || Array.isArray(m.material) || keep(m)) return;
    const list = byMaterial.get(m.material as Material) ?? [];
    list.push(m);
    byMaterial.set(m.material as Material, list);
  });

  let merged = 0;
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const geos = meshes.map(bakedGeometry);
    if (geos.some((g) => !g)) continue;
    const geometry = mergeGeometries(geos as BufferGeometry[], false);
    for (const g of geos) g!.dispose();
    if (!geometry) continue;
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = meshes.some((m) => m.castShadow);
    mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
    mesh.name = `merged:${material.name}`;
    root.add(mesh);
    for (const m of meshes) m.removeFromParent();
    merged += meshes.length - 1;
  }
  return { before, after: before - merged };
}
