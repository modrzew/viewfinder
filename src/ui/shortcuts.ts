import { useEffect } from 'react';
import { formControlFocused } from '../render/FpsController';
import { useStore } from '../state/store';

/** Settings shortcuts (§9.3). Movement keys live in FpsController. */
export function useShortcuts(debug: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || formControlFocused()) return;
      const s = useStore.getState();
      const big = e.shiftKey ? 10 : 1;
      let handled = true;
      switch (e.code) {
        case 'BracketLeft': s.stepAperture(-1); break;
        case 'BracketRight': s.stepAperture(1); break;
        case 'Minus': case 'NumpadSubtract': s.stepFocus(-big); break;
        case 'Equal': case 'NumpadAdd': s.stepFocus(big); break;
        case 'KeyV': if (!e.repeat) s.toggleView(); break;
        case 'KeyX': if (!e.repeat) s.toggleExposureMode(); break;
        case 'KeyL': if (!e.repeat) s.nextLens(); break;
        case 'KeyH': if (!e.repeat) s.setHelpOpen(!s.helpOpen); break;
        case 'Escape': s.setHelpOpen(false); handled = false; break;
        case 'Digit1': if (debug) s.togglePass('gather'); break;
        case 'Digit2': if (debug) s.togglePass('refine'); break;
        case 'Digit3': if (debug) s.togglePass('vignette'); break;
        case 'Digit4': if (debug) s.togglePass('residual'); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [debug]);
}
