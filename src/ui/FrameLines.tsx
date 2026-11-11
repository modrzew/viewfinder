import { frameLineFractions } from '../render/layout';
import { useOptics } from '../state/store';

/** Eye view: the current lens's frame drawn over the wide view (§9.1). */
export function FrameLines({ width, height }: { width: number; height: number }) {
  const o = useOptics();
  if (width <= 0 || height <= 0) return null;
  const f = frameLineFractions(o.hfovDeg, o.vfovDeg, width / height);
  const w = (f.halfWidth * width) / 2;
  const h = (f.halfHeight * height) / 2;
  return (
    <div
      className="frame-lines"
      style={{ left: width / 2 - w, top: height / 2 - h, width: 2 * w, height: 2 * h }}
    >
      <span className="frame-lines-label">{Math.round(o.focalMm)} mm</span>
    </div>
  );
}
