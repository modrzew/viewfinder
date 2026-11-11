import { formatDistanceM } from '../optics/focusScale';
import { formatFNumber } from '../optics/stops';
import { useOptics, useStore } from '../state/store';
import { centreText, dofText, fNumberHint, focalText, fovText, shutterText } from './format';

export function Readout() {
  const o = useOptics();
  const centre = useStore((s) => s.runtime.centreDistanceM);
  const hint = fNumberHint(o);

  const rows: [string, string, string?][] = [
    ['Focal length', focalText(o)],
    ['Field of view', fovText(o)],
    ['Aperture', formatFNumber(o.fNumber), hint ? `(${hint})` : undefined],
    ['Shutter', shutterText(o)],
    ['Focus', formatDistanceM(o.focusM)],
    ['Depth of field', dofText(o)],
    ['Hyperfocal', formatDistanceM(o.hyperfocalM)],
    ['Centre distance', centreText(centre)],
  ];

  return (
    <dl className="readout">
      {rows.map(([k, v, note]) => (
        <div key={k} className="readout-row">
          <dt>{k}</dt>
          <dd>
            {v}
            {note && <span className="readout-note">{note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
