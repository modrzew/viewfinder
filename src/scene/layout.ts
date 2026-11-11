import type { Bay } from './facade';
import type { Collider, Spawn, WalkArea } from './types';

// Courtyard layout (SPEC §11.2). Metres; +x right, −z forward from spawn, y up. Tuned by eye.

export const SPAWN: Spawn = { x: 0, z: 0, eyeHeightM: 1.2, yawDeg: 0, pitchDeg: -15 };

export const GROUND = { minX: -9, maxX: 9, minZ: -26, maxZ: 4 };
/** Cobblestones continue past the open west side to a quay edge, with the lagoon (HDRI) beyond. */
export const OUTER_GROUND = { minX: -30, maxX: 9, minZ: -60, maxZ: 30 };
export const WALK_AREA: WalkArea = { minX: -8.45, maxX: 8.85, minZ: -25.85, maxZ: 3.85 };

export const SOUTH_WALL = { z: 4, minX: -9, maxX: 9, height: 3.5, thickness: 0.3 };
/** Facade fronts. Bays are 3 m wide modules, listed left to right as seen from the courtyard. */
export const NORTH_FACADE = { z: -26, fromX: -21 };
export const EAST_FACADE = { x: 9, fromZ: -26 };
export const NORTH_BAYS: Bay[] = [
  { type: 'small', door: true }, { type: 'double' }, { type: 'large', door: true }, { type: 'blank' },
  { type: 'double', door: true }, { type: 'small' }, { type: 'large', door: true }, { type: 'double' },
  { type: 'small', door: true }, { type: 'large' },
];
export const EAST_BAYS: Bay[] = [
  { type: 'large' }, { type: 'double', door: true }, { type: 'small' }, { type: 'large', door: true },
  { type: 'blank' }, { type: 'double' }, { type: 'small', door: true }, { type: 'large' },
  { type: 'double', door: true }, { type: 'small' }, { type: 'blank' }, { type: 'large', door: true },
  { type: 'double' },
];

export interface Placement { x: number; z: number; rotYDeg: number }

export const HERO_TABLE: Placement = { x: 0, z: -0.7, rotYDeg: 90 };
export const TABLE_SETS: Placement[] = [
  { x: -3, z: -4, rotYDeg: 70 },
  { x: 3.5, z: -6, rotYDeg: 125 },
  { x: -2, z: -11, rotYDeg: 95 },
];
export const GALLINERA_TABLE: Placement = { x: 4, z: -12, rotYDeg: 8 };
export const GALLINERA_CHAIRS: Placement[] = [
  { x: 4.05, z: -11.35, rotYDeg: 180 },
  { x: 3.95, z: -12.7, rotYDeg: 0 },
];
export const COFFEE_CART: Placement = { x: 6.6, z: -3, rotYDeg: -90 };
export const WINE_BARREL: Placement = { x: -5, z: -7, rotYDeg: 20 };
export const BENCH: Placement = { x: 8.45, z: -9.5, rotYDeg: -90 };
/** Post lamps (street_lamp_01): the east one from the spec, and one between the gate and the planters. */
export const STREET_LAMPS: Placement[] = [
  { x: 5, z: -16, rotYDeg: 0 },
  { x: -8.15, z: -16.15, rotYDeg: 90 },
];

/**
 * Wall lanterns (street_lamp_02), on bay joints so they clear the doors and windows. Placement is the wall
 * point; rotYDeg turns the lantern's +z (away from the wall) into the courtyard.
 */
export const WALL_LANTERNS: Placement[] = [
  { x: -6, z: -26, rotYDeg: 0 },
  { x: 0, z: -26, rotYDeg: 0 },
  { x: 6, z: -26, rotYDeg: 0 },
  { x: 9, z: -20, rotYDeg: -90 },
  { x: 9, z: -11, rotYDeg: -90 },
  { x: 9, z: -2, rotYDeg: -90 },
  { x: -4.5, z: 4, rotYDeg: 180 },
  { x: 4.5, z: 4, rotYDeg: 180 },
];
/** Height of the wall lanterns' mounting point; their glass is at about 2.6–3.2 m. */
export const WALL_LANTERN_Y = 2.3;

/** Candle lanterns on the other tables, as offsets from the table centre (the hero table has its own). */
export const TABLE_LANTERNS: { table: 'set0' | 'set1' | 'set2' | 'gallinera'; dx: number; dz: number }[] = [
  { table: 'set0', dx: -0.05, dz: 0.2 },
  { table: 'set1', dx: 0.12, dz: -0.15 },
  { table: 'set2', dx: 0, dz: 0 },
  { table: 'gallinera', dx: 0.1, dz: 0 },
];

export const POTTED_PLANTS: (Placement & { model: 'potted_plant_01' | 'potted_plant_02' })[] = [
  { model: 'potted_plant_01', x: -1.3, z: -5.2, rotYDeg: 30 },
  { model: 'potted_plant_02', x: 4.9, z: -6.6, rotYDeg: 110 },
  { model: 'potted_plant_01', x: 8.4, z: -1.2, rotYDeg: 200 },
  { model: 'potted_plant_02', x: -0.6, z: -12.2, rotYDeg: 60 },
  { model: 'potted_plant_01', x: 8.3, z: -14.5, rotYDeg: 80 },
  { model: 'potted_plant_02', x: 2.6, z: -17.5, rotYDeg: 10 },
  { model: 'potted_plant_01', x: -6.5, z: -19, rotYDeg: 140 },
  { model: 'potted_plant_02', x: 7.8, z: 3.3, rotYDeg: 250 },
];

/** West side: planter boxes along x = −8.75, with a gap for the iron gate. */
export const PLANTER_X = -8.75;
export const PLANTER_ZS = [-0.6, -2.4, -4.2, -6, -7.8, -9.6, -11.4, -17, -18.8, -20.6, -22.4, -24.2];
export const GATE: Placement = { x: -8.85, z: -14.2, rotYDeg: 90 };

export const STRING_LIGHTS = {
  zs: [-3, -8, -13, -18],
  fromX: -8,
  toX: 8,
  endHeightM: 3.6,
  sagM: 0.5,
  bulbSpacingM: 0.5,
};

const RAD = Math.PI / 180;
const box = (p: Placement, halfW: number, halfD: number): Collider =>
  ({ kind: 'box', x: p.x, z: p.z, halfW, halfD, rotY: p.rotYDeg * RAD });

/** Circles and boxes for the player (§11.6); the walk area adds the courtyard bounds. */
export function courtyardColliders(): Collider[] {
  return [
    // Table sets: table plus a chair either side, along the set's local z.
    ...[HERO_TABLE, ...TABLE_SETS].map((p) => box(p, 0.38, 0.86)),
    box(GALLINERA_TABLE, 0.42, 0.26),
    ...GALLINERA_CHAIRS.map((p) => box(p, 0.29, 0.3)),
    box(COFFEE_CART, 1.1, 0.56),
    { kind: 'circle', x: WINE_BARREL.x, z: WINE_BARREL.z, r: 0.38 },
    box(BENCH, 0.6, 0.26),
    ...STREET_LAMPS.map((p): Collider => ({ kind: 'circle', x: p.x, z: p.z, r: 0.2 })),
    ...POTTED_PLANTS.map((p): Collider => ({ kind: 'circle', x: p.x, z: p.z, r: p.model === 'potted_plant_01' ? 0.28 : 0.3 })),
    ...PLANTER_ZS.map((z) => box({ x: PLANTER_X, z, rotYDeg: 90 }, 0.46, 0.21)),
    box(GATE, 1.5, 0.08),
  ];
}
