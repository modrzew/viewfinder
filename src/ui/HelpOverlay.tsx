import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { MdPinch } from 'react-icons/md';
import {
  TbArrowsExchange, TbCamera, TbChartDonut, TbChevronLeft, TbChevronRight, TbChevronUp, TbColumns2, TbEyeOff,
  TbHandMove, TbHelp, TbHome, TbListDetails, TbMaximize, TbSunLow, TbWalk,
} from 'react-icons/tb';
import { useStore } from '../state/store';
import { fullscreenSupported } from './input';

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

/** Touch (§9.5): gestures are named, HUD buttons drawn as their icons. */
const TOUCH_CONTROLS: [string | IconType[], string][] = [
  [[TbHandMove], 'Drag the view to look around'],
  [[TbWalk], 'Thumb on the lower left of the view: walk. Push past the ring to hurry'],
  [[TbChevronUp], 'Hold to raise or lower your eye height'],
  [[MdPinch], 'Pinch, or drag the zoom bar: zoom the selected lens (zoom lenses)'],
  ['Bars', 'Drag or tap the aperture and focus bars'],
  [[TbChevronLeft, TbChevronRight], 'Aperture or focus by a step; hold to keep going'],
  [[TbArrowsExchange], 'Tap the exposure row: Av / M'],
  ['Slots', 'Tap a lens slot to select it'],
  [[TbChartDonut], 'Lens wheel: tap a lens, then select it or show it side by side'],
  [[TbCamera], 'Camera / Eye view'],
  [[TbColumns2], 'Side by side: a finder per lens over the eye view. Tap a finder to select its lens'],
  [[TbSunLow], 'Time of day: noon, golden hour, evening, night'],
  [[TbHome], 'Back to spawn'],
  ...(fullscreenSupported ? [[[TbMaximize], 'Full screen'] as [IconType[], string]] : []),
  [[TbListDetails], 'Details: field of view, hyperfocal distance and more'],
  [[TbEyeOff], 'Hide the HUD'],
  [[TbHelp], 'This help'],
];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  const touch = useStore((s) => s.input === 'touch');
  const portrait = useStore((s) => s.runtime.viewport.height > s.runtime.viewport.width);
  const close = () => useStore.getState().setHelpOpen(false);
  if (!open) return null;
  const rows: [ReactNode, string][] = touch
    ? TOUCH_CONTROLS.map(([k, v]) => [typeof k === 'string' ? k : k.map((Icon, i) => <Icon key={i} />), v])
    : CONTROLS.map(([k, v]) => [typeof k === 'string' ? k : k.map((key) => <kbd key={key}>{key}</kbd>), v]);
  return (
    <div className={touch ? 'help touch' : 'help'} onClick={close}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <h1>Viewfinder</h1>
        <p>
          Walk through the scene and see it the way a Canon EOS 90D would: the lens sets the framing, and the
          aperture and focus set the depth of field. Hold still and the image refines to physically correct blur.
          {touch
            ? ' Every setting is on the HUD: tap it or drag it.'
            : ' Every setting is on the HUD next to the key that changes it.'}
          {touch && portrait && ' Turn your phone sideways for a bigger view.'}
        </p>
        <dl>
          {rows.map(([k, v]) => (
            <div key={v}>
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
