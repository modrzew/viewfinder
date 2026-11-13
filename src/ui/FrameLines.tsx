import { getBody } from '../optics/bodies';
import { finderRects, frameLineFractions, type Rect } from '../render/layout';
import { opticsFor, sideBySideOnScreen, useHudScale, useStore } from '../state/store';

/**
 * A clip path of the whole view with a hole where the row of finders floats, so frame lines pass behind it.
 * One hole for the row: stubs of a line showing in the gaps between finders would only look like dirt.
 */
function behindFinders(width: number, height: number, rects: Rect[]): string {
  if (rects.length === 0) return 'none';
  const m = 3;
  const first = rects[0];
  const last = rects[rects.length - 1];
  const w = last.x + last.width - first.x + 2 * m;
  const h = first.height + 2 * m;
  return `path(evenodd, "M0 0H${width}V${height}H0ZM${first.x - m} ${first.y - m}h${w}v${h}h${-w}Z")`;
}

/** Below the screen centre, where the AF distance ends (HUD px), and a frame label's height (CSS px). */
const AF_DISTANCE_BOTTOM_PX = 34;
const LABEL_PX = 20;

/**
 * Eye view: the selected lens's frame drawn over the wide view (§9.1). Side by side, every shown lens's, the
 * selected one in the accent colour and on top, labelled at the bottom so the finders above don't cover it.
 */
export function FrameLines({ width, height }: { width: number; height: number }) {
  const settings = useStore((s) => s.settings);
  const ev100 = useStore((s) => s.runtime.ev100);
  const safeArea = useStore((s) => s.runtime.safeArea);
  const scale = useHudScale();
  if (width <= 0 || height <= 0) return null;
  const sideBySide = sideBySideOnScreen(settings);
  const ids = sideBySide
    ? [...settings.sideBySideLensIds.filter((id) => id !== settings.lensId), settings.lensId]
    : [settings.lensId];
  const frames = ids.map((id) => {
    const o = opticsFor(settings, ev100, id);
    const f = frameLineFractions(o.hfovDeg, o.vfovDeg, width / height);
    const w = (f.halfWidth * width) / 2;
    const h = (f.halfHeight * height) / 2;
    const classes = ['frame-lines'];
    if (sideBySide) classes.push('labelled-below');
    if (sideBySide && id === settings.lensId) classes.push('on');
    // A frame too short for its label to clear the AF distance (a long lens in portrait) has it underneath.
    const afBottom = AF_DISTANCE_BOTTOM_PX * scale;
    const labelTop = sideBySide && h - LABEL_PX < afBottom ? Math.max(2 * h + 4, h + afBottom + 2) : null;
    return (
      <div
        key={id}
        className={classes.join(' ')}
        style={{ left: width / 2 - w, top: height / 2 - h, width: 2 * w, height: 2 * h }}
      >
        <span className="frame-lines-label" style={labelTop === null ? undefined : { top: labelTop, bottom: 'auto' }}>
          {Math.round(o.focalMm)} mm
        </span>
      </div>
    );
  });
  if (!sideBySide) return frames;
  const aspect = getBody(settings.bodyId).imageAspect;
  const rects = finderRects(width, height, settings.sideBySideLensIds.length, aspect, scale, safeArea);
  return <div className="frame-lines-clip" style={{ clipPath: behindFinders(width, height, rects) }}>{frames}</div>;
}
