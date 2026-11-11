// Fails the build if public/scene/ exceeds the budget (SPEC §12): Vercel Hobby caps a CLI upload at 100 MB.

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const BUDGET_BYTES = 80 * 1000 * 1000;
const DIR = join(import.meta.dir, '..', 'public', 'scene');

const sizes: [string, number][] = [];
async function walk(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else sizes.push([relative(DIR, p), (await stat(p)).size]);
  }
}

try {
  await walk(DIR);
} catch {
  console.error('public/scene/ is missing. Run `bun run assets` first.');
  process.exit(1);
}

const total = sizes.reduce((s, [, n]) => s + n, 0);
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
if (process.argv.includes('--verbose') || total > BUDGET_BYTES) {
  for (const [p, n] of sizes.sort((a, b) => b[1] - a[1])) console.log(`${mb(n).padStart(9)}  ${p}`);
}
if (total > BUDGET_BYTES) {
  console.error(`public/scene/ is ${mb(total)}, over the ${mb(BUDGET_BYTES)} budget.`);
  process.exit(1);
}
console.log(`public/scene/ is ${mb(total)} (budget ${mb(BUDGET_BYTES)}).`);
