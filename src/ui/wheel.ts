import { CONFIG } from '../config';

// Lens wheel geometry (§9.2). Angles are clockwise from the top, as on a clock; screen y points down.

const TAU = Math.PI * 2;

/** Adds mouse movement to the aim, clamping its length so reversing direction is quick. */
export function moveAim(aim: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } {
  const x = aim.x + dx;
  const y = aim.y + dy;
  const len = Math.hypot(x, y);
  const max = CONFIG.lensWheel.maxAimPx;
  return len > max ? { x: (x * max) / len, y: (y * max) / len } : { x, y };
}

/** The slice under the aim, or −1 in the dead zone. Equal slices, the first centred at the top, clockwise. */
export function sliceAt(aim: { x: number; y: number }, count: number): number {
  if (count <= 0 || Math.hypot(aim.x, aim.y) < CONFIG.lensWheel.deadZonePx) return -1;
  const theta = (Math.atan2(aim.x, -aim.y) + TAU) % TAU;
  return Math.floor(((theta + Math.PI / count) % TAU) / (TAU / count)) % count;
}

/** The aim's angle, clockwise from the top. */
export function aimAngle(aim: { x: number; y: number }): number {
  return Math.atan2(aim.x, -aim.y);
}

/** Centre angle of slice `i`. */
export function sliceAngle(i: number, count: number): number {
  return (i * TAU) / count;
}

export function polar(angle: number, radius: number): { x: number; y: number } {
  return { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) };
}

const pt = (angle: number, radius: number) => {
  const p = polar(angle, radius);
  return `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
};

/**
 * SVG path of slice `i` of `count` between radii `inner` and `outer`, centred on the origin, with a gap of
 * `gap` px between neighbouring slices. One slice is the whole ring.
 */
export function slicePath(i: number, count: number, inner: number, outer: number, gap: number): string {
  if (count === 1) {
    return `M ${pt(0, outer)} A ${outer} ${outer} 0 1 1 ${pt(Math.PI, outer)} A ${outer} ${outer} 0 1 1 ${pt(0, outer)} Z `
      + `M ${pt(0, inner)} A ${inner} ${inner} 0 1 0 ${pt(Math.PI, inner)} A ${inner} ${inner} 0 1 0 ${pt(0, inner)} Z`;
  }
  const c = sliceAngle(i, count);
  const half = Math.PI / count;
  // Offsetting each edge by half the gap at both radii keeps the gaps parallel.
  const go = gap / 2 / outer;
  const gi = gap / 2 / inner;
  const large = 2 * half > Math.PI ? 1 : 0;
  return `M ${pt(c - half + go, outer)} A ${outer} ${outer} 0 ${large} 1 ${pt(c + half - go, outer)} `
    + `L ${pt(c + half - gi, inner)} A ${inner} ${inner} 0 ${large} 0 ${pt(c - half + gi, inner)} Z`;
}

/** SVG path of an arc along slice `i` at `radius`, inset by `gap` like the slice. */
export function sliceArc(i: number, count: number, radius: number, gap: number): string {
  if (count === 1) return `M ${pt(0, radius)} A ${radius} ${radius} 0 1 1 ${pt(Math.PI, radius)} A ${radius} ${radius} 0 1 1 ${pt(0, radius)}`;
  const c = sliceAngle(i, count);
  const half = Math.PI / count - gap / 2 / radius;
  return `M ${pt(c - half, radius)} A ${radius} ${radius} 0 ${2 * half > Math.PI ? 1 : 0} 1 ${pt(c + half, radius)}`;
}
