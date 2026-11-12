import { blurPxAt } from '../optics/optics';
import { useOptics, useStore, type DebugInfo } from '../state/store';

/** "idle" once a still image is finished and nothing is left to draw. */
function frameStats({ fps, cpuMs, gpuMs, mode }: DebugInfo): string {
  // On a slow GPU a frame can outlast the averaging window, so 0 fps alone doesn't mean idle.
  if (fps === 0 && mode === 'DONE') return 'idle';
  const parts = [`${fps.toFixed(0)} fps`];
  if (cpuMs !== null) parts.push(`CPU ${cpuMs.toFixed(1)} ms`);
  if (gpuMs !== null) parts.push(`GPU ${gpuMs.toFixed(1)} ms`);
  return parts.join(' · ');
}

/** Always on; the debug overlay takes its place with `?debug=1`. */
export function FpsCounter() {
  const debug = useStore((s) => s.debug);
  return <div className="debug">{frameStats(debug)}</div>;
}

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
        <div>{frameStats(debug)} · {debug.mode}</div>
        <div>samples {refine.samples}/{refine.target} · {debug.samplesPerFrame}/batch</div>
        <div>render {renderPx.width}×{renderPx.height} · preview ×{debug.previewScale}</div>
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
