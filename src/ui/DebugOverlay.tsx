import { blurPxAt } from '../optics/optics';
import { useOptics, useStore } from '../state/store';

/** `?debug=1`: timings, mode, and the predicted bokeh circle for the centre distance (§10.8). */
export function DebugOverlay({ frameWidth }: { frameWidth: number }) {
  const debug = useStore((s) => s.debug);
  const refine = useStore((s) => s.runtime.refine);
  const centre = useStore((s) => s.runtime.centreDistanceM);
  const renderPx = useStore((s) => s.runtime.renderPx);
  const view = useStore((s) => s.settings.view);
  const o = useOptics();

  const bCss = Math.abs(blurPxAt(o, centre ?? Infinity, frameWidth));
  const bRender = Math.abs(blurPxAt(o, centre ?? Infinity, renderPx.width));
  const p = debug.passes;
  const flag = (on: boolean) => (on ? 'on' : 'off');

  return (
    <>
      <div className="debug">
        <div>{debug.fps.toFixed(0)} fps · {debug.mode}</div>
        <div>samples {refine.samples}/{refine.target} · {debug.samplesPerFrame}/frame</div>
        <div>render {renderPx.width}×{renderPx.height}</div>
        <div>predicted bokeh {bRender.toFixed(1)} px</div>
        <div className="debug-keys">
          1 gather {flag(p.gather)} · 2 refine {flag(p.refine)} · 3 vignette {flag(p.vignette)} · 4 residual {flag(p.residual)}
        </div>
      </div>
      {view === 'camera' && bCss > 1 && (
        <div className="debug-circle" style={{ width: bCss, height: bCss }} />
      )}
    </>
  );
}
