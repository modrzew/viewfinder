import type { CSSProperties } from 'react';
import { getBody } from '../optics/bodies';
import { isZoom } from '../optics/lenses';
import { formatFNumber, shutterLabel } from '../optics/stops';
import { finderRects } from '../render/layout';
import { opticsFor, useHudScale, useStore } from '../state/store';
import { avOutOfRange, lensFocalLabel } from './format';

/**
 * Side by side: the chrome around each finder the Viewer draws (§9.1), with the same layout. It belongs to
 * the view, so U leaves it on screen.
 */
export function Finders() {
  const settings = useStore((s) => s.settings);
  const ev100 = useStore((s) => s.runtime.ev100);
  const viewport = useStore((s) => s.runtime.viewport);
  const safeArea = useStore((s) => s.runtime.safeArea);
  const progress = useStore((s) => s.runtime.finderRefine);
  const scale = useHudScale();
  const ids = settings.sideBySideLensIds;
  const aspect = getBody(settings.bodyId).imageAspect;
  const rects = finderRects(viewport.width, viewport.height, ids.length, aspect, scale, safeArea);
  return (
    <div className="finders" style={{ '--hud-scale': scale } as CSSProperties}>
      {ids.map((id, i) => {
        const o = opticsFor(settings, ev100, id);
        const r = rects[i];
        const p = progress[id];
        const refining = p && p.samples > 0 && p.samples < p.target;
        const focal = String(Math.round(o.focalMm));
        const fNumber = formatFNumber(o.fNumber);
        const shutter = shutterLabel(o.shutterS);
        return (
          <div
            key={id}
            className={id === settings.lensId ? 'finder on' : 'finder'}
            style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
          >
            <div className="finder-af" />
            {refining && <div className="finder-refine"><div style={{ width: `${(p.samples / p.target) * 100}%` }} /></div>}
            {/* Values replay the amber flash when they change, as on the HUD. */}
            <div className="finder-caption">
              <span className="finder-focal"><b key={focal} className="flash">{focal}</b><small>mm</small></span>
              {isZoom(o.lens) && <span className="finder-range">{lensFocalLabel(o.lens)}</span>}
              <span key={fNumber} className="flash">{fNumber}</span>
              <span key={shutter} className={avOutOfRange(o) ? 'flash warn' : 'flash'}>{shutter}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
