import { CONFIG } from '../config';
import type { TimeOfDay } from '../scene/timeOfDay';
import { useStore, type Settings } from '../state/store';
import type { Viewer } from './Viewer';

// `?bench=1`: a fixed run that measures what the user feels, for comparing browsers on the same machine.
// Firefox and Safari have no GPU timer queries, so it measures rates and wall-clock times rather than GPU ms:
//   - switch: changing the time of day, and the longest frame gap meanwhile (shader compiles, uploads)
//   - camera / eye: frames the GPU finished per second while the view pans, p95 frame interval, main-thread
//     time per frame, and the preview scale dynamic resolution settled on
//   - refine: from a change to the finished 256-sample image, once with one sample batch queued at a time (the
//     old scheme) and once with two (the default), in alternating order so neither always runs first

const PAN_DEG = 8;
const PAN_PERIOD_MS = 2500;
const WARMUP_MS = 1500;
const CAMERA_MS = 4000;
const EYE_MS = 3000;
/** Per wait; generous so a slow machine gets a slow report rather than a failure. */
const TIMEOUT_MS = 300000;
const PHASES: TimeOfDay[] = ['golden', 'night'];

interface Motion { fps: number; p95Ms: number; cpuMs: number; gpuMs: number | null; scale: number }
interface Phase {
  timeOfDay: TimeOfDay | null;
  switchMs: number;
  switchMaxGapMs: number;
  camera: Motion;
  /** By batches queued: 1 and 2. */
  refine: Record<number, Refine>;
  eye: Motion;
}
interface Refine { ms: number; maxBatch: number }

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

class Aborted extends Error {}

/** Waits for `cond`, frame by frame. Returns how long it took and the longest gap between frames. */
async function until(viewer: Viewer, cond: () => boolean, onFrame?: () => void) {
  const t0 = performance.now();
  let last = t0;
  let maxGapMs = 0;
  while (!cond()) {
    const now = await nextFrame();
    if (viewer.isDisposed) throw new Aborted();
    if (now - t0 > TIMEOUT_MS) throw new Error('timed out');
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    onFrame?.();
  }
  return { ms: performance.now() - t0, maxGapMs };
}

/** Pans the view for `ms` after a warm-up (which also lets dynamic resolution settle). */
async function pan(viewer: Viewer, ms: number): Promise<Motion> {
  const baseYaw = (viewer.pose.yaw * 180) / Math.PI;
  const t0 = performance.now();
  let start: { now: number; totals: Viewer['frameTotals'] } | null = null;
  let last = 0;
  const intervals: number[] = [];
  for (;;) {
    const now = await nextFrame();
    if (viewer.isDisposed) throw new Aborted();
    const t = now - t0;
    viewer.setPose({ yawDeg: baseYaw + PAN_DEG * Math.sin((2 * Math.PI * t) / PAN_PERIOD_MS) });
    if (t >= WARMUP_MS) {
      if (!start) start = { now, totals: { ...viewer.frameTotals } };
      else intervals.push(now - last);
    }
    last = now;
    if (t >= WARMUP_MS + ms) break;
  }
  viewer.setPose({ yawDeg: baseYaw });
  const end = viewer.frameTotals;
  const s = start!.totals;
  const drawn = Math.max(end.drawn - s.drawn, 1);
  const elapsed = last - start!.now;
  intervals.sort((a, b) => a - b);
  return {
    // A frame slower than the whole measurement leaves nothing to divide by.
    fps: elapsed > 0 ? ((end.finished - s.finished) * 1000) / elapsed : 0,
    p95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? 0,
    cpuMs: (end.cpuMs - s.cpuMs) / drawn,
    gpuMs: end.gpuFrames > s.gpuFrames ? (end.gpuMs - s.gpuMs) / (end.gpuFrames - s.gpuFrames) : null,
    scale: useStore.getState().debug.previewScale,
  };
}

async function phase(
  viewer: Viewer,
  timeOfDay: TimeOfDay | null,
  order: number[],
  status: (s: string) => void,
): Promise<Phase> {
  const store = useStore.getState();
  const label = timeOfDay ?? 'scene';
  let switched = { ms: 0, maxGapMs: 0 };
  if (timeOfDay) {
    status(`${label}: switching`);
    store.setTimeOfDay(timeOfDay);
    switched = await until(viewer, () => viewer.settledTimeOfDay === timeOfDay);
  }
  store.setView('camera');
  viewer.resetPose();
  status(`${label}: camera view, panning`);
  const camera = await pan(viewer, CAMERA_MS);
  const refine: Record<number, Refine> = {};
  for (const depth of order) {
    status(`${label}: refining, ${depth} batch${depth > 1 ? 'es' : ''} queued`);
    viewer.setRefineBatchesInFlight(depth);
    viewer.invalidate();
    // The store still says DONE from the last run until the next frame.
    await until(viewer, () => useStore.getState().debug.mode !== 'DONE');
    let maxBatch = 0;
    const r = await until(viewer, () => useStore.getState().debug.mode === 'DONE', () => {
      maxBatch = Math.max(maxBatch, useStore.getState().debug.samplesPerFrame);
    });
    refine[depth] = { ms: r.ms, maxBatch };
  }
  viewer.setRefineBatchesInFlight(CONFIG.refineBatchesInFlight);
  status(`${label}: eye view, panning`);
  store.setView('eye');
  const eye = await pan(viewer, EYE_MS);
  store.setView('camera');
  return {
    timeOfDay, switchMs: switched.ms, switchMaxGapMs: switched.maxGapMs, camera, refine, eye,
  };
}

function browserName(): string {
  const ua = navigator.userAgent;
  const m = /Firefox\/([\d.]+)/.exec(ua) ?? /Edg\/([\d.]+)/.exec(ua) ?? /Chrome\/([\d.]+)/.exec(ua);
  const name = m ? (m[0].startsWith('Edg') ? 'Edge' : m[0].split('/')[0]) : /Safari/.test(ua) ? 'Safari' : 'Unknown';
  const version = m?.[1] ?? /Version\/([\d.]+)/.exec(ua)?.[1] ?? '';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return [`${name} ${version.split('.')[0]}`, os].filter(Boolean).join(' · ');
}

const f0 = (n: number) => n.toFixed(0);
const f1 = (n: number) => n.toFixed(1);

function motionLine(name: string, m: Motion): string {
  const gpu = m.gpuMs === null ? 'GPU n/a' : `GPU ${f1(m.gpuMs)} ms`;
  return `  ${name.padEnd(7)}${f0(m.fps)} fps · p95 ${f1(m.p95Ms)} ms · CPU ${f1(m.cpuMs)} ms · ${gpu} · preview ×${m.scale}`;
}

function report(viewer: Viewer, phases: Phase[]): string {
  const { renderPx, viewport } = useStore.getState().runtime;
  const lines = [
    `Viewfinder benchmark · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    `${browserName()} · ${viewer.gpuName} · DPR ${window.devicePixelRatio}`,
    `window ${viewport.width}×${viewport.height} · render ${renderPx.width}×${renderPx.height} · ${CONFIG.refineTarget} samples`,
  ];
  for (const p of phases) {
    lines.push(p.timeOfDay ?? 'scene');
    if (p.timeOfDay) lines.push(`  switch ${f1(p.switchMs / 1000)} s, longest frame ${f0(p.switchMaxGapMs)} ms`);
    lines.push(motionLine('camera', p.camera));
    const r = (n: number) => `${f1(p.refine[n].ms / 1000)} s (≤ ${p.refine[n].maxBatch}/batch)`;
    lines.push(`  refine ${r(1)} with 1 batch queued · ${r(2)} with 2`);
    lines.push(motionLine('eye', p.eye));
  }
  return lines.join('\n');
}

/** Runs once the scene has loaded; shows progress and the report through the store. */
export async function runBenchmark(viewer: Viewer, hasTimeOfDay: boolean): Promise<void> {
  const store = useStore.getState();
  const status = (s: string) => useStore.getState().setBench({ status: s, report: null });
  status('waiting for the scene');
  let saved: Settings | null = null;
  try {
    await until(viewer, () => viewer.ready && (!hasTimeOfDay || viewer.settledTimeOfDay !== null));
    saved = useStore.getState().settings;
    store.setHelpOpen(false);
    // Same optics every run: the defaults (50 mm at f/1.8, focused at 1 m, Av).
    store.setLens('ef-50-1.8-stm');
    store.setRequestedFNumber(1.8);
    store.setFocusM(1);
    store.setExposureMode('Av');
    const phases: Phase[] = [];
    const times = hasTimeOfDay ? PHASES : [null];
    for (const [i, t] of times.entries()) phases.push(await phase(viewer, t, i % 2 ? [2, 1] : [1, 2], status));
    const text = report(viewer, phases);
    console.info(text);
    useStore.getState().setBench({ status: 'done', report: text });
  } catch (err) {
    if (err instanceof Aborted) return;
    useStore.getState().setBench({ status: `failed: ${String(err)}`, report: null });
  } finally {
    if (!viewer.isDisposed) viewer.setRefineBatchesInFlight(CONFIG.refineBatchesInFlight);
    if (saved && !viewer.isDisposed) useStore.setState({ settings: saved });
  }
}
