import { Group, type Object3D } from 'three';

// Assembles apartment facades from Poly Haven's modular_urban_apartments_facade kit. The kit lays its
// 3 m modules out as a catalogue: one column per module type, storey variants stacked 4 m apart.

export type ModuleType = 'blank' | 'large' | 'small' | 'double';

interface ModuleDef {
  catalogX: number;
  door: string[];        // ground-floor pieces with a door
  window: (storey: number) => string[];
  doorDado: string;
}

const MODULES: Record<Exclude<ModuleType, 'blank'>, ModuleDef> = {
  large: {
    catalogX: 8,
    door: ['wall_door_centered_large_01', 'door_centered_large_01'],
    window: (s) => [`wall_window_centered_large_0${s}`, `window_centered_large_0${s}`],
    doorDado: 'dado_door_centered_large_01',
  },
  small: {
    catalogX: 12,
    door: ['wall_door_centered_small_01', 'door_centered_small_01'],
    window: (s) => [`wall_window_centered_small_0${s}`, `window_centered_small_0${s}`],
    doorDado: 'dado_door_centered_small_01',
  },
  double: {
    catalogX: 16,
    door: ['wall_door_centered_small_02', 'door_centered_small_02'],
    window: (s) => [`wall_window_centered_double_0${s}`, `window_centered_double_0${s}`],
    doorDado: 'dado_door_centered_small_02',
  },
};

const BLANK_X = -3;
const MODULE_W = 3;
const STOREY_H = 3;

export interface Bay { type: ModuleType; door?: boolean }

/**
 * A facade of `bays` × 4 storeys, front at z = 0, running from x = 0 to bays.length × 3 m, with the
 * street at y = 0. Upper storeys use the kit's _01/_02/_03 window variants.
 */
export function buildFacade(kit: Object3D, bays: Bay[]): Group {
  kit.updateMatrixWorld(true);
  const facade = new Group();
  const add = (name: string, catalogX: number, catalogY: number, x: number, y: number) => {
    const src = kit.getObjectByName(name);
    if (!src) throw new Error(`Facade kit is missing ${name}`);
    const c = src.clone(true);
    c.applyMatrix4(src.parent!.matrixWorld);
    c.position.x += x - catalogX;
    c.position.y += y - catalogY;
    facade.add(c);
  };

  bays.forEach((bay, i) => {
    const x = i * MODULE_W;
    const def = bay.type === 'blank' ? null : MODULES[bay.type];
    // Ground floor and its plinth band.
    if (def && bay.door) {
      for (const n of def.door) add(n, def.catalogX, 0, x, 0);
      add(def.doorDado, def.catalogX, -1, x, 0);
    } else {
      add('wall_standard_standard_01', BLANK_X, 0, x, 0);
      add('dado_standard_standard_01', BLANK_X, -1, x, 0);
    }
    // Upper storeys, with a cornice band on each floor line.
    for (let s = 1; s <= 3; s++) {
      if (def) for (const n of def.window(s)) add(n, def.catalogX, 4 * s, x, STOREY_H * s);
      else add('wall_standard_standard_01', BLANK_X, 0, x, STOREY_H * s);
      add('cornice_standard_standard_01', BLANK_X, 3.4, x, STOREY_H * s - 0.1);
    }
    add('crown_standard_standard_01', BLANK_X, 4, x, STOREY_H * 4);
  });
  return facade;
}

export interface Opening {
  /** Centre of the module's opening area in facade coordinates (front at z = 0). */
  x: number;
  y: number;
  /** 0 = ground-floor door, 1–3 = window storeys. */
  storey: number;
}

/** Glazed openings of a facade from `buildFacade`: upper-storey windows and ground-floor doors. */
export function facadeOpenings(bays: Bay[]): Opening[] {
  const out: Opening[] = [];
  bays.forEach((bay, i) => {
    if (bay.type === 'blank') return;
    const x = i * MODULE_W + MODULE_W / 2;
    if (bay.door) out.push({ x, y: STOREY_H / 2, storey: 0 });
    for (let s = 1; s <= 3; s++) out.push({ x, y: STOREY_H * s + STOREY_H / 2, storey: s });
  });
  return out;
}
