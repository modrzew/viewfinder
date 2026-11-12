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

/** The HUD scales with the window height, like a game's with its resolution (§9.2). */
export function hudScale(vh: number): number {
  const [min, max] = CONFIG.hudScaleRange;
  return Math.min(Math.max(vh / CONFIG.hudReferenceHeightPx, min), max);
}

/**
 * Side by side (§9.1): `count` equal finders of `aspect` in a row docked at the top centre, so the centre of
 * the screen stays clear for aiming. The row either starts at the HUD's top margin, between the top corner
 * clusters, or below them across the full width; whichever gives the wider finder wins. CSS px.
 */
export function finderRects(vw: number, vh: number, count: number, aspect: number, scale: number): Rect[] {
  const c = CONFIG.sideBySide;
  if (count <= 0 || vw <= 0 || vh <= 0) return [];
  const gap = c.gapPx * scale;
  const finderBottom = c.maxRowHeight * vh - c.captionPx * scale;
  const fit = (top: number, side: number) => ({
    top,
    width: Math.min((vw - 2 * side - (count - 1) * gap) / count, c.maxFinderWidth * vw, (finderBottom - top) * aspect),
  });
  const between = fit(c.topPx * scale, c.cornerReservePx * scale);
  const below = fit(c.belowCornersPx * scale, c.sideMarginPx * scale);
  const { top, width: w } = between.width >= below.width ? between : below;
  const width = Math.max(Math.floor(w), 1);
  const height = Math.max(Math.floor(width / aspect), 1);
  const x0 = (vw - count * width - (count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, i) => ({
    x: Math.round(x0 + i * (width + gap)),
    y: Math.round(top),
    width,
    height,
  }));
}

/** Bottom of the finder row, captions included, CSS px. */
export function finderRowBottom(rects: Rect[], scale: number): number {
  return rects.length ? rects[0].y + rects[0].height + CONFIG.sideBySide.captionPx * scale : 0;
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

/**
 * Frame-line half extents as fractions of the eye view's half extents (§9.1). A lens's pinhole view is the
 * centred crop of the eye view with these extents, which side by side uses for its previews (§10.9).
 */
export function frameLineFractions(hfovDeg: number, vfovDeg: number, viewportAspect: number) {
  const tanEyeH = Math.tan((CONFIG.eyeHfovDeg / 2) * RAD);
  const tanEyeV = tanEyeH / viewportAspect;
  return {
    halfWidth: Math.tan((hfovDeg / 2) * RAD) / tanEyeH,
    halfHeight: Math.tan((vfovDeg / 2) * RAD) / tanEyeV,
  };
}
