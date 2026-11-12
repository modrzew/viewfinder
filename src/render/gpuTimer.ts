// GPU timer queries (EXT_disjoint_timer_query), for the GPU time in the fps counter and the benchmark.
//
// - Chrome: EXT_disjoint_timer_query_webgl2, through the WebGL2 query calls.
// - Firefox: only with `webgl.enable-privileged-extensions` set to true in about:config, and then under the
//   WebGL1 name EXT_disjoint_timer_query even on a WebGL2 context. Its own query methods must be used: the
//   WebGL2 calls accept TIME_ELAPSED_EXT but return a timestamp rather than the elapsed time.
// - Safari: none.

/** One TIME_ELAPSED query at a time, as the extension allows. */
export interface GpuTimer {
  create(): WebGLQuery;
  begin(q: WebGLQuery): void;
  end(): void;
  available(q: WebGLQuery): boolean;
  /** Elapsed GPU time, ns. Only once available. */
  result(q: WebGLQuery): number;
  /** True if a disjoint event (e.g. a GPU clock change) has made every result in flight meaningless. */
  disjoint(): boolean;
  delete(q: WebGLQuery): void;
}

interface Webgl2TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface Webgl1TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
  QUERY_RESULT_EXT: number;
  QUERY_RESULT_AVAILABLE_EXT: number;
  createQueryEXT(): WebGLQuery;
  deleteQueryEXT(q: WebGLQuery): void;
  beginQueryEXT(target: number, q: WebGLQuery): void;
  endQueryEXT(target: number): void;
  getQueryObjectEXT(q: WebGLQuery, pname: number): number | boolean;
}

export function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  const ext2 = gl.getExtension('EXT_disjoint_timer_query_webgl2') as Webgl2TimerExt | null;
  if (ext2) {
    return {
      create: () => gl.createQuery()!,
      begin: (q) => gl.beginQuery(ext2.TIME_ELAPSED_EXT, q),
      end: () => gl.endQuery(ext2.TIME_ELAPSED_EXT),
      available: (q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean,
      result: (q) => gl.getQueryParameter(q, gl.QUERY_RESULT) as number,
      disjoint: () => !!gl.getParameter(ext2.GPU_DISJOINT_EXT),
      delete: (q) => gl.deleteQuery(q),
    };
  }
  const ext1 = gl.getExtension('EXT_disjoint_timer_query') as Webgl1TimerExt | null;
  if (ext1) {
    return {
      create: () => ext1.createQueryEXT(),
      begin: (q) => ext1.beginQueryEXT(ext1.TIME_ELAPSED_EXT, q),
      end: () => ext1.endQueryEXT(ext1.TIME_ELAPSED_EXT),
      available: (q) => !!ext1.getQueryObjectEXT(q, ext1.QUERY_RESULT_AVAILABLE_EXT),
      result: (q) => ext1.getQueryObjectEXT(q, ext1.QUERY_RESULT_EXT) as number,
      disjoint: () => !!gl.getParameter(ext1.GPU_DISJOINT_EXT),
      delete: (q) => ext1.deleteQueryEXT(q),
    };
  }
  return null;
}
