import {
  Box3, BoxGeometry, CanvasTexture, Color, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, RepeatWrapping, Scene, SphereGeometry, Vector3, type BufferGeometry, type Material, type Object3D,
  type Texture, type WebGLRenderer,
} from 'three';
import {
  BENCH, COFFEE_CART, EAST_BAYS, EAST_FACADE, GALLINERA_CHAIRS, GALLINERA_TABLE, GATE, HERO_TABLE, NORTH_BAYS, NORTH_FACADE,
  OUTER_GROUND, PLANTER_X, PLANTER_ZS, POTTED_PLANTS, SOUTH_WALL, SPAWN, STREET_LAMPS, STRING_LIGHTS, TABLE_LANTERNS,
  TABLE_SETS, WALK_AREA, WALL_LANTERNS, WALL_LANTERN_Y, WINE_BARREL, courtyardColliders, type Placement,
} from './layout';
import { loadCourtyardAssets, type PbrTextures } from './loadAssets';
import { buildFacade, facadeOpenings, type Bay } from './facade';
import { LAMPS, PRESETS, createCourtyardLighting } from './courtyardLighting';
import { mergeStaticMeshes } from './mergeStatic';
import { buildStringLights } from './stringLights';
import type { TimeOfDay } from './timeOfDay';
import type { SceneSetup } from './types';

// Café courtyard (SPEC §11): golden hour by default, relit for other times of day by courtyardLighting.ts.

const RAD = Math.PI / 180;

const MODELS = [
  'outdoor_table_chair_set_01', 'tea_set_01', 'croissant', 'potted_plant_04', 'Lantern_01', 'ceramic_vase_01',
  'wine_bottles_01', 'gallinera_table', 'gallinera_chair', 'potted_plant_01', 'potted_plant_02', 'planter_box_01',
  'shrub_03', 'flower_gazania', 'CoffeeCart_01', 'street_lamp_01', 'street_lamp_02', 'painted_wooden_bench',
  'wine_barrel_01', 'large_iron_gate', 'modular_urban_apartments_facade',
];
const TEXTURES = ['cobblestone_floor_06', 'clay_plaster'];

/** Lit curtain seen through a window at night: brighter towards the top, with soft vertical folds. */
function curtainTexture(): CanvasTexture {
  const w = 64;
  const h = 64;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (0.55 + 0.45 * (1 - y / h)) * (0.82 + 0.18 * Math.cos((x / w) * Math.PI * 14));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new CanvasTexture(cv);
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

function findMaterial(model: Object3D, name: string): Material {
  let found: Material | undefined;
  model.traverse((o) => {
    const m = (o as Mesh).material as Material | undefined;
    if (m?.name === name) found = m;
  });
  if (!found) throw new Error(`Missing material ${name}`);
  return found;
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

export async function buildCourtyard(
  renderer: WebGLRenderer,
  debug: boolean,
  timeOfDay: TimeOfDay,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
): Promise<SceneSetup> {
  const t0 = performance.now();
  const assets = await loadCourtyardAssets(MODELS, TEXTURES, PRESETS[timeOfDay].sky.file, onProgress);
  const M = assets.models;
  const t1 = performance.now();
  const disposables: (BufferGeometry | Material | Texture)[] = [];
  const scene = new Scene();
  const root = new Group();
  scene.add(root);

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
  // Lit windows (evening and night) are glow planes just behind the glass, one instance per opening.
  const glowGeo = new PlaneGeometry(2.8, 2.9);
  const glowTex = curtainTexture();
  const glowMat = new MeshBasicMaterial({ map: glowTex });
  disposables.push(glowGeo, glowTex, glowMat);
  const windows: { mesh: InstancedMesh; storeys: number[] }[] = [];
  const building = (bays: Bay[]) => {
    const g = buildFacade(kit, bays);
    const w = bays.length * 3;
    const geo = new PlaneGeometry(w, 12);
    disposables.push(geo);
    const interior = new Mesh(geo, interiorMat);
    interior.position.set(w / 2, 6, -0.7);
    g.add(interior);
    const openings = facadeOpenings(bays);
    const glow = new InstancedMesh(glowGeo, glowMat, openings.length);
    openings.forEach((o, i) => {
      glow.setMatrixAt(i, new Matrix4().makeTranslation(o.x, o.y, -0.3));
      glow.setColorAt(i, new Color(0, 0, 0));
    });
    glow.userData.noRangefinder = true;
    g.add(glow);
    windows.push({ mesh: glow, storeys: openings.map((o) => o.storey) });
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

  const gallinera = place(grounded(M.gallinera_table), GALLINERA_TABLE);
  root.add(gallinera);
  for (const p of GALLINERA_CHAIRS) root.add(place(grounded(M.gallinera_chair), p));
  root.add(place(grounded(M.CoffeeCart_01), COFFEE_CART));
  const barrel = place(grounded(M.wine_barrel_01), WINE_BARREL);
  root.add(barrel);
  root.add(place(grounded(M.painted_wooden_bench), BENCH));
  const streetLamp = grounded(M.street_lamp_01);
  const streetLamps = STREET_LAMPS.map((p) => place(streetLamp.clone(true), p));
  root.add(...streetLamps);
  // Wall lanterns hang from their wall plate (the model's origin), nudged off the wall.
  const wallLanterns = WALL_LANTERNS.map((p) => {
    const g = new Group();
    const c = M.street_lamp_02.clone(true);
    c.position.z = 0.01;
    g.add(c);
    return place(g, p, WALL_LANTERN_Y);
  });
  root.add(...wallLanterns);
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
  // Candle lanterns on the other tables.
  const gallineraTop = height(gallinera);
  const tables = { set0: TABLE_SETS[0], set1: TABLE_SETS[1], set2: TABLE_SETS[2], gallinera: GALLINERA_TABLE };
  const lanterns = [lantern];
  TABLE_LANTERNS.forEach((l, i) => {
    const t = tables[l.table];
    const obj = lantern.clone(true);
    on(obj, t.x + l.dx, t.z + l.dz, 40 + i * 70, l.table === 'gallinera' ? gallineraTop : tableTop);
    lanterns.push(obj);
  });

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
  const bulbEmissive = LAMPS.bulbColor.clone().multiplyScalar(LAMPS.bulbIntensity);
  const lights = buildStringLights({
    strands: STRING_LIGHTS.zs.map((z) => ({
      z, fromX: STRING_LIGHTS.fromX, toX: STRING_LIGHTS.toX, endHeightM: STRING_LIGHTS.endHeightM, sagM: STRING_LIGHTS.sagM,
    })),
    bulbSpacingM: STRING_LIGHTS.bulbSpacingM,
    bulbEmissive,
    lightsPerStrand: LAMPS.festoonLightsPerStrand,
  });
  root.add(lights.group);

  // --- Candle flames -----------------------------------------------------------------------------------------
  const flameGeo = new SphereGeometry(0.008, 8, 6);
  flameGeo.scale(1, 1.8, 1);
  const flameMat = new MeshBasicMaterial({ color: LAMPS.bulbColor.clone().multiplyScalar(LAMPS.bulbIntensity * 0.5) });
  disposables.push(flameGeo, flameMat);
  for (const l of lanterns) {
    const flame = new Mesh(flameGeo, flameMat);
    flame.position.set(0, 0.095, 0);
    l.add(flame);
  }

  // --- Material fix-ups -------------------------------------------------------------------------------------
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const glass = /glass/i.test((mesh.material as Material).name ?? '');
    mesh.castShadow = !glass && mesh.material !== flameMat && mesh.material !== glowMat && !o.parent?.name.startsWith('stringLights');
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
  lights.group.traverse((o) => {
    o.castShadow = false;
  });

  // --- Lighting ----------------------------------------------------------------------------------------------
  // Light sources sit in the middle of each lamp's glass; flames are where the meshes are.
  root.updateMatrixWorld(true);
  const lampGlass = new Set<MeshStandardMaterial>();
  const glassCentre = (lamp: Object3D) => {
    const box = new Box3();
    lamp.traverse((o) => {
      const m = (o as Mesh).material as MeshStandardMaterial | undefined;
      if (m && /glass/i.test(m.name)) {
        box.expandByObject(o);
        lampGlass.add(m);
      }
    });
    return box.getCenter(new Vector3());
  };
  const candles = lanterns.map((l) => l.children.find((c) => (c as Mesh).material === flameMat)!.getWorldPosition(new Vector3()));
  const lighting = createCourtyardLighting({
    renderer,
    scene,
    root,
    initial: timeOfDay,
    initialHdri: assets.hdri,
    bulbs: lights.bulbs,
    festoonLights: lights.lightPositions,
    streetLamps: streetLamps.map(glassCentre),
    wallLanterns: wallLanterns.map(glassCentre),
    candles,
    lampGlass: [...lampGlass],
    flame: flameMat,
    windows,
    windowGlass: findMaterial(kit, 'modular_urban_apartments_facade_glass'),
    interior: interiorMat,
    debug,
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
    lighting: lighting.apply(timeOfDay),
    timeOfDay: lighting,
    dispose() {
      lighting.dispose();
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
