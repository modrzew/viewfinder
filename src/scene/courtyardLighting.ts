import {
  Box3, Color, DataUtils, DirectionalLight, EquirectangularReflectionMapping, MeshStandardMaterial,
  OrthographicCamera, PCFShadowMap, PMREMGenerator, PointLight, SpotLight, Vector3, type DataTexture, type InstancedMesh,
  type Material, type Object3D, type Scene, type WebGLRenderer, type WebGLRenderTarget,
} from 'three';
import { loadHdri } from './loadAssets';
import { BULB_AREA_M2 } from './stringLights';
import type { TimeOfDay } from './timeOfDay';
import type { Lighting, TimeOfDayControl } from './types';

// Courtyard lighting for each time of day (SPEC §11.4, §11.8).
//
// Exposure follows EV100, anchored on the golden-hour look: baseExposure = 1.3 · 2^(12 − EV100). So every
// light shares one set of units. Lamps keep the same emissive and intensity at every time of day and only
// look brighter at night because the exposure is longer, and an exposure locked in M mode at golden hour
// comes out 7 stops dark at night, as it would on a real camera.

const RAD = Math.PI / 180;
const GOLDEN_EV100 = 12;
const GOLDEN_EXPOSURE = 1.3;

function exposureFor(ev100: number): number {
  return GOLDEN_EXPOSURE * 2 ** (GOLDEN_EV100 - ev100);
}

/** Lamp constants. Emissives are linear radiance; light intensities are in the same units (candela-like). */
export const LAMPS = {
  /**
   * ~2700 K. SPEC §11.4 suggests 20–50× scene mid-grey, but spread over a 100+ px disc that gives dull
   * beige bokeh; real filament bulbs are far brighter, so they sit at ~200× shaded mid-grey at golden hour.
   */
  bulbColor: new Color(1.0, 0.45, 0.13),
  bulbIntensity: 40,
  /** Street lamp and wall lantern glass. */
  glassColor: new Color(1.0, 0.62, 0.3),
  glassIntensity: 14,
  streetLampLight: 1.2,
  wallLanternLight: 0.3,
  /** Candle in a table lantern. The golden-hour value is brighter than a candle, so its glow reads in sunlight. */
  candleColor: new Color(0xffa04a),
  candleLight: 0.02,
  candleLightGolden: 0.6,
  festoonLightsPerStrand: 4,
  /** Lit windows: curtain luminance, before the window's own tint and dimming. */
  windowIntensity: 0.02,
  /** The facade glass is opaque; while windows are lit it lets the rooms behind show through. */
  windowGlassOpacity: 0.2,
};

interface SkyPreset {
  file: string;
  /** Equirect u and elevation of the sun, or of the afterglow once it has set (`?debug=1` logs the brightest texel). */
  feature: { u: number; elevationDeg: number };
  /** Where that should sit: degrees left of the spawn view (−z), so 90 is due west. */
  azimuthLeftDeg: number;
  background: number;
  /** Lower than `background`: the walls hide much of the sky from the courtyard, which image-based light ignores. */
  environment: number;
  /**
   * Texels brighter than this are the sun's disc. They're clamped, and the energy taken out becomes the
   * DirectionalLight: image-based light casts no shadows, so a sun left in it would flatten them.
   */
  sunClamp?: number;
}

interface Preset {
  ev100: number;
  sky: SkyPreset;
  /** 'sky': colour and intensity from what `sunClamp` took out of the HDRI. null: the sun has set. */
  sun: { color: Color; intensity: number; shadow?: ShadowBounds } | 'sky' | null;
  /** off: unlit. glow: bulbs, glass and flames glow, but only the hero lantern lights anything. on: all lamps light. */
  lamps: 'off' | 'glow' | 'on';
  /** Fraction of windows lit. */
  windows: number;
}

interface ShadowBounds { left: number; right: number; top: number; bottom: number; near: number; far: number }

export const PRESETS: Record<TimeOfDay, Preset> = {
  noon: {
    ev100: 15,
    sky: {
      file: 'kloofendal_48d_partly_cloudy_puresky_2k.hdr',
      feature: { u: 0.595, elevationDeg: 47.9 },
      azimuthLeftDeg: 125,
      background: 6,
      environment: 3,
      sunClamp: 200,
    },
    sun: 'sky',
    lamps: 'off',
    windows: 0,
  },
  golden: {
    ev100: GOLDEN_EV100,
    sky: {
      file: 'venice_sunset_4k.hdr',
      feature: { u: 0.5997, elevationDeg: 3.4 },
      azimuthLeftDeg: 70,
      background: 1,
      environment: 0.5,
    },
    sun: {
      color: new Color(1.0, 0.72, 0.46),
      intensity: 7,
      shadow: { left: -24, right: 24, top: 18, bottom: -3, near: 20, far: 110 },
    },
    lamps: 'glow',
    windows: 0,
  },
  evening: {
    ev100: 9,
    sky: {
      file: 'qwantani_dusk_2_puresky_2k.hdr',
      feature: { u: 0.62, elevationDeg: 0 },
      azimuthLeftDeg: 75,
      background: 0.036,
      environment: 0.027,
    },
    sun: null,
    lamps: 'on',
    windows: 0.35,
  },
  night: {
    ev100: 7.5,
    sky: {
      file: 'qwantani_night_puresky_2k.hdr',
      feature: { u: 0.61, elevationDeg: 0 },
      azimuthLeftDeg: 95,
      background: 3e-4,
      environment: 3e-4,
    },
    sun: null,
    lamps: 'on',
    windows: 0.55,
  },
};

/** Casters and receivers the sun's shadow map must cover when it isn't given explicit bounds. */
const SHADOW_BOX = new Box3(new Vector3(-22, 0, -27), new Vector3(10.5, 13, 5));
const SUN_TARGET = new Vector3(0, 0, -11);

export interface CourtyardLightingParts {
  renderer: WebGLRenderer;
  scene: Scene;
  /** Parent for the lights. */
  root: Object3D;
  initial: TimeOfDay;
  /** The initial time of day's sky, loaded with the rest of the scene. */
  initialHdri: DataTexture;
  bulbs: InstancedMesh;
  festoonLights: Vector3[];
  /** Light centres (the middle of each lamp's glass). */
  streetLamps: Vector3[];
  wallLanterns: Vector3[];
  /** Flame positions; the first is the hero lantern. */
  candles: Vector3[];
  lampGlass: MeshStandardMaterial[];
  flame: Material;
  windows: { mesh: InstancedMesh; storeys: number[] }[];
  windowGlass: Material;
  interior: MeshStandardMaterial;
  debug: boolean;
}

interface Sky {
  texture: DataTexture;
  env: WebGLRenderTarget;
  rotY: number;
  /** Unit vector towards the sky's feature (sun or afterglow), after rotation. */
  featureDir: Vector3;
  /** Irradiance taken out by `sunClamp` (raw HDRI units, at normal incidence). */
  sunIrradiance: Color | null;
}

/** Direction (three.js equirect convention) of texel (u, elevation), after rotating the HDRI by rotY. */
function hdriDirection(u: number, elevationDeg: number, rotY: number): Vector3 {
  const phi = (u - 0.5) * 2 * Math.PI - rotY;
  const el = elevationDeg * RAD;
  return new Vector3(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi));
}

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Dev helper: logs the brightest HDRI texel as (u, elevation). */
function logBrightestTexel(name: string, tex: DataTexture): void {
  const { data, width, height } = tex.image as { data: Uint16Array; width: number; height: number };
  const f = DataUtils.fromHalfFloat;
  let best = 0;
  let bi = 0;
  for (let i = 0; i < width * height; i++) {
    const l = luminance(f(data[i * 4]), f(data[i * 4 + 1]), f(data[i * 4 + 2]));
    if (l > best) {
      best = l;
      bi = i;
    }
  }
  const u = ((bi % width) + 0.5) / width;
  const v = (Math.floor(bi / width) + 0.5) / height;
  // Row 0 is the top of the image in the file; flipY puts it at v = 1.
  console.info(`[courtyard] ${name}: brightest texel u ${u.toFixed(4)}, elevation ${((0.5 - v) * 180).toFixed(2)}°, ${best.toFixed(0)}`);
}

/**
 * Scales texels brighter than `max` (luminance) down to it, in place. Returns the irradiance removed, at
 * normal incidence: the sun's disc is small enough to treat it all as one direction.
 */
function clampSun(tex: DataTexture, max: number): Color {
  const { data, width, height } = tex.image as { data: Uint16Array; width: number; height: number };
  const { fromHalfFloat: f, toHalfFloat: h } = DataUtils;
  const removed = new Color(0, 0, 0);
  for (let y = 0; y < height; y++) {
    // Rows run top to bottom in the file (§ logBrightestTexel); solid angle per texel shrinks with cos(elevation).
    const el = (0.5 - (y + 0.5) / height) * Math.PI;
    const dOmega = (Math.PI / height) * ((2 * Math.PI) / width) * Math.cos(el);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = f(data[i]);
      const g = f(data[i + 1]);
      const b = f(data[i + 2]);
      const l = luminance(r, g, b);
      if (l <= max) continue;
      const k = max / l;
      removed.r += r * (1 - k) * dOmega;
      removed.g += g * (1 - k) * dOmega;
      removed.b += b * (1 - k) * dOmega;
      data[i] = h(r * k);
      data[i + 1] = h(g * k);
      data[i + 2] = h(b * k);
    }
  }
  tex.needsUpdate = true;
  return removed;
}

function fitShadow(sun: DirectionalLight): void {
  const view = new OrthographicCamera();
  view.position.copy(sun.position);
  view.lookAt(sun.target.position);
  view.updateMatrixWorld();
  const b = new Box3();
  const p = new Vector3();
  for (const x of [SHADOW_BOX.min.x, SHADOW_BOX.max.x]) {
    for (const y of [SHADOW_BOX.min.y, SHADOW_BOX.max.y]) {
      for (const z of [SHADOW_BOX.min.z, SHADOW_BOX.max.z]) b.expandByPoint(p.set(x, y, z).applyMatrix4(view.matrixWorldInverse));
    }
  }
  const cam = sun.shadow.camera;
  Object.assign(cam, { left: b.min.x, right: b.max.x, bottom: b.min.y, top: b.max.y, near: -b.max.z - 1, far: -b.min.z + 1 });
  cam.updateProjectionMatrix();
}

/** A deterministic pseudo-random number in [0, 1) for (a, b). */
function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Mostly tungsten-warm rooms (2400–3000 K), some cooler LED ones. */
const WINDOW_TINTS = [
  new Color(1.0, 0.42, 0.12), new Color(1.0, 0.52, 0.2), new Color(1.0, 0.52, 0.2), new Color(1.0, 0.62, 0.3),
  new Color(1.0, 0.74, 0.47),
];

export function createCourtyardLighting(parts: CourtyardLightingParts): TimeOfDayControl & { dispose(): void } {
  const { renderer, scene, root } = parts;
  const ready = new Map<TimeOfDay, Sky>();
  const pending = new Map<TimeOfDay, Promise<void>>();
  const progress = new Map<TimeOfDay, (loadedBytes: number, totalBytes: number) => void>();

  // One generator for every sky: disposing it would release its shaders, and each new sky would compile them
  // again on the main thread (§ compileShaders.ts: in Firefox that blocks until they're linked).
  const pmrem = new PMREMGenerator(renderer);

  const prepareSky = (t: TimeOfDay, texture: DataTexture): Sky => {
    const p = PRESETS[t].sky;
    texture.mapping = EquirectangularReflectionMapping;
    if (parts.debug) logBrightestTexel(p.file, texture);
    const sunIrradiance = p.sunClamp ? clampSun(texture, p.sunClamp) : null;
    const env = pmrem.fromEquirectangular(texture);
    const az = p.azimuthLeftDeg * RAD;
    const wantPhi = Math.atan2(-Math.cos(az), -Math.sin(az));
    const rotY = (p.feature.u - 0.5) * 2 * Math.PI - wantPhi;
    return { texture, env, rotY, featureDir: hdriDirection(p.feature.u, p.feature.elevationDeg, rotY), sunIrradiance };
  };
  ready.set(parts.initial, prepareSky(parts.initial, parts.initialHdri));

  // --- Sun -------------------------------------------------------------------------------------------------
  renderer.shadowMap.type = PCFShadowMap;
  const sun = new DirectionalLight();
  sun.target.position.copy(SUN_TARGET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // --- Lamps -----------------------------------------------------------------------------------------------
  const bulbOn = parts.bulbs.material as Material;
  const bulbOff = new MeshStandardMaterial({ color: 0xe9e5dc, roughness: 0.12, metalness: 0 });
  const glassOff = parts.lampGlass.map((m) => ({ m, transparent: m.transparent, opacity: m.opacity }));
  const interiorColor = parts.interior.color.clone();
  const windowGlassOpacity = parts.windowGlass.opacity;
  const lights: { light: PointLight | SpotLight; on: (mode: Preset['lamps']) => boolean }[] = [];
  const addLight = <T extends PointLight | SpotLight>(light: T, on: (mode: Preset['lamps']) => boolean): T => {
    root.add(light);
    lights.push({ light, on });
    return light;
  };
  const lampsOn = (mode: Preset['lamps']) => mode === 'on';

  // Festoons: each stand-in light carries its share of the bulbs' luminous intensity (emissive × area).
  const bulbCount = parts.bulbs.count;
  const festoonIntensity = (LAMPS.bulbIntensity * BULB_AREA_M2 * bulbCount) / parts.festoonLights.length;
  for (const p of parts.festoonLights) {
    const l = addLight(new PointLight(LAMPS.bulbColor, festoonIntensity, 0, 2), lampsOn);
    l.position.copy(p);
  }
  // Post lamps cast shadows; their shadow cameras start outside the lantern cage.
  for (const p of parts.streetLamps) {
    const l = addLight(new SpotLight(LAMPS.glassColor, LAMPS.streetLampLight, 0, 80 * RAD, 0.5, 2), lampsOn);
    l.position.copy(p);
    l.target.position.set(p.x, 0, p.z);
    root.add(l.target);
    l.castShadow = true;
    l.shadow.mapSize.set(1024, 1024);
    l.shadow.camera.near = 0.3;
    l.shadow.camera.far = 30;
    l.shadow.bias = -0.0005;
    l.shadow.normalBias = 0.02;
    l.shadow.radius = 2;
  }
  for (const p of parts.wallLanterns) {
    const l = addLight(new PointLight(LAMPS.glassColor, LAMPS.wallLanternLight, 0, 2), lampsOn);
    l.position.copy(p);
  }
  const candles = parts.candles.map((p, i) => {
    const l = addLight(new PointLight(LAMPS.candleColor, LAMPS.candleLight, 0, 2), (mode) => mode === 'on' || (i === 0 && mode === 'glow'));
    l.position.copy(p);
    return l;
  });

  const setLamps = (mode: Preset['lamps']) => {
    const lit = mode !== 'off';
    parts.bulbs.material = lit ? bulbOn : bulbOff;
    for (const g of glassOff) {
      g.m.emissive.copy(LAMPS.glassColor);
      g.m.emissiveIntensity = lit ? LAMPS.glassIntensity : 0;
      g.m.transparent = lit ? false : g.transparent;
      g.m.opacity = lit ? 1 : g.opacity;
      g.m.needsUpdate = true;
    }
    parts.flame.visible = lit;
    for (const { light, on } of lights) light.visible = on(mode);
    for (const c of candles) c.intensity = mode === 'glow' ? LAMPS.candleLightGolden : LAMPS.candleLight;
    // Point lights shine through walls; keep the dark rooms behind unlit windows dark.
    parts.interior.color.copy(mode === 'on' ? new Color(0, 0, 0) : interiorColor);
  };

  const setWindows = (fraction: number) => {
    parts.windowGlass.opacity = fraction > 0 ? LAMPS.windowGlassOpacity : windowGlassOpacity;
    const c = new Color();
    parts.windows.forEach(({ mesh, storeys }, m) => {
      mesh.visible = fraction > 0;
      for (let i = 0; i < mesh.count; i++) {
        // Shop doors on the ground floor are lit more often than flats.
        const lit = hash(m, i) < Math.min(1, fraction * (storeys[i] === 0 ? 1.4 : 1));
        const tint = WINDOW_TINTS[Math.floor(hash(i, m + 7) * WINDOW_TINTS.length)];
        const dim = 0.35 + 0.65 * hash(m + 3, i * 2 + 1);
        mesh.setColorAt(i, lit ? c.copy(tint).multiplyScalar(LAMPS.windowIntensity * dim) : c.setRGB(0, 0, 0));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  };

  return {
    initial: parts.initial,

    load(t, onProgress) {
      if (ready.has(t)) return Promise.resolve();
      progress.set(t, onProgress);
      let p = pending.get(t);
      if (!p) {
        p = loadHdri(PRESETS[t].sky.file, (loaded, total) => progress.get(t)?.(loaded, total)).then((tex) => {
          ready.set(t, prepareSky(t, tex));
        });
        p.catch(() => {}).finally(() => pending.delete(t));
        pending.set(t, p);
      }
      return p;
    },

    apply(t) {
      const preset = PRESETS[t];
      const sky = ready.get(t);
      if (!sky) throw new Error(`Sky for ${t} isn't loaded`);

      // Free the GPU copy (and cube conversion) of the sky being replaced; its data stays for next time.
      const previous = scene.background as DataTexture | null;
      if (previous && previous !== sky.texture) previous.dispose();
      scene.background = sky.texture;
      scene.environment = sky.env.texture;
      scene.backgroundRotation.set(0, sky.rotY, 0);
      scene.environmentRotation.set(0, sky.rotY, 0);
      scene.backgroundIntensity = preset.sky.background;
      scene.environmentIntensity = preset.sky.environment;

      sun.visible = preset.sun !== null;
      if (preset.sun) {
        if (preset.sun === 'sky') {
          const e = sky.sunIrradiance ?? new Color(0, 0, 0);
          const peak = Math.max(e.r, e.g, e.b, 1e-6);
          sun.color.copy(e).multiplyScalar(1 / peak);
          // The sun isn't occluded by the courtyard the way the sky is, so it follows the sky's own scale.
          sun.intensity = peak * preset.sky.background;
        } else {
          sun.color.copy(preset.sun.color);
          sun.intensity = preset.sun.intensity;
        }
        sun.position.copy(SUN_TARGET).addScaledVector(sky.featureDir, 60);
        sun.updateMatrixWorld();
        const bounds = preset.sun !== 'sky' ? preset.sun.shadow : undefined;
        if (bounds) {
          Object.assign(sun.shadow.camera, bounds);
          sun.shadow.camera.updateProjectionMatrix();
        } else {
          fitShadow(sun);
        }
      }

      setLamps(preset.lamps);
      setWindows(preset.windows);
      return { ev100: preset.ev100, baseExposure: exposureFor(preset.ev100) } satisfies Lighting;
    },

    dispose() {
      pmrem.dispose();
      for (const s of ready.values()) {
        s.env.dispose();
        s.texture.dispose();
      }
      bulbOff.dispose();
      sun.dispose();
      for (const { light } of lights) light.dispose();
    },
  };
}
