// Downloads the Poly Haven assets in assets.manifest.ts and optimises them into public/scene/ (SPEC §12).
// Usage: bun run assets [--force]

import { mkdir, stat, copyFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { ASSETS, TEXTURE_MAPS, type AssetEntry } from './assets.manifest';

const ROOT = join(import.meta.dir, '..');
const CACHE = join(ROOT, '.assets-cache');
const OUT = join(ROOT, 'public', 'scene');
const USER_AGENT = 'Viewfinder asset fetcher (camera/lens simulator; github.com/viewfinder)';
const FORCE = process.argv.includes('--force');

interface PhFile { url: string; size: number; md5: string; include?: Record<string, PhFile> }

async function exists(path: string, size?: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return size === undefined || s.size === size;
  } catch {
    return false;
  }
}

async function download(file: PhFile, dest: string): Promise<void> {
  if (!FORCE && (await exists(dest, file.size))) return;
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(file.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${file.url}`);
  await Bun.write(dest, res);
  console.log(`  ↓ ${relative(ROOT, dest)} (${(file.size / 1e6).toFixed(1)} MB)`);
}

async function filesFor(id: string): Promise<Record<string, any>> {
  const res = await fetch(`https://api.polyhaven.com/files/${id}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Poly Haven API ${res.status} for ${id}`);
  return res.json();
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`Failed: ${cmd.join(' ')}`);
}

async function fetchModel(a: AssetEntry, files: Record<string, any>): Promise<void> {
  const gltf: PhFile = files.gltf[a.res].gltf;
  const dir = join(CACHE, a.id, a.res);
  const main = join(dir, gltf.url.split('/').pop()!);
  await download(gltf, main);
  for (const [path, f] of Object.entries(gltf.include ?? {})) await download(f, join(dir, path));

  const out = join(OUT, 'models', `${a.id}.glb`);
  if (!FORCE && (await exists(out))) return;
  await mkdir(dirname(out), { recursive: true });
  await run([
    join(ROOT, 'node_modules', '.bin', 'gltf-transform'), 'optimize', main, out,
    '--compress', 'meshopt',
    '--texture-compress', 'webp',
    '--texture-size', a.res === '2k' ? '2048' : '1024',
    ...(a.keepParts ? ['--join-named', 'false'] : []),
  ]);
}

async function fetchTexture(a: AssetEntry, files: Record<string, any>): Promise<void> {
  for (const [map, name] of Object.entries(TEXTURE_MAPS)) {
    const f: PhFile = files[map][a.res].jpg;
    const cached = join(CACHE, a.id, a.res, `${name}.jpg`);
    await download(f, cached);
    const out = join(OUT, 'textures', a.id, `${name}.jpg`);
    await mkdir(dirname(out), { recursive: true });
    await copyFile(cached, out);
  }
}

async function fetchHdri(a: AssetEntry, files: Record<string, any>): Promise<void> {
  const f: PhFile = files.hdri[a.res].hdr;
  const cached = join(CACHE, a.id, `${a.id}_${a.res}.hdr`);
  await download(f, cached);
  const out = join(OUT, 'hdri', `${a.id}_${a.res}.hdr`);
  await mkdir(dirname(out), { recursive: true });
  await copyFile(cached, out);
}

/** Writes public/scene/manifest.json (file sizes), so the loading screen knows the total up front. */
async function writeSceneManifest(): Promise<void> {
  const files: Record<string, number> = {};
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name !== 'manifest.json') files[relative(OUT, p).split('\\').join('/')] = (await stat(p)).size;
    }
  };
  await walk(OUT);
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n');
}

for (const a of ASSETS) {
  console.log(`${a.id} (${a.kind}, ${a.res})`);
  const files = await filesFor(a.id);
  if (a.kind === 'model') await fetchModel(a, files);
  else if (a.kind === 'texture') await fetchTexture(a, files);
  else await fetchHdri(a, files);
}
await writeSceneManifest();
console.log('Done. Run `bun scripts/check-asset-budget.ts` to check the size budget.');
