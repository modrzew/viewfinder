import { getBody } from '../optics/bodies';
import { finderRects, frameLineFractions, hudScale, type Rect } from '../render/layout';
import { opticsFor, sideBySideOnScreen, useStore } from '../state/store';

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

/**
 * Eye view: the selected lens's frame drawn over the wide view (§9.1). Side by side, every shown lens's, the
 * selected one in the accent colour and on top, labelled at the bottom so the finders above don't cover it.
 */
export function FrameLines({ width, height }: { width: number; height: number }) {
  const settings = useStore((s) => s.settings);
  const ev100 = useStore((s) => s.runtime.ev100);
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
    return (
      <div
        key={id}
        className={classes.join(' ')}
        style={{ left: width / 2 - w, top: height / 2 - h, width: 2 * w, height: 2 * h }}
      >
        <span className="frame-lines-label">{Math.round(o.focalMm)} mm</span>
      </div>
    );
  });
  if (!sideBySide) return frames;
  const aspect = getBody(settings.bodyId).imageAspect;
  const rects = finderRects(width, height, settings.sideBySideLensIds.length, aspect, hudScale(height));
  return <div className="frame-lines-clip" style={{ clipPath: behindFinders(width, height, rects) }}>{frames}</div>;
}
