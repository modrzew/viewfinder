import type { Lens } from './types';

// Aperture shape and low-discrepancy sample generation (SPEC §10.5).

const TAU = Math.PI * 2;

/** r = mix(wideOpen, stoppedDown, clamp(Δ / stopsToStoppedDown, 0, 1)) */
export function apertureRoundness(lens: Lens, stopsDown: number): number {
  const { wideOpen, stoppedDown, stopsToStoppedDown } = lens.roundness;
  const t = Math.min(Math.max(stopsDown / stopsToStoppedDown, 0), 1);
  return wideOpen + (stoppedDown - wideOpen) * t;
}

export interface ApertureShape {
  blades: number;
  roundness: number;
  theta0: number;
  /** Multiplying `shapeRadius` by this gives a shape with the unit circle's area. */
  areaScale: number;
}

/** Boundary radius at angle θ for the shape with circumradius 1. */
export function shapeRadius(shape: ApertureShape, theta: number): number {
  const n = shape.blades;
  const seg = TAU / n;
  let t = (theta - shape.theta0) % seg;
  if (t < 0) t += seg;
  const polygon = Math.cos(Math.PI / n) / Math.cos(t - Math.PI / n);
  return polygon + (1 - polygon) * shape.roundness;
}

export function makeApertureShape(blades: number, roundness: number, theta0 = Math.PI / 2): ApertureShape {
  const shape: ApertureShape = { blades, roundness, theta0, areaScale: 1 };
  const steps = 4096;
  let area = 0;
  for (let i = 0; i < steps; i++) {
    const r = shapeRadius(shape, ((i + 0.5) / steps) * TAU);
    area += 0.5 * r * r * (TAU / steps);
  }
  shape.areaScale = Math.sqrt(Math.PI / area);
  return shape;
}

// R2 sequence (Roberts), based on the plastic number.
const G = 1.324717957244746;
const A1 = 1 / G;
const A2 = 1 / (G * G);

function frac(x: number): number {
  return x - Math.floor(x);
}

/** Points in the circumradius-1 shape, in R2 order, so every prefix is evenly spread. */
function shapePoints(shape: ApertureShape, count: number, seedX: number, seedY: number): Float32Array {
  const out = new Float32Array(count * 2);
  let found = 0;
  for (let i = 0; found < count && i < count * 64; i++) {
    const x = frac(seedX + A1 * i) * 2 - 1;
    const y = frac(seedY + A2 * i) * 2 - 1;
    if (Math.hypot(x, y) <= shapeRadius(shape, Math.atan2(y, x))) {
      out[found * 2] = x;
      out[found * 2 + 1] = y;
      found++;
    }
  }
  return out;
}

/** Aperture points (x, y pairs) scaled to the unit circle's area, for jittered thin-lens rendering. */
export function apertureSamples(shape: ApertureShape, count = 1024): Float32Array {
  const pts = shapePoints(shape, count, 0.5, 0.5);
  for (let i = 0; i < pts.length; i++) pts[i] *= shape.areaScale;
  return pts;
}

/**
 * Gather-kernel offsets for the interactive preview, sorted by radius. Each
 * entry is (x, y, farDist, nearDist): x, y lie in the circumradius-1 shape;
 * farDist / nearDist are |o| relative to the shape's boundary in the direction
 * that a far-field (upright) or near-field (inverted) bokeh would cover.
 */
export function gatherKernel(shape: ApertureShape, count = 64): Float32Array {
  const pts = shapePoints(shape, count, 0.5, 0.5);
  const entries: [number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    const r = Math.hypot(x, y);
    const th = Math.atan2(y, x);
    entries.push([x, y, r / shapeRadius(shape, th + Math.PI), r / shapeRadius(shape, th)]);
  }
  entries.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  return Float32Array.from(entries.flat());
}

/** Sub-pixel jitter in [−½, ½]², from a separate R2 sequence. */
export function pixelJitter(count = 1024): Float32Array {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[i * 2] = frac(0.2 + A1 * (i + 1)) - 0.5;
    out[i * 2 + 1] = frac(0.8 + A2 * (i + 1)) - 0.5;
  }
  return out;
}
