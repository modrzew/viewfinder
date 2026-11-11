import type { WebGLRenderer } from 'three';
import { useStore } from '../state/store';

/** The parts of EXT_disjoint_timer_query_webgl2 used here. */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const WINDOW_MS = 500;
/** Fences in flight at most; while full, new frames wait for the next fence. */
const MAX_FENCES = 64;

/**
 * Counts the frames that draw something, and what each costs on the CPU and GPU. Ticks that draw nothing
 * (a finished still image) don't count.
 *
 * fps counts frames the GPU has finished, not frames sent to it: a browser may keep calling rAF while the
 * GPU falls behind, so the rate of sending can be far higher than what the GPU delivers. rAF never runs
 * faster than the display refreshes, so fps tops out there; GPU time shows the headroom beyond it. It needs
 * EXT_disjoint_timer_query_webgl2, which Chrome has and Safari and Firefox don't.
 */
export class FrameStats {
  private readonly renderer: WebGLRenderer;
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt | null;
  /** Fences after drawn frames, oldest first, with how many frames each one completes. */
  private readonly fences: { sync: WebGLSync; frames: number }[] = [];
  /** Drawn frames not yet behind a fence. */
  private unfenced = 0;
  /** Timer queries awaiting results, oldest first. */
  private readonly pending: { query: WebGLQuery; drew: boolean }[] = [];
  private readonly free: WebGLQuery[] = [];
  private query: WebGLQuery | null = null;
  private renderCount = 0;
  private start = 0;

  private windowStart = 0;
  private finished = 0;
  private drawn = 0;
  private cpuMs = 0;
  private gpuMs = 0;
  private gpuFrames = 0;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  }

  begin(): void {
    this.collectFences();
    this.collectGpu();
    this.renderCount = this.renderer.info.render.frame;
    this.start = performance.now();
    if (this.ext) {
      this.query = this.free.pop() ?? this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    }
  }

  end(now: number): void {
    const gl = this.gl;
    // Every pass goes through renderer.render(), which bumps this counter.
    const drew = this.renderer.info.render.frame !== this.renderCount;
    if (drew) {
      this.drawn++;
      this.unfenced++;
      this.cpuMs += performance.now() - this.start;
    }
    if (this.query) {
      gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
      this.pending.push({ query: this.query, drew });
      this.query = null;
    }
    // A fence signals once the GPU has finished everything before it, so it marks these frames done.
    if (this.unfenced && this.fences.length < MAX_FENCES) {
      this.fences.push({ sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!, frames: this.unfenced });
      gl.flush();
      this.unfenced = 0;
    }

    if (!this.windowStart) this.windowStart = now;
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return;
    useStore.getState().setDebug({
      fps: (this.finished * 1000) / elapsed,
      cpuMs: this.drawn ? this.cpuMs / this.drawn : null,
      gpuMs: this.gpuFrames ? this.gpuMs / this.gpuFrames : null,
    });
    this.windowStart = now;
    this.finished = this.drawn = this.cpuMs = this.gpuMs = this.gpuFrames = 0;
  }

  dispose(): void {
    for (const f of this.fences) this.gl.deleteSync(f.sync);
    for (const q of [...this.free, ...this.pending.map((p) => p.query)]) this.gl.deleteQuery(q);
    this.fences.length = this.free.length = this.pending.length = 0;
  }

  private collectFences(): void {
    const gl = this.gl;
    while (this.fences.length && gl.getSyncParameter(this.fences[0].sync, gl.SYNC_STATUS) === gl.SIGNALED) {
      const f = this.fences.shift()!;
      gl.deleteSync(f.sync);
      this.finished += f.frames;
    }
  }

  /** Reads finished timer queries; results arrive a few frames late. */
  private collectGpu(): void {
    if (!this.ext) return;
    const gl = this.gl;
    // A disjoint event (e.g. a GPU clock change) makes every result in flight meaningless.
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      for (const p of this.pending) this.free.push(p.query);
      this.pending.length = 0;
      return;
    }
    while (this.pending.length && gl.getQueryParameter(this.pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const { query, drew } = this.pending.shift()!;
      if (drew) {
        this.gpuMs += gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        this.gpuFrames++;
      }
      this.free.push(query);
    }
  }
}
