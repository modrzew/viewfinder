import { CONFIG } from '../config';
import type { View } from '../state/store';

export interface Rect { x: number; y: number; width: number; height: number }

const RAD = Math.PI / 180;

/** Camera view: the largest rectangle of `aspect` that fits, centred. Eye view: the whole viewport. */
export function frameRect(vw: number, vh: number, view: View, aspect: number): Rect {
  if (view === 'eye' || vw <= 0 || vh <= 0) return { x: 0, y: 0, width: vw, height: vh };
  let width = vw;
  let height = vw / aspect;
  if (height > vh) {
    height = vh;
    width = vh * aspect;
  }
  width = Math.floor(width);
  height = Math.floor(height);
  return { x: Math.floor((vw - width) / 2), y: Math.floor((vh - height) / 2), width, height };
}

/** Internal render size in device px (§10.2). */
export function renderSize(cssW: number, cssH: number, dpr: number) {
  const width = Math.max(1, Math.min(Math.round(cssW * Math.min(dpr, CONFIG.maxPixelRatio)), CONFIG.maxRenderWidthPx));
  const height = Math.max(1, Math.round((width * cssH) / Math.max(cssW, 1)));
  return { width, height };
}

/** Eye view vertical FOV for a viewport aspect, with the horizontal FOV fixed. */
export function eyeVfovDeg(aspect: number): number {
  return (2 * Math.atan(Math.tan((CONFIG.eyeHfovDeg / 2) * RAD) / aspect)) / RAD;
}

/** Frame-line half extents as fractions of the eye view's half extents (§9.1). */
export function frameLineFractions(hfovDeg: number, vfovDeg: number, viewportAspect: number) {
  const tanEyeH = Math.tan((CONFIG.eyeHfovDeg / 2) * RAD);
  const tanEyeV = tanEyeH / viewportAspect;
  return {
    halfWidth: Math.tan((hfovDeg / 2) * RAD) / tanEyeH,
    halfHeight: Math.tan((vfovDeg / 2) * RAD) / tanEyeV,
  };
}
