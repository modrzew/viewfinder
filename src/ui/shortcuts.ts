import { useEffect } from 'react';
import { formControlFocused } from '../render/FpsController';
import { useStore } from '../state/store';

/** Settings shortcuts (§9.3). Movement keys live in FpsController. */
export function useShortcuts(debug: boolean, timeOfDay: boolean): void {
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
        case 'KeyT': if (timeOfDay && !e.repeat) s.nextTimeOfDay(); else handled = false; break;
        case 'KeyH': if (!e.repeat) s.setHelpOpen(!s.helpOpen); break;
        case 'KeyU': if (!e.repeat) s.setHudVisible(!s.hudVisible); break;
        case 'Tab': s.setDetailsOpen(true); break;
        case 'Escape': s.setHelpOpen(false); handled = false; break;
        case 'Digit1': if (debug) s.togglePass('gather'); break;
        case 'Digit2': if (debug) s.togglePass('refine'); break;
        case 'Digit3': if (debug) s.togglePass('vignette'); break;
        case 'Digit4': if (debug) s.togglePass('residual'); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };
    // Details show only while Tab is held.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Tab') useStore.getState().setDetailsOpen(false);
    };
    const onBlur = () => useStore.getState().setDetailsOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [debug, timeOfDay]);
}
