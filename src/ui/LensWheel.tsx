import { useEffect, useState, type CSSProperties } from 'react';
import { PiMouseLeftClickBold } from 'react-icons/pi';
import { TbColumns2 } from 'react-icons/tb';
import { CONFIG } from '../config';
import { getBody } from '../optics/bodies';
import { lensesFor } from '../optics/lenses';
import { hudScale } from '../render/layout';
import { sideBySideOnScreen, useStore, type Settings } from '../state/store';
import { lensApertureLabel, lensFocalLabel } from './format';
import { aimAngle, moveAim, polar, sliceAngle, sliceArc, sliceAt, slicePath } from './wheel';

/** Ring radii and the gap between slices, CSS px at HUD scale 1. */
const OUTER = 196;
const INNER = 104;
const GAP = 5;
const LABEL_RADIUS = (OUTER + INNER) / 2;
const SIZE = 2 * (OUTER + 6);

/** What a left click on the lens would do, and whether it can. */
function clickAction(s: Settings, lensId: string): { text: string; enabled: boolean } {
  const ids = s.sideBySideLensIds;
  if (!sideBySideOnScreen(s)) return { text: 'Show side by side', enabled: true };
  if (ids.includes(lensId)) return { text: 'Remove from side by side', enabled: ids.length > 1 };
  return { text: 'Add to side by side', enabled: ids.length < CONFIG.sideBySide.maxFinders };
}

/**
 * Hold Space for a radial menu of the lenses, like a shooter's weapon wheel (§9.2). The mouse steers it
 * instead of looking around; releasing Space selects the lens under the aim, and a left click adds or removes
 * its finder side by side instead (after a click, releasing only closes the wheel). It belongs to the view, so
 * U doesn't hide it.
 */
export function LensWheel() {
  const open = useStore((s) => s.wheel !== null);
  return open ? <OpenWheel /> : null;
}

function OpenWheel() {
  const [aim, setAim] = useState({ x: 0, y: 0 });
  const settings = useStore((s) => s.settings);
  const highlighted = useStore((s) => s.wheel?.lensId ?? null);
  const clicked = useStore((s) => s.wheel?.clicked ?? false);
  const height = useStore((s) => s.runtime.viewport.height);
  const bodyId = settings.bodyId;

  // Mouse movement from the moment it opens is the aim, with or without pointer lock.
  useEffect(() => {
    const ids = lensesFor(getBody(bodyId)).map((l) => l.id);
    let a = { x: 0, y: 0 };
    const onMove = (e: MouseEvent) => {
      a = moveAim(a, e.movementX, e.movementY);
      setAim(a);
      const i = sliceAt(a, ids.length);
      useStore.getState().setWheelLens(i < 0 ? null : ids[i]);
    };
    // FpsController ignores this click, so it doesn't also capture the mouse.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      useStore.getState().clickWheel();
    };
    const onLockChange = () => {
      if (!document.pointerLockElement) useStore.getState().closeWheel(false);
    };
    document.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);
    document.addEventListener('pointerlockchange', onLockChange);
    return () => {
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      document.removeEventListener('pointerlockchange', onLockChange);
    };
  }, [bodyId]);

  const lenses = lensesFor(getBody(bodyId));
  const n = lenses.length;
  const onScreen = sideBySideOnScreen(settings);
  const lens = lenses.find((l) => l.id === highlighted) ?? null;
  const click = lens ? clickAction(settings, lens.id) : null;
  const aiming = Math.hypot(aim.x, aim.y) >= CONFIG.lensWheel.deadZonePx;
  const pointer = polar(aimAngle(aim), INNER - 9);

  return (
    <div className="wheel-scrim">
      <div className="wheel" style={{ '--hud-scale': hudScale(height), width: SIZE, height: SIZE } as CSSProperties}>
        <svg viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
          {lenses.map((l, i) => (
            <path key={l.id} className={l.id === highlighted ? 'wheel-slice on' : 'wheel-slice'} d={slicePath(i, n, INNER, OUTER, GAP)} />
          ))}
          {lenses.map((l, i) => l.id === settings.lensId && (
            <path key={l.id} className="wheel-selected" d={sliceArc(i, n, OUTER - 4, GAP)} />
          ))}
          <circle className="wheel-hub-plate" r={INNER - GAP} />
          {aiming && (
            <path
              className="wheel-pointer"
              d="M 0 -7 L 6 3 L -6 3 Z"
              transform={`translate(${pointer.x} ${pointer.y}) rotate(${(aimAngle(aim) * 180) / Math.PI})`}
            />
          )}
        </svg>
        {lenses.map((l, i) => {
          const p = polar(sliceAngle(i, n), LABEL_RADIUS);
          const classes = ['wheel-label'];
          if (l.id === highlighted) classes.push('on');
          if (l.id === settings.lensId) classes.push('selected');
          const finder = settings.sideBySideLensIds.includes(l.id);
          return (
            <div key={l.id} className={classes.join(' ')} style={{ left: SIZE / 2 + p.x, top: SIZE / 2 + p.y }}>
              <span className="wheel-label-focal">{lensFocalLabel(l)}<small>mm</small></span>
              <span className="wheel-label-aperture">{lensApertureLabel(l)}</span>
              {finder && <TbColumns2 className={onScreen ? 'wheel-label-finder' : 'wheel-label-finder off'} />}
            </div>
          );
        })}
        <div className="wheel-hub">
          {lens && click ? (
            <>
              <div className="wheel-hub-name">{lens.name}</div>
              <div className="wheel-prompt"><kbd>Space</kbd>{clicked ? 'Close' : 'Select'}</div>
              <div className={click.enabled ? 'wheel-prompt' : 'wheel-prompt off'}>
                <PiMouseLeftClickBold />{click.text}
              </div>
            </>
          ) : (
            <>
              <div className="wheel-hub-name">Lenses</div>
              <div className="wheel-hub-hint">Move the mouse to a lens</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
