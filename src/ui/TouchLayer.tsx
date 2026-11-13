import { useEffect, useRef } from 'react';
import { CONFIG } from '../config';
import { getLens, isZoom } from '../optics/lenses';
import { finderRectsOf, focalOf, sideBySideOnScreen, useStore } from '../state/store';
import { releaseTouchPad, touchPad } from '../state/touchPad';

interface Look {
  x: number;
  y: number;
  /** Where and when it landed, to tell a tap from a drag. */
  x0: number;
  y0: number;
  t0: number;
  /** It's been part of a pinch, so lifting it isn't a tap. */
  pinched: boolean;
}

interface Stick { id: number; x: number; y: number; t0: number; moved: boolean }

/**
 * Touch gestures on the view (§9.5), under the HUD so its controls get their own touches first:
 * - a thumb on the lower left of the view is a joystick, centred where it lands: it walks, and pushed past the
 *   ring it hurries;
 * - any other finger looks around, dragging the scene with it;
 * - two fingers pinch to zoom the selected lens (zoom lenses);
 * - side by side, a tap on a finder selects its lens.
 */
export function TouchLayer() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current!;
    const c = CONFIG.touch;
    const looks = new Map<number, Look>();
    let stick: Stick | null = null;
    let pinch: { d0: number; f0: number } | null = null;

    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const moveStick = (s: Stick, dx: number, dy: number) => {
      const R = c.stickRadiusPx;
      const d = Math.hypot(dx, dy);
      const k = d > R ? R / d : 1;
      const run = d > R * c.runAt;
      touchPad.strafe = (dx * k) / R;
      touchPad.forward = (-dy * k) / R;
      touchPad.run = run;
      useStore.getState().setTouchStick({ x: s.x, y: s.y, dx: dx * k, dy: dy * k, run });
    };
    const endStick = () => {
      stick = null;
      touchPad.forward = touchPad.strafe = 0;
      touchPad.run = false;
      useStore.getState().setTouchStick(null);
    };

    const firstTwo = () => [...looks.values()].slice(0, 2);
    const startPinch = () => {
      const [a, b] = firstTwo();
      const s = useStore.getState().settings;
      pinch = { d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), f0: focalOf(s, s.lensId) };
      a.pinched = b.pinched = true;
    };
    const updatePinch = () => {
      if (!pinch) return;
      const [a, b] = firstTwo();
      const s = useStore.getState();
      if (!isZoom(getLens(s.settings.lensId))) return;
      const focal = Math.round((pinch.f0 * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d0);
      if (focal !== focalOf(s.settings, s.settings.lensId)) s.setFocal(focal);
    };

    const addLook = (id: number, x: number, y: number, t: number) => {
      looks.set(id, { x, y, x0: x, y0: y, t0: t, pinched: false });
      if (looks.size === 2) startPinch();
    };

    /** Side by side, a tap on a finder selects its lens. */
    const tap = (x: number, y: number) => {
      const s = useStore.getState();
      if (!sideBySideOnScreen(s.settings)) return;
      const i = finderRectsOf(s).findIndex((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
      const id = s.settings.sideBySideLensIds[i];
      if (id && id !== s.settings.lensId) s.setLens(id);
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      el.setPointerCapture(e.pointerId);
      const { x, y } = local(e);
      const zone = c.stickZone;
      if (!stick && x < zone.maxX * el.clientWidth && y > zone.minY * el.clientHeight) {
        stick = { id: e.pointerId, x, y, t0: e.timeStamp, moved: false };
        moveStick(stick, 0, 0);
        return;
      }
      // A second finger right after the first landed in the walk zone, and close to it: the pair is a pinch.
      if (stick && looks.size === 0 && !stick.moved && e.timeStamp - stick.t0 < c.pinchGraceMs
        && Math.hypot(x - stick.x, y - stick.y) < c.pinchMaxSpreadPx) {
        const { id, x: sx, y: sy, t0 } = stick;
        endStick();
        addLook(id, sx, sy, t0);
      }
      addLook(e.pointerId, x, y, e.timeStamp);
    };

    const onMove = (e: PointerEvent) => {
      const { x, y } = local(e);
      if (stick?.id === e.pointerId) {
        const dx = x - stick.x;
        const dy = y - stick.y;
        if (Math.hypot(dx, dy) > c.stickMoveTolerancePx) stick.moved = true;
        moveStick(stick, dx, dy);
        return;
      }
      const look = looks.get(e.pointerId);
      if (!look) return;
      const dx = x - look.x;
      const dy = y - look.y;
      look.x = x;
      look.y = y;
      if (looks.size >= 2) {
        updatePinch();
        return;
      }
      touchPad.lookDx += dx;
      touchPad.lookDy += dy;
      if (Math.hypot(x - look.x0, y - look.y0) > c.tapSlopPx) useStore.getState().setTouchLooked();
    };

    const onUp = (e: PointerEvent) => {
      if (stick?.id === e.pointerId) {
        endStick();
        return;
      }
      const look = looks.get(e.pointerId);
      if (!look) return;
      looks.delete(e.pointerId);
      const still = Math.hypot(look.x - look.x0, look.y - look.y0) <= c.tapSlopPx;
      if (e.type === 'pointerup' && still && !look.pinched && e.timeStamp - look.t0 < c.tapMs) tap(look.x, look.y);
      // A third finger lifting leaves a new pair to pinch with; one finger left goes on looking from where it is.
      pinch = null;
      if (looks.size >= 2) startPinch();
    };

    const onBlur = () => {
      looks.clear();
      pinch = null;
      endStick();
      releaseTouchPad();
    };

    // A long press would open the context menu on Android.
    const onContextMenu = (e: Event) => {
      if (useStore.getState().input === 'touch') e.preventDefault();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, []);

  return (
    <div className="touch-layer" ref={ref}>
      <TouchStickView />
    </div>
  );
}

/** The joystick under the thumb while it's held. */
function TouchStickView() {
  const stick = useStore((s) => s.touchStick);
  if (!stick) return null;
  return (
    <div className={stick.run ? 'touch-stick run' : 'touch-stick'} style={{ left: stick.x, top: stick.y }}>
      <div className="touch-stick-knob" style={{ transform: `translate(${stick.dx}px, ${stick.dy}px)` }} />
    </div>
  );
}
