/**
 * Touch input for FpsController, like a virtual gamepad (§9.5): the touch UI writes it, the controller reads it
 * each frame. Look deltas accumulate until the controller consumes them.
 */
export const touchPad = {
  /** Joystick deflection, −1…1: forward and right. */
  forward: 0,
  strafe: 0,
  run: false,
  /** Eye height: −1 lowers, 1 raises, while a button is held. */
  height: 0,
  /** Finger travel on the view since the last frame, CSS px. */
  lookDx: 0,
  lookDy: 0,
  respawn: false,
};

export function releaseTouchPad(): void {
  Object.assign(touchPad, { forward: 0, strafe: 0, run: false, height: 0, lookDx: 0, lookDy: 0 });
}
