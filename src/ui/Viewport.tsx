import { useEffect, useRef } from 'react';
import { frameRect } from '../render/layout';
import { runBenchmark } from '../render/benchmark';
import { Viewer, type ViewerOptions } from '../render/Viewer';
import { useOptics, useStore } from '../state/store';
import { FrameLines } from './FrameLines';
import { Hud } from './Hud';
import { LoadingScreen } from './LoadingScreen';

export function Viewport({ loadScene, debug, timeOfDay, bench }: {
  loadScene: ViewerOptions['loadScene'];
  debug: boolean;
  /** Whether the scene has times of day. */
  timeOfDay: boolean;
  /** Run the benchmark (`?bench=1`) once the scene has loaded. */
  bench: boolean;
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
    if (bench) void runBenchmark(viewer, timeOfDay);
    return () => {
      ro.disconnect();
      viewer.dispose();
    };
  }, [loadScene, debug, bench, timeOfDay]);

  const r = frameRect(viewport.width, viewport.height, view, o.imageAspect);
  const frameStyle = { left: r.x, top: r.y, width: r.width, height: r.height };

  return (
    <main className="viewport" ref={ref}>
      <div className="frame-overlay" style={frameStyle}>
        {view === 'camera' ? <div className="af-point" /> : <FrameLines width={r.width} height={r.height} />}
      </div>
      <Hud debug={debug} timeOfDay={timeOfDay} frameWidth={r.width} />
      <LoadingScreen />
      {!locked && !helpOpen && <div className="lock-hint">Click to look around</div>}
    </main>
  );
}
