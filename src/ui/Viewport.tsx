import { useEffect, useRef } from 'react';
import { frameRect } from '../render/layout';
import { Viewer, type ViewerOptions } from '../render/Viewer';
import { sideBySideOnScreen, useOptics, useStore } from '../state/store';
import { Finders } from './Finders';
import { FrameLines } from './FrameLines';
import { Hud } from './Hud';
import { LensWheel } from './LensWheel';
import { LoadingScreen } from './LoadingScreen';

export function Viewport({ loadScene, debug, timeOfDay }: {
  loadScene: ViewerOptions['loadScene'];
  debug: boolean;
  /** Whether the scene has times of day. */
  timeOfDay: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useStore((s) => s.runtime.viewport);
  const view = useStore((s) => s.settings.view);
  const sideBySide = useStore((s) => sideBySideOnScreen(s.settings));
  const locked = useStore((s) => s.runtime.pointerLocked);
  const helpOpen = useStore((s) => s.helpOpen);
  const wheelOpen = useStore((s) => s.wheel !== null);
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

  // The AF point, frame lines, finders and lens wheel belong to the view, so U doesn't hide them.
  return (
    <main className={wheelOpen ? 'viewport wheel-open' : 'viewport'} ref={ref}>
      <div className="frame-overlay" style={frameStyle}>
        {view === 'eye' && <FrameLines width={r.width} height={r.height} />}
        {(view === 'camera' || sideBySide) && <div className="af-point" />}
      </div>
      {sideBySide && <Finders />}
      <Hud debug={debug} timeOfDay={timeOfDay} frameWidth={r.width} />
      <LensWheel />
      <LoadingScreen />
      {!locked && !helpOpen && !wheelOpen && <div className="lock-hint">Click to look around</div>}
    </main>
  );
}
