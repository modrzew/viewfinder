import { useStore } from '../state/store';

/** Keys are drawn as key caps; mouse input is named. Grouped as on the HUD. */
const CONTROLS: [string | string[], string][] = [
  ['Click the view', 'Capture the mouse · Esc releases it'],
  ['Mouse', 'Look around'],
  [['W', 'A', 'S', 'D'], 'Walk (hold Shift to hurry)'],
  [['Q', 'E'], 'Lower / raise eye height'],
  [['R'], 'Back to spawn'],
  [['L'], 'Next lens (side by side: the next one shown)'],
  [['Space'], 'Hold for the lens wheel: release on a lens to select it, click to show or hide it side by side'],
  ['Wheel', 'Zoom the selected lens (zoom lenses; Shift ×5)'],
  [['[', ']'], 'Aperture wider / narrower by ⅓ stop'],
  [['−', '='], 'Focus nearer / farther (Shift ×10)'],
  [['X'], 'Exposure mode Av / M'],
  [['V'], 'Camera / Eye view'],
  [['C'], 'Side by side: a finder per lens over the eye view'],
  [['T'], 'Time of day: noon, golden hour, evening, night'],
  [['Tab'], 'Hold for details: field of view, hyperfocal distance and more'],
  [['U'], 'Hide / show the HUD'],
  [['H'], 'This help'],
];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  const close = () => useStore.getState().setHelpOpen(false);
  if (!open) return null;
  return (
    <div className="help" onClick={close}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <h1>Viewfinder</h1>
        <p>
          Walk through the scene and see it the way a Canon EOS 90D would: the lens sets the framing, and the
          aperture and focus set the depth of field. Hold still and the image refines to physically correct blur.
          Every setting is on the HUD next to the key that changes it.
        </p>
        <dl>
          {CONTROLS.map(([k, v]) => (
            <div key={v}>
              <dt>{typeof k === 'string' ? k : k.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="help-close" onClick={close}>Start</button>
      </div>
    </div>
  );
}
