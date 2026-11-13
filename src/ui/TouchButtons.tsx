import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CONFIG } from '../config';

/** A touch control on the HUD (§9.5). Its hit area reaches past what's drawn, as fingers are blunt. */
export function TouchButton({ label, className, onTap, disabled, children }: {
  label: string;
  className?: string;
  onTap: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={className ? `hud-button ${className}` : 'hud-button'}
      disabled={disabled}
      onClick={onTap}
    >
      {children}
    </button>
  );
}

/**
 * Steps once when pressed, then repeats while held, in big steps after a while, like a key held with Shift.
 * Released, or dragged off, it stops.
 */
export function RepeatButton({ label, className, onStep, children }: {
  label: string;
  className?: string;
  onStep: (big: boolean) => void;
  children: ReactNode;
}) {
  const timer = useRef(0);
  const stop = () => window.clearTimeout(timer.current);
  useEffect(() => stop, []);
  const start = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    stop();
    onStep(false);
    const t0 = performance.now();
    const c = CONFIG.touch;
    const next = (delay: number) => {
      timer.current = window.setTimeout(() => {
        onStep(performance.now() - t0 > c.bigAfterMs);
        next(c.repeatMs);
      }, delay);
    };
    next(c.repeatDelayMs);
  };
  return (
    <button
      type="button"
      aria-label={label}
      className={className ? `hud-button ${className}` : 'hud-button'}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

/** Held down: `onHold(true)`, released: `onHold(false)`. The owner resets whatever it holds if it unmounts. */
export function HoldButton({ label, className, onHold, children }: {
  label: string;
  className?: string;
  onHold: (down: boolean) => void;
  children: ReactNode;
}) {
  const held = useRef(false);
  const release = () => {
    if (!held.current) return;
    held.current = false;
    onHold(false);
  };
  return (
    <button
      type="button"
      aria-label={label}
      className={className ? `hud-button ${className}` : 'hud-button'}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        held.current = true;
        onHold(true);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}
