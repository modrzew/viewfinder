import { useStore } from '../state/store';

const CONTROLS: [string, string][] = [
  ['Click viewport', 'Capture the mouse · Esc releases it'],
  ['Mouse', 'Look around'],
  ['W A S D', 'Walk (hold Shift to hurry)'],
  ['Q / E', 'Lower / raise eye height'],
  ['Wheel', 'Zoom (zoom lenses; Shift ×5)'],
  ['[ / ]', 'Aperture wider / narrower by ⅓ stop'],
  ['− / =', 'Focus nearer / farther (Shift ×10)'],
  ['V', 'Camera / Eye view'],
  ['X', 'Exposure mode Av / M'],
  ['L', 'Next lens'],
  ['T', 'Time of day: noon, golden hour, evening, night'],
  ['R', 'Back to spawn'],
  ['H', 'This help'],
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
        </p>
        <dl>
          {CONTROLS.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="help-close" onClick={close}>Start</button>
      </div>
    </div>
  );
}
