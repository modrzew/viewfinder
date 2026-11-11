// Poly Haven assets for the courtyard (SPEC §11.3). All CC0.

export type AssetKind = 'model' | 'texture' | 'hdri';
export type Res = '1k' | '2k' | '4k';

export interface AssetEntry {
  id: string;
  kind: AssetKind;
  res: Res;
  /** Keep named parts as separate nodes (e.g. tea set pieces), so the scene can arrange them. */
  keepParts?: boolean;
}

export const ASSETS: AssetEntry[] = [
  { id: 'outdoor_table_chair_set_01', kind: 'model', res: '2k' },
  { id: 'tea_set_01', kind: 'model', res: '2k', keepParts: true },
  { id: 'croissant', kind: 'model', res: '2k' },
  { id: 'potted_plant_04', kind: 'model', res: '2k' },
  { id: 'Lantern_01', kind: 'model', res: '2k' },
  { id: 'ceramic_vase_01', kind: 'model', res: '2k' },
  { id: 'wine_bottles_01', kind: 'model', res: '1k' },
  { id: 'gallinera_table', kind: 'model', res: '1k' },
  { id: 'gallinera_chair', kind: 'model', res: '1k' },
  { id: 'potted_plant_01', kind: 'model', res: '1k' },
  { id: 'potted_plant_02', kind: 'model', res: '1k' },
  { id: 'planter_box_01', kind: 'model', res: '1k' },
  { id: 'shrub_03', kind: 'model', res: '1k', keepParts: true },
  { id: 'flower_gazania', kind: 'model', res: '1k', keepParts: true },
  { id: 'CoffeeCart_01', kind: 'model', res: '1k' },
  { id: 'street_lamp_01', kind: 'model', res: '1k' },
  { id: 'street_lamp_02', kind: 'model', res: '1k' },
  { id: 'painted_wooden_bench', kind: 'model', res: '1k' },
  { id: 'wine_barrel_01', kind: 'model', res: '1k' },
  { id: 'large_iron_gate', kind: 'model', res: '1k', keepParts: true },
  { id: 'modular_urban_apartments_facade', kind: 'model', res: '1k', keepParts: true },
  { id: 'cobblestone_floor_06', kind: 'texture', res: '2k' },
  { id: 'clay_plaster', kind: 'texture', res: '1k' },
  { id: 'venice_sunset', kind: 'hdri', res: '4k' },
  // Other times of day load on demand. Pure skies at 2k keep public/scene/ under budget (§12).
  { id: 'kloofendal_48d_partly_cloudy_puresky', kind: 'hdri', res: '2k' },
  { id: 'qwantani_dusk_2_puresky', kind: 'hdri', res: '2k' },
  { id: 'qwantani_night_puresky', kind: 'hdri', res: '2k' },
];

/** Texture maps copied for `texture` entries: Poly Haven map name → file name. */
export const TEXTURE_MAPS: Record<string, string> = { Diffuse: 'diff', nor_gl: 'nor_gl', arm: 'arm' };
