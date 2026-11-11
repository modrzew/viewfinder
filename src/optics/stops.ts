/** Nominal third-stop f-numbers, used both for display and in the maths. */
export const APERTURE_STOPS: readonly number[] = [
  1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 25, 29, 32,
];

/** Canon nominal shutter labels, indexed by k = round(3·log2(1/t)). */
export const SHUTTER_LABELS: readonly string[] = [
  '1″', '0″8', '0″6', '0″5', '0″4', '0″3', '1/4', '1/5', '1/6', '1/8',
  '1/10', '1/13', '1/15', '1/20', '1/25', '1/30', '1/40', '1/50', '1/60', '1/80',
  '1/100', '1/125', '1/160', '1/200', '1/250', '1/320', '1/400', '1/500', '1/640', '1/800',
  '1/1000', '1/1250', '1/1600', '1/2000', '1/2500', '1/3200', '1/4000', '1/5000', '1/6400', '1/8000',
];

/** Index of the stop closest to `n` (in log space). */
export function nearestStopIndex(n: number): number {
  let best = 0;
  for (let i = 1; i < APERTURE_STOPS.length; i++) {
    if (Math.abs(Math.log(APERTURE_STOPS[i] / n)) < Math.abs(Math.log(APERTURE_STOPS[best] / n))) best = i;
  }
  return best;
}

/** The third-stops from `widest` to `narrowest` inclusive. */
export function stopsWithin(widest: number, narrowest: number): number[] {
  return APERTURE_STOPS.filter((n) => n >= widest - 1e-9 && n <= narrowest + 1e-9);
}

export function formatFNumber(n: number): string {
  return `f/${n}`;
}

export function shutterIndex(tS: number): number {
  return Math.round(3 * Math.log2(1 / tS));
}

export function shutterLabel(tS: number): string {
  const k = shutterIndex(tS);
  return SHUTTER_LABELS[Math.min(Math.max(k, 0), SHUTTER_LABELS.length - 1)];
}

const THIRDS = ['', '⅓', '⅔'];

/** EV offset rounded to thirds, e.g. `−1⅓ EV`. */
export function formatEvThirds(ev: number): string {
  const thirds = Math.round(ev * 3);
  if (thirds === 0) return '±0 EV';
  const sign = thirds < 0 ? '−' : '+';
  const whole = Math.floor(Math.abs(thirds) / 3);
  const frac = THIRDS[Math.abs(thirds) % 3];
  return `${sign}${whole > 0 || frac === '' ? whole : ''}${frac} EV`;
}
