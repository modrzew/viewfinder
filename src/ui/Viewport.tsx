import { useEffect, useRef, type CSSProperties } from 'react';
import { CONFIG } from '../config';
import { frameRect } from '../render/layout';
import { runBenchmark } from '../render/benchmark';
import { Viewer, type ViewerOptions } from '../render/Viewer';
import { sideBySideOnScreen, useOptics, useStore } from '../state/store';
import { Finders } from './Finders';
import { FrameLines } from './FrameLines';
import { Hud } from './Hud';
import { LensWheel } from './LensWheel';
import { LoadingScreen } from './LoadingScreen';
import { TouchLayer } from './TouchLayer';

/** The touch joystick's size, for the joystick and the HUD's hint of it. */
const STICK_STYLE = { '--stick-r': `${CONFIG.touch.stickRadiusPx}px` } as CSSProperties;

/** The safe-area insets, read off an element padded by them. */
function readInsets(probe: HTMLElement) {
  const cs = getComputedStyle(probe);
  const px = (v: string) => Math.round(parseFloat(v) || 0);
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

export function Viewport({ loadScene, debug, timeOfDay, bench }: {
  loadScene: ViewerOptions['loadScene'];
  debug: boolean;
  /** Whether the scene has times of day. */
  timeOfDay: boolean;
  /** Run the benchmark (`?bench=1`) once the scene has loaded. */
  bench: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const viewport = useStore((s) => s.runtime.viewport);
  const view = useStore((s) => s.settings.view);
  const sideBySide = useStore((s) => sideBySideOnScreen(s.settings));
  const locked = useStore((s) => s.runtime.pointerLocked);
  const helpOpen = useStore((s) => s.helpOpen);
  const wheelOpen = useStore((s) => s.wheel !== null);
  const touch = useStore((s) => s.input === 'touch');
  const touchLooked = useStore((s) => s.touchLooked);
  const o = useOptics();

  useEffect(() => {
    const el = ref.current!;
    const setRuntime = useStore.getState().setRuntime;
    // Rotating a phone resizes the view, and that's when the insets change too.
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setRuntime({ viewport: { width: Math.floor(width), height: Math.floor(height) }, safeArea: readInsets(probe.current!) });
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

  let hint: string | null = null;
  if (!helpOpen && !wheelOpen) {
    if (touch) hint = touchLooked ? null : 'Drag to look around';
    else if (!locked) hint = 'Click to look around';
  }

  // The AF point, frame lines, finders and lens wheel belong to the view, so U doesn't hide them.
  return (
    <main className={wheelOpen ? 'viewport wheel-open' : 'viewport'} ref={ref} style={STICK_STYLE}>
      <div className="safe-probe" ref={probe} />
      <div className="frame-overlay" style={frameStyle}>
        {view === 'eye' && <FrameLines width={r.width} height={r.height} />}
        {(view === 'camera' || sideBySide) && <div className="af-point" />}
      </div>
      {sideBySide && <Finders />}
      <TouchLayer />
      <Hud debug={debug} timeOfDay={timeOfDay} frameWidth={r.width} />
      <LensWheel />
      <LoadingScreen />
      {hint && <div className={touch ? 'lock-hint touch' : 'lock-hint'}>{hint}</div>}
    </main>
  );
}
