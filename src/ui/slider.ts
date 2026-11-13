import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

/** A bar of `count` segments used as a slider: `fraction` 0…1 runs from the first segment's centre to the last's. */
export interface Slider {
  count: number;
  fraction: number;
  set: (fraction: number) => void;
}

/**
 * Pointer handlers that make an element holding a `.hud-segments` bar a slider. A touch on a segment jumps to
 * it; dragging then moves by the finger's travel. Only travel is measured, never where the bar is on screen,
 * because browsers have disagreed on the client rects of elements inside CSS zoom: `offsetWidth` is in the
 * bar's own px everywhere, and the HUD scale turns it into screen px. The HUD's tilt draws the bar a little
 * narrower than that; its client rect says how much where it can be trusted, hence the bounds.
 */
export function useSliderDrag(slider: Slider | undefined, scale: number) {
  const drag = useRef<{ id: number; x0: number; f0: number; pxPerUnit: number; last: number } | null>(null);
  if (!slider) return {};
  const steps = Math.max(slider.count - 1, 1);
  const update = (f: number) => {
    const d = drag.current!;
    const clamped = Math.min(Math.max(f, 0), 1);
    if (clamped === d.last) return;
    d.last = clamped;
    slider.set(clamped);
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (e.button !== 0 || target.closest('button')) return;
      const bar = e.currentTarget.querySelector<HTMLElement>('.hud-segments');
      if (!bar) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      // The segment under the touch point itself: browsers move a touch's target to a likely element nearby.
      const seg = document.elementsFromPoint(e.clientX, e.clientY)
        .find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.seg !== undefined && bar.contains(el));
      const f0 = seg ? Number(seg.dataset.seg) / steps : slider.fraction;
      // One segment's pitch per step, so the mark stays under the finger.
      const laidOut = bar.offsetWidth * scale;
      const tilt = Math.min(Math.max(bar.getBoundingClientRect().width / laidOut, 0.85), 1) || 1;
      const pitch = (laidOut * tilt) / slider.count;
      drag.current = { id: e.pointerId, x0: e.clientX, f0, pxPerUnit: pitch * steps, last: slider.fraction };
      if (seg) update(f0);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      update(d.f0 + (e.clientX - d.x0) / d.pxPerUnit);
    },
    onPointerUp: () => {
      drag.current = null;
    },
    onPointerCancel: () => {
      drag.current = null;
    },
  };
}
