import { useEffect, useState } from 'react';
import { useStore, type InputMode } from '../state/store';

/**
 * Follows the pointer in use (§9.5): a finger or pen switches the HUD to touch controls, and a mouse click or
 * move switches it back, so a laptop with a touch screen gets whichever UI it's being used with.
 */
export function useInputMode(): void {
  useEffect(() => {
    const switchTo = (input: InputMode) => {
      if (useStore.getState().input !== input) useStore.getState().setInput(input);
    };
    const onDown = (e: PointerEvent) => switchTo(e.pointerType === 'mouse' ? 'mouse' : 'touch');
    // Taps also send mouse events, but never pointer events of the mouse type.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && (e.movementX !== 0 || e.movementY !== 0)) switchTo('mouse');
    };
    // iOS Safari zooms the page on a pinch even where touch-action forbids it, unless its gesture events are cancelled.
    const onGesture = (e: Event) => e.preventDefault();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    document.addEventListener('gesturestart', onGesture);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('gesturestart', onGesture);
    };
  }, []);
}

interface FullscreenDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

const doc = document as FullscreenDocument;

/** iPhone Safari has no Fullscreen API for pages; iPad Safari has it, older versions prefixed. */
export const fullscreenSupported = Boolean(document.fullscreenEnabled || doc.webkitFullscreenEnabled);

const fullscreenElement = () => document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

export function toggleFullscreen(): void {
  if (fullscreenElement()) {
    void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch(() => {});
    return;
  }
  const el = document.documentElement as FullscreenElement;
  void (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.())?.catch(() => {});
}

export function useFullscreen(): boolean {
  const [on, setOn] = useState(() => fullscreenElement() !== null);
  useEffect(() => {
    const onChange = () => setOn(fullscreenElement() !== null);
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  return on;
}
