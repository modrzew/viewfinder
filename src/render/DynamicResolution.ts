import { CONFIG } from '../config';

// Interactive render scale (§10.2: "interactive mode may drop resolution while fps < 45").
//
// It only drives the preview while something moves; refinement always renders at full resolution, so the
// still image is unaffected. It works from frame intervals alone because Firefox and Safari have no GPU timer
// queries: when the GPU can't keep up the browser delays requestAnimationFrame, so the interval between
// interactive frames is the frame cost the user feels.
//
// - Down a step when a window averages below `downFps`, unless the main thread alone takes most of the frame
//   (then a smaller image wouldn't help).
// - If a step down didn't speed things up, the GPU wasn't the limit: go back and stay at that scale for a while.
// - Up a step after `upFps` has held for a while. A step up that has to come straight back down doubles the
//   wait before that scale is tried again, so it settles instead of flickering between two scales.

const DR = CONFIG.dynamicResolution;

export class DynamicResolution {
  /** Mean fps of the last measurement window, for the debug overlay. */
  lastFps = 0;
  private level = 0;
  private lastNow = 0;
  /** Frames to leave out after a change: the first ones reallocate render targets. */
  private skip = 0;
  private sumMs = 0;
  private sumCpuMs = 0;
  private frames = 0;
  /** Time spent at `upFps` or better at this level, ms. */
  private goodMs = 0;
  /** Per level: how long it must run well at the level below before stepping up to it. */
  private readonly holdMs: number[] = DR.scales.map(() => DR.upHoldMs);
  /** Set after a step down, to check it helped: the fps before it. */
  private fpsBeforeDown: number | null = null;
  /** Lowest level to use (highest index) until `floorUntil`, after a step down didn't help. */
  private floor = DR.scales.length - 1;
  private floorUntil = 0;
  /** When the last step up happened, to spot one that had to be undone. */
  private stepUpAt = -Infinity;

  get scale(): number {
    return DR.enabled ? DR.scales[this.level] : 1;
  }

  /**
   * Call on every frame that rendered an interactive image. `cpuMs` is the main-thread cost of a recent frame.
   * Returns true when the scale changed.
   */
  frame(now: number, cpuMs: number): boolean {
    if (!DR.enabled) return false;
    const last = this.lastNow;
    this.lastNow = now;
    // Only consecutive interactive frames measure anything; a pause would read as one very slow frame.
    if (!last || now - last > DR.maxIntervalMs) return false;
    if (this.skip > 0) {
      this.skip--;
      return false;
    }
    this.sumMs += now - last;
    this.sumCpuMs += cpuMs;
    this.frames++;
    if (this.sumMs < DR.windowMs || this.frames < DR.minFrames) return false;

    const meanMs = this.sumMs / this.frames;
    const fps = 1000 / meanMs;
    this.lastFps = fps;
    const cpuBound = this.sumCpuMs / this.frames > DR.cpuBoundFraction * meanMs;
    const windowMs = this.sumMs;
    this.sumMs = this.sumCpuMs = this.frames = 0;
    const before = this.level;

    if (this.fpsBeforeDown !== null) {
      const helped = fps >= this.fpsBeforeDown * DR.minGain;
      this.fpsBeforeDown = null;
      if (!helped) {
        this.level--;
        this.floor = this.level;
        this.floorUntil = now + DR.floorHoldMs;
        this.goodMs = 0;
        this.skip = DR.skipFrames;
        return true;
      }
    }

    const maxLevel = now < this.floorUntil ? this.floor : DR.scales.length - 1;
    if (fps < DR.downFps && !cpuBound && this.level < maxLevel) {
      // Undoing a step up: wait longer before trying that scale again.
      if (now - this.stepUpAt < DR.stepUpTrialMs) {
        this.holdMs[this.level] = Math.min(this.holdMs[this.level] * 2, DR.maxUpHoldMs);
      }
      this.fpsBeforeDown = fps;
      this.level++;
      this.goodMs = 0;
    } else if (fps >= DR.upFps && this.level > 0) {
      this.goodMs += windowMs;
      if (this.goodMs >= this.holdMs[this.level - 1]) {
        this.level--;
        this.goodMs = 0;
        this.stepUpAt = now;
      }
    } else {
      this.goodMs = 0;
    }
    if (this.level === before) return false;
    this.skip = DR.skipFrames;
    return true;
  }

  /** Call on frames without an interactive render, so the gap isn't counted as frame time. */
  idle(): void {
    this.lastNow = 0;
  }
}
