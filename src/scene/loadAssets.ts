import { HalfFloatType, LoadingManager, SRGBColorSpace, TextureLoader, type DataTexture, type Group, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Loads public/scene/ (written by `bun run assets`) with byte-level progress for the loading screen.

const BASE = '/scene/';

export interface PbrTextures { diff: Texture; nor: Texture; arm: Texture }

let manifest: Promise<Record<string, number>> | null = null;

/** File sizes from public/scene/manifest.json, so progress can show a total up front. */
function fileSizes(): Promise<Record<string, number>> {
  manifest ??= fetch(`${BASE}manifest.json`).then(async (r) => ((await r.json()) as { files: Record<string, number> }).files);
  return manifest;
}

/** One sky, loaded on demand (another time of day). */
export async function loadHdri(
  file: string,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
): Promise<DataTexture> {
  const path = `hdri/${file}`;
  const total = (await fileSizes())[path] ?? 0;
  onProgress(0, total);
  const hdr = new HDRLoader().setDataType(HalfFloatType);
  const tex = await hdr.loadAsync(BASE + path, (e) => onProgress(Math.min(e.loaded, total || e.loaded), total));
  onProgress(total, total);
  return tex;
}

export interface CourtyardAssets {
  models: Record<string, Group>;
  textures: Record<string, PbrTextures>;
  hdri: DataTexture;
}

export async function loadCourtyardAssets(
  models: string[],
  textures: string[],
  hdri: string,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
): Promise<CourtyardAssets> {
  const sizes = await fileSizes();
  const size = (path: string) => sizes[path] ?? 0;

  const wanted = [
    ...models.map((m) => `models/${m}.glb`),
    ...textures.flatMap((t) => ['diff', 'nor_gl', 'arm'].map((m) => `textures/${t}/${m}.jpg`)),
    `hdri/${hdri}`,
  ];
  const total = wanted.reduce((s, p) => s + size(p), 0);
  const loaded = new Map<string, number>();
  const report = () => onProgress([...loaded.values()].reduce((s, n) => s + n, 0), total);
  const progress = (path: string) => (e: ProgressEvent) => {
    loaded.set(path, Math.min(e.loaded, size(path) || e.loaded));
    report();
  };
  const done = (path: string) => {
    loaded.set(path, size(path));
    report();
  };
  report();

  const manager = new LoadingManager();
  const gltf = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const hdr = new HDRLoader(manager).setDataType(HalfFloatType);
  const tex = new TextureLoader(manager);

  // Everything downloads in parallel; the HDRI is the largest file, so it must not wait for the models.
  const modelsP = Promise.all(
    models.map(async (m) => {
      const path = `models/${m}.glb`;
      const g = await gltf.loadAsync(BASE + path, progress(path));
      done(path);
      return [m, g.scene] as const;
    }),
  );

  const texturesP = Promise.all(
    textures.map(async (t) => {
      const load = async (map: string) => {
        const path = `textures/${t}/${map}.jpg`;
        const x = await tex.loadAsync(BASE + path);
        done(path);
        return x;
      };
      const [diff, nor, arm] = await Promise.all([load('diff'), load('nor_gl'), load('arm')]);
      diff.colorSpace = SRGBColorSpace;
      return [t, { diff, nor, arm }] as const;
    }),
  );

  const hdriPath = `hdri/${hdri}`;
  const envP = hdr.loadAsync(BASE + hdriPath, progress(hdriPath)).then((env) => {
    done(hdriPath);
    return env;
  });

  const [modelEntries, textureEntries, env] = await Promise.all([modelsP, texturesP, envP]);

  return { models: Object.fromEntries(modelEntries), textures: Object.fromEntries(textureEntries), hdri: env };
}
