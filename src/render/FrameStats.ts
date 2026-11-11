import type { WebGLRenderer } from 'three';
import { useStore } from '../state/store';

/** The parts of EXT_disjoint_timer_query_webgl2 used here. */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const WINDOW_MS = 500;

/**
 * Counts the frames that draw something, and what each costs on the CPU and GPU. Ticks that draw nothing
 * (a finished still image) don't count. rAF never runs faster than the display refreshes, so fps tops out
 * there; GPU time shows the headroom beyond it. It needs EXT_disjoint_timer_query_webgl2, which Chrome has
 * and Safari and Firefox don't.
 */
export class FrameStats {
  private readonly renderer: WebGLRenderer;
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt | null;
  /** Timer queries awaiting results, oldest first. */
  private readonly pending: { query: WebGLQuery; drew: boolean }[] = [];
  private readonly free: WebGLQuery[] = [];
  private query: WebGLQuery | null = null;
  private renderCount = 0;
  private start = 0;

  private windowStart = 0;
  private frames = 0;
  private cpuMs = 0;
  private gpuMs = 0;
  private gpuFrames = 0;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  }

  begin(): void {
    this.collectGpu();
    this.renderCount = this.renderer.info.render.frame;
    this.start = performance.now();
    if (this.ext) {
      this.query = this.free.pop() ?? this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    }
  }

  end(now: number): void {
    // Every pass goes through renderer.render(), which bumps this counter.
    const drew = this.renderer.info.render.frame !== this.renderCount;
    if (drew) {
      this.frames++;
      this.cpuMs += performance.now() - this.start;
    }
    if (this.query) {
      this.gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
      this.pending.push({ query: this.query, drew });
      this.query = null;
    }

    if (!this.windowStart) this.windowStart = now;
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return;
    useStore.getState().setDebug({
      fps: (this.frames * 1000) / elapsed,
      cpuMs: this.frames ? this.cpuMs / this.frames : null,
      gpuMs: this.gpuFrames ? this.gpuMs / this.gpuFrames : null,
    });
    this.windowStart = now;
    this.frames = this.cpuMs = this.gpuMs = this.gpuFrames = 0;
  }

  dispose(): void {
    for (const q of [...this.free, ...this.pending.map((p) => p.query)]) this.gl.deleteQuery(q);
    this.free.length = this.pending.length = 0;
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
