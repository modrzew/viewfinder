/** Focus slider positions run 0…FOCUS_SLIDER_MAX; the last position is ∞ (SPEC §8.6). */
export const FOCUS_SLIDER_MAX = 1000;
const FAR_LIMIT_M = 1000;

export function sliderToFocusM(p: number, closestM: number): number {
  if (p >= FOCUS_SLIDER_MAX) return Infinity;
  const q = Math.max(0, p) / (FOCUS_SLIDER_MAX - 1);
  return closestM * Math.pow(FAR_LIMIT_M / closestM, q);
}

export function focusMToSlider(sM: number, closestM: number): number {
  if (!Number.isFinite(sM)) return FOCUS_SLIDER_MAX;
  if (sM <= closestM) return 0;
  const q = Math.log(sM / closestM) / Math.log(FAR_LIMIT_M / closestM);
  return Math.min(FOCUS_SLIDER_MAX - 1, Math.round(q * (FOCUS_SLIDER_MAX - 1)));
}

/** Two decimals below 10 m, one below 100 m, integers above, and ∞. */
export function formatDistanceM(m: number, unit = true): string {
  if (!Number.isFinite(m)) return '∞';
  const s = m < 10 ? m.toFixed(2) : m < 100 ? m.toFixed(1) : Math.round(m).toString();
  return unit ? `${s} m` : s;
}
