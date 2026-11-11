import {
  Box3, BoxGeometry, Color, DirectionalLight, EquirectangularReflectionMapping, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PCFShadowMap, PlaneGeometry, PMREMGenerator, PointLight, RepeatWrapping, Scene,
  SphereGeometry, Vector3, type BufferGeometry, type DataTexture, type Material, type Object3D, type Texture,
  type WebGLRenderer,
} from 'three';
import { useStore } from '../state/store';
import {
  BENCH, COFFEE_CART, EAST_BAYS, EAST_FACADE, GALLINERA_CHAIRS, GALLINERA_TABLE, GATE, HERO_TABLE, NORTH_BAYS, NORTH_FACADE,
  OUTER_GROUND, PLANTER_X, PLANTER_ZS, POTTED_PLANTS, SOUTH_WALL, SPAWN, STREET_LAMP, STRING_LIGHTS, TABLE_SETS,
  WALK_AREA, WINE_BARREL, courtyardColliders, type Placement,
} from './layout';
import { loadCourtyardAssets, type PbrTextures } from './loadAssets';
import { buildFacade, type Bay } from './facade';
import { mergeStaticMeshes } from './mergeStatic';
import { buildStringLights } from './stringLights';
import type { SceneSetup } from './types';

// Golden-hour café courtyard (SPEC §11).

const RAD = Math.PI / 180;

/** Scene constants (§11.4). */
export const COURTYARD = {
  ev100: 12,
  baseExposure: 1.3,
  hdri: 'venice_sunset_4k.hdr',
  /** Brightest HDRI texel (`?debug=1` logs it): equirect u and elevation. */
  hdriSun: { u: 0.5997, elevationDeg: 3.4 },
  /** Where the sun should sit: degrees left of the spawn view (−z). */
  sunAzimuthLeftDeg: 70,
  sunColor: new Color(1.0, 0.72, 0.46),
  sunIntensity: 7,
  envIntensity: 0.5,
  /**
   * ~2700 K. SPEC §11.4 suggests 20–50× scene mid-grey, but spread over a 100+ px disc that gives dull
   * beige bokeh; real filament bulbs are far brighter, so they sit at ~200× shaded mid-grey.
   */
  bulbColor: new Color(1.0, 0.45, 0.13),
  bulbIntensity: 40,
  lanternIntensity: 0.6,
  lampIntensity: 14,
};

const MODELS = [
  'outdoor_table_chair_set_01', 'tea_set_01', 'croissant', 'potted_plant_04', 'Lantern_01', 'ceramic_vase_01',
  'wine_bottles_01', 'gallinera_table', 'gallinera_chair', 'potted_plant_01', 'potted_plant_02', 'planter_box_01',
  'shrub_03', 'flower_gazania', 'CoffeeCart_01', 'street_lamp_01', 'painted_wooden_bench', 'wine_barrel_01',
  'large_iron_gate', 'modular_urban_apartments_facade',
];
const TEXTURES = ['cobblestone_floor_06', 'clay_plaster'];

/** Direction (three.js equirect convention) of texel (u, elevation), after rotating the HDRI by rotY. */
function hdriDirection(u: number, elevationDeg: number, rotY: number): Vector3 {
  const phi = (u - 0.5) * 2 * Math.PI - rotY;
  const el = elevationDeg * RAD;
  return new Vector3(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi));
}

/** Dev helper: logs the brightest HDRI texel as (u, elevation). */
function logHdriSun(tex: DataTexture): void {
  const { data, width, height } = tex.image as { data: Uint16Array; width: number; height: number };
  const half = (v: number) => {
    const e = (v >> 10) & 31;
    const m = v & 1023;
    return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
  };
  let best = 0;
  let bi = 0;
  for (let i = 0; i < width * height; i++) {
    const l = half(data[i * 4]) + half(data[i * 4 + 1]) + half(data[i * 4 + 2]);
    if (l > best) {
      best = l;
      bi = i;
    }
  }
  const u = ((bi % width) + 0.5) / width;
  const v = (Math.floor(bi / width) + 0.5) / height;
  // Row 0 is the top of the image in the file; flipY puts it at v = 1.
  console.info(`[courtyard] brightest HDRI texel: u ${u.toFixed(4)}, elevation ${((0.5 - v) * 180).toFixed(2)}°`);
}

/** Clone of `obj` re-centred so its bounding box sits on y = 0, centred on x/z (or on `anchor`'s box). */
function grounded(obj: Object3D, anchor?: Object3D): Group {
  const g = new Group();
  const c = obj.clone(true);
  g.add(c);
  g.updateMatrixWorld(true);
  const box = new Box3().setFromObject(g);
  const ref = anchor ? new Box3().setFromObject(c.getObjectByName(anchor.name) ?? c) : box;
  const centre = ref.getCenter(new Vector3());
  c.position.x -= centre.x;
  c.position.z -= centre.z;
  c.position.y -= box.min.y;
  return g;
}

/** Named parts of a model, grounded together as one object (e.g. teapot + lid). */
function parts(model: Object3D, names: string[]): Group {
  const g = new Group();
  for (const n of names) {
    const p = model.getObjectByName(n);
    if (!p) throw new Error(`Missing part ${n}`);
    const c = p.clone(true);
    p.parent?.updateWorldMatrix(true, false);
    c.applyMatrix4(p.parent!.matrixWorld);
    g.add(c);
  }
  return grounded(g);
}

function place<T extends Object3D>(obj: T, p: Placement, y = 0): T {
  obj.position.set(p.x, y, p.z);
  obj.rotation.y = p.rotYDeg * RAD;
  return obj;
}

function height(obj: Object3D): number {
  obj.updateWorldMatrix(true, true);
  return new Box3().setFromObject(obj).max.y;
}

function pbrMaterial(t: PbrTextures, repeatX: number, repeatY: number, disposables: { dispose(): void }[]): MeshStandardMaterial {
  const maps = [t.diff, t.nor, t.arm].map((src) => {
    const tex = src.clone();
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.anisotropy = 16;
    tex.needsUpdate = true;
    disposables.push(tex);
    return tex;
  });
  const m = new MeshStandardMaterial({
    map: maps[0],
    normalMap: maps[1],
    aoMap: maps[2],
    roughnessMap: maps[2],
    metalnessMap: maps[2],
    metalness: 1,
    roughness: 1,
  });
  disposables.push(m);
  return m;
}

export async function buildCourtyard(renderer: WebGLRenderer, debug: boolean): Promise<SceneSetup> {
  const setRuntime = useStore.getState().setRuntime;
  const t0 = performance.now();
  const assets = await loadCourtyardAssets(MODELS, TEXTURES, COURTYARD.hdri, (loadedBytes, totalBytes) =>
    setRuntime({ loading: { loadedBytes, totalBytes } }),
  );
  const M = assets.models;
  const t1 = performance.now();
  const disposables: (BufferGeometry | Material | Texture)[] = [];
  const scene = new Scene();
  const root = new Group();
  scene.add(root);

  // --- Sky and image-based light ---------------------------------------------------------------------------
  const hdri = assets.hdri;
  hdri.mapping = EquirectangularReflectionMapping;
  if (debug) logHdriSun(hdri);
  const wantPhi = Math.atan2(-Math.cos(COURTYARD.sunAzimuthLeftDeg * RAD), -Math.sin(COURTYARD.sunAzimuthLeftDeg * RAD));
  const rotY = (COURTYARD.hdriSun.u - 0.5) * 2 * Math.PI - wantPhi;
  const pmrem = new PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(hdri);
  pmrem.dispose();
  scene.background = hdri;
  scene.environment = envRT.texture;
  scene.backgroundRotation.set(0, rotY, 0);
  scene.environmentRotation.set(0, rotY, 0);
  scene.environmentIntensity = COURTYARD.envIntensity;
  disposables.push(hdri);

  // --- Sun -------------------------------------------------------------------------------------------------
  renderer.shadowMap.type = PCFShadowMap;
  const sunDir = hdriDirection(COURTYARD.hdriSun.u, COURTYARD.hdriSun.elevationDeg, rotY);
  const sun = new DirectionalLight(COURTYARD.sunColor, COURTYARD.sunIntensity);
  const centre = new Vector3(0, 0, -11);
  sun.target.position.copy(centre);
  sun.position.copy(centre).addScaledVector(sunDir, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const cam = sun.shadow.camera;
  cam.left = -24;
  cam.right = 24;
  cam.top = 18;
  cam.bottom = -3;
  cam.near = 20;
  cam.far = 110;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // --- Ground and walls ------------------------------------------------------------------------------------
  const cobble = assets.textures.cobblestone_floor_06;
  {
    const g = OUTER_GROUND;
    const w = g.maxX - g.minX;
    const d = g.maxZ - g.minZ;
    const geo = new PlaneGeometry(w, d);
    const mesh = new Mesh(geo, pbrMaterial(cobble, w / 2, d / 2, disposables));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((g.minX + g.maxX) / 2, 0, (g.minZ + g.maxZ) / 2);
    mesh.receiveShadow = true;
    root.add(mesh);
    disposables.push(geo);
  }
  {
    const w = SOUTH_WALL.maxX - SOUTH_WALL.minX;
    const geo = new BoxGeometry(w, SOUTH_WALL.height, SOUTH_WALL.thickness);
    const mesh = new Mesh(geo, pbrMaterial(assets.textures.clay_plaster, w / 2, SOUTH_WALL.height / 2, disposables));
    mesh.position.set(0, SOUTH_WALL.height / 2, SOUTH_WALL.z + SOUTH_WALL.thickness / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    disposables.push(geo);
  }

  // Apartment facades assembled from the modular kit, with a dark interior behind the window openings.
  const kit = M.modular_urban_apartments_facade;
  const interiorMat = new MeshStandardMaterial({ color: 0x17130f, roughness: 0.9 });
  disposables.push(interiorMat);
  const building = (bays: Bay[]) => {
    const g = buildFacade(kit, bays);
    const w = bays.length * 3;
    const geo = new PlaneGeometry(w, 12);
    disposables.push(geo);
    const interior = new Mesh(geo, interiorMat);
    interior.position.set(w / 2, 6, -0.7);
    g.add(interior);
    return g;
  };
  const north = building(NORTH_BAYS);
  north.position.set(NORTH_FACADE.fromX, 0, NORTH_FACADE.z);
  const east = building(EAST_BAYS);
  east.rotation.y = -Math.PI / 2;
  east.position.set(EAST_FACADE.x, 0, EAST_FACADE.fromZ);
  root.add(north, east);

  // --- Furniture -------------------------------------------------------------------------------------------
  const tableAnchor = M.outdoor_table_chair_set_01.getObjectByName('outdoor_table_chair_set_01_table')!;
  const tableSet = grounded(M.outdoor_table_chair_set_01, tableAnchor);
  const hero = place(tableSet.clone(true), HERO_TABLE);
  root.add(hero);
  for (const p of TABLE_SETS) root.add(place(tableSet.clone(true), p));
  const tableTop = height(tableSet.getObjectByName('outdoor_table_chair_set_01_table')!);

  root.add(place(grounded(M.gallinera_table), GALLINERA_TABLE));
  for (const p of GALLINERA_CHAIRS) root.add(place(grounded(M.gallinera_chair), p));
  root.add(place(grounded(M.CoffeeCart_01), COFFEE_CART));
  const barrel = place(grounded(M.wine_barrel_01), WINE_BARREL);
  root.add(barrel);
  root.add(place(grounded(M.painted_wooden_bench), BENCH));
  const lamp = place(grounded(M.street_lamp_01), STREET_LAMP);
  root.add(lamp);
  for (const p of POTTED_PLANTS) root.add(place(grounded(M[p.model]), p));

  // --- Hero table props, 0.5–1.0 m from the spawn eye --------------------------------------------------------
  const tea = M.tea_set_01;
  const on = (obj: Group, x: number, z: number, rotYDeg = 0, y = tableTop) => root.add(place(obj, { x, z, rotYDeg }, y));
  const lantern = grounded(M.Lantern_01);
  on(lantern, 0.13, -0.97, 15);
  on(grounded(M.ceramic_vase_01), -0.2, -0.98, 0);
  on(parts(tea, ['tea_set_01_teapot_01', 'tea_set_01_teapot_01_lid']), -0.19, -0.66, -35);
  on(parts(tea, ['tea_set_01_sugar_cup_01', 'tea_set_01_sugar_cup_01_lid']), 0.02, -0.86, 0);
  const plate = parts(tea, ['tea_set_01_plate_large_circular_03']);
  on(plate, 0.14, -0.62, 0);
  on(grounded(M.croissant), 0.14, -0.62, 30, tableTop + 0.012);
  on(parts(tea, ['tea_set_01_saucer_circular_04']), -0.08, -0.45, 0);
  on(parts(tea, ['tea_set_01_cup_small_01']), -0.08, -0.45, 120, tableTop + 0.012);
  on(grounded(M.potted_plant_04), 0.28, -0.82, 40);

  // Props elsewhere: bottles on the barrel, cups on another table.
  const bottles = grounded(M.wine_bottles_01);
  root.add(place(bottles, { x: WINE_BARREL.x, z: WINE_BARREL.z, rotYDeg: 35 }, height(barrel)));
  {
    const p = TABLE_SETS[0];
    on(parts(tea, ['tea_set_01_saucer_circular_03']), p.x + 0.1, p.z + 0.05, 0);
    on(parts(tea, ['tea_set_01_cup_small_02']), p.x + 0.1, p.z + 0.05, 200, tableTop + 0.012);
    on(grounded(M.potted_plant_04), p.x - 0.12, p.z - 0.1, 0);
  }
  on(grounded(M.ceramic_vase_01), TABLE_SETS[1].x, TABLE_SETS[1].z, 0);

  // --- West side: planters with shrubs and flowers, and the gate ---------------------------------------------
  const planter = grounded(M.planter_box_01);
  const planterTop = height(planter) - 0.05;
  const shrubs = ['shrub_03_a', 'shrub_03_b', 'shrub_03_c', 'shrub_03_d'].map((n) => parts(M.shrub_03, [n]));
  const flowers = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => parts(M.flower_gazania, [`flower_gazania_${n}_LOD0`]));
  // Soil fills each box up to just under the rim.
  const soilMat = new MeshStandardMaterial({ color: 0x2b2017, roughness: 1 });
  const soilGeo = new BoxGeometry(0.8, 0.02, 0.3);
  disposables.push(soilMat, soilGeo);
  PLANTER_ZS.forEach((z, i) => {
    root.add(place(planter.clone(true), { x: PLANTER_X, z, rotYDeg: 90 }));
    const soil = place(new Mesh(soilGeo, soilMat), { x: PLANTER_X, z, rotYDeg: 90 }, planterTop - 0.01);
    root.add(soil);
    const plant = (obj: Group, dx: number, dz: number, rot: number) =>
      root.add(place(obj.clone(true), { x: PLANTER_X + dx, z: z + dz, rotYDeg: rot }, planterTop));
    plant(shrubs[i % 4], 0.04, -0.28, i * 47);
    plant(shrubs[(i + 1) % 4], -0.06, -0.05, i * 61 + 20);
    plant(shrubs[(i + 2) % 4], 0.05, 0.25, i * 83);
    plant(flowers[i % 8], -0.03, 0.1, i * 29);
    plant(flowers[(i + 3) % 8], 0.02, -0.18, i * 37 + 90);
  });
  root.add(place(grounded(M.large_iron_gate), GATE));

  // --- String lights ---------------------------------------------------------------------------------------
  const bulbEmissive = COURTYARD.bulbColor.clone().multiplyScalar(COURTYARD.bulbIntensity);
  const lights = buildStringLights({
    strands: STRING_LIGHTS.zs.map((z) => ({
      z, fromX: STRING_LIGHTS.fromX, toX: STRING_LIGHTS.toX, endHeightM: STRING_LIGHTS.endHeightM, sagM: STRING_LIGHTS.sagM,
    })),
    bulbSpacingM: STRING_LIGHTS.bulbSpacingM,
    bulbEmissive,
  });
  root.add(lights.group);

  // --- Lantern and street lamp ------------------------------------------------------------------------------
  const flameGeo = new SphereGeometry(0.008, 8, 6);
  flameGeo.scale(1, 1.8, 1);
  const flameMat = new MeshBasicMaterial({ color: COURTYARD.bulbColor.clone().multiplyScalar(COURTYARD.bulbIntensity * 0.5) });
  disposables.push(flameGeo, flameMat);
  const flame = new Mesh(flameGeo, flameMat);
  flame.position.set(0, 0.095, 0);
  lantern.add(flame);
  const lanternLight = new PointLight(0xffa04a, COURTYARD.lanternIntensity, 0, 2);
  lanternLight.position.set(0, 0.1, 0);
  lantern.add(lanternLight);

  // --- Material fix-ups -------------------------------------------------------------------------------------
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const glass = /glass/i.test((mesh.material as Material).name ?? '');
    mesh.castShadow = !glass && mesh !== flame && !o.parent?.name.startsWith('stringLights');
    mesh.receiveShadow = true;
    const m = mesh.material as MeshStandardMaterial & { transmission?: number };
    // Transmission needs an extra scene render per sample; plain alpha blending is close enough here.
    if (m.transmission) {
      m.transmission = 0;
      m.transparent = true;
      m.opacity = Math.min(m.opacity, 0.35);
    }
    // Clear lantern glass: mostly see-through, with reflections.
    if (m.name === 'Lantern_01_glass') {
      m.map = null;
      m.color.set(0xffffff);
      m.opacity = 0.12;
      m.roughness = 0.05;
      m.metalness = 0;
      m.depthWrite = false;
    }
    if (m.map) m.map.anisotropy = 8;
  });
  lamp.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | undefined;
    if (m && /glass/i.test(m.name)) {
      m.emissive = new Color(1.0, 0.62, 0.3);
      m.emissiveIntensity = COURTYARD.lampIntensity;
      m.transparent = false;
      m.opacity = 1;
    }
  });
  lights.group.traverse((o) => {
    o.castShadow = false;
  });

  const merge = mergeStaticMeshes(root, () => false);
  if (debug) {
    const t2 = performance.now();
    console.info(`[courtyard] meshes: ${merge.before} → ${merge.after} after merging`);
    console.info(`[courtyard] assets ${((t1 - t0) / 1000).toFixed(1)} s, build ${((t2 - t1) / 1000).toFixed(1)} s`);
  }

  return {
    id: 'courtyard',
    scene,
    spawn: SPAWN,
    colliders: courtyardColliders(),
    walkArea: WALK_AREA,
    ev100: COURTYARD.ev100,
    baseExposure: COURTYARD.baseExposure,
    dispose() {
      envRT.dispose();
      lights.dispose();
      for (const d of disposables) d.dispose();
      for (const m of Object.values(assets.models)) {
        m.traverse((o) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            for (const v of Object.values(mat)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
            mat.dispose();
          }
        });
      }
      for (const t of Object.values(assets.textures)) for (const x of Object.values(t)) x.dispose();
    },
  };
}
