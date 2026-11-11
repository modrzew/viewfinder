import { useEffect, useRef } from 'react';
import { formatDistanceM } from '../optics/focusScale';
import { formatFNumber, shutterLabel } from '../optics/stops';
import { frameRect } from '../render/layout';
import { Viewer } from '../render/Viewer';
import type { WebGLRenderer } from 'three';
import type { SceneSetup } from '../scene/types';
import { useOptics, useStore } from '../state/store';
import { DebugOverlay } from './DebugOverlay';
import { FrameLines } from './FrameLines';
import { LoadingScreen } from './LoadingScreen';
import { centreText } from './format';

function InfoBar() {
  const o = useOptics();
  const centre = useStore((s) => s.runtime.centreDistanceM);
  const dof = Number.isFinite(o.dofFarM)
    ? `${formatDistanceM(o.dofNearM, false)}–${formatDistanceM(o.dofFarM)}`
    : `${formatDistanceM(o.dofNearM)}–∞`;
  return (
    <div className="infobar">
      <span>{Math.round(o.focalMm)}<small>mm</small></span>
      <span>{formatFNumber(o.fNumber)}</span>
      <span>{shutterLabel(o.shutterS)}{o.exposureMode === 'M' && <small> M</small>}</span>
      <span><small>FOCUS </small>{formatDistanceM(o.focusM)}</span>
      <span><small>DOF </small>{dof}</span>
      <span><small>⌖ </small>{centreText(centre)}</span>
    </div>
  );
}

function RefineIndicator() {
  const refine = useStore((s) => s.runtime.refine);
  if (refine.samples <= 0 || refine.samples >= refine.target) return null;
  return <div className="refine">Refining {refine.samples}/{refine.target}</div>;
}

export function Viewport({ loadScene, debug }: {
  loadScene: (renderer: WebGLRenderer) => Promise<SceneSetup>;
  debug: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useStore((s) => s.runtime.viewport);
  const view = useStore((s) => s.settings.view);
  const locked = useStore((s) => s.runtime.pointerLocked);
  const helpOpen = useStore((s) => s.helpOpen);
  const o = useOptics();

  useEffect(() => {
    const el = ref.current!;
    const setRuntime = useStore.getState().setRuntime;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setRuntime({ viewport: { width: Math.floor(width), height: Math.floor(height) } });
    });
    ro.observe(el);
    const viewer = new Viewer(el, { loadScene });
    if (debug) Object.assign(window, { viewer, store: useStore });
    return () => {
      ro.disconnect();
      viewer.dispose();
    };
  }, [loadScene, debug]);

  const r = frameRect(viewport.width, viewport.height, view, o.imageAspect);
  const frameStyle = { left: r.x, top: r.y, width: r.width, height: r.height };

  return (
    <main className="viewport" ref={ref}>
      <div className="frame-overlay" style={frameStyle}>
        {view === 'camera' ? (
          <>
            <div className="af-point" />
            <RefineIndicator />
            <InfoBar />
          </>
        ) : (
          <FrameLines width={r.width} height={r.height} />
        )}
        {debug && <DebugOverlay frameWidth={r.width} />}
      </div>
      <LoadingScreen />
      {!locked && !helpOpen && <div className="lock-hint">Click to look around · <kbd>H</kbd> help</div>}
    </main>
  );
}
