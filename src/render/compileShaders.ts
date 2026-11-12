import type { Camera, Object3D, WebGLRenderer, WebGLRenderTarget } from 'three';

// Shader compilation that doesn't freeze the page.
//
// three.js picks a program variant from the render target bound when a material is compiled: the screen gets
// tone mapping and sRGB output, a render target gets linear output. The scene only ever renders into a linear
// HDR target, so compiling while the screen is bound builds variants nothing uses, and the real ones then
// compile synchronously on first draw.
//
// Waiting for the compile is browser-specific:
// - With KHR_parallel_shader_compile (Chrome, Safari) three's compileAsync polls each program.
// - Firefox doesn't have the extension. Its WebGL runs in the GPU process, which compiles and links in command
//   order, and any query about a program (three asks for its info log on first use) blocks the page until the
//   link is done: about 2 s on the first frame of the courtyard. A fence issued after the compiles signals once
//   the GPU process has got past them, and polling a fence never blocks in Firefox. So: compile, fence, poll,
//   then ask the first-use questions while nothing else is queued.

const POLL_MS = 8;

/**
 * Whether the GPU has passed `sync`, without waiting. Same answer as getSyncParameter(SYNC_STATUS), but the
 * flush bit keeps Firefox from warning that a fence polled 100 times without it may never signal.
 */
export function syncSignaled(gl: WebGL2RenderingContext, sync: WebGLSync): boolean {
  const r = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
  return r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED;
}

/** Whether the browser compiles shaders in parallel and can say when they're done. */
export function hasParallelShaderCompile(renderer: WebGLRenderer): boolean {
  return renderer.extensions.has('KHR_parallel_shader_compile');
}

/** Resolves once the GPU has finished all commands issued so far. Never blocks the main thread. */
export function gpuIdle(renderer: WebGLRenderer): Promise<void> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return Promise.resolve();
  gl.flush();
  return new Promise((resolve) => {
    const poll = () => {
      if (gl.isContextLost() || syncSignaled(gl, sync)) {
        gl.deleteSync(sync);
        resolve();
      } else {
        setTimeout(poll, POLL_MS);
      }
    };
    setTimeout(poll, POLL_MS);
  });
}

export interface CompileJob {
  /** What to compile, e.g. a scene or a group of full-screen quads. */
  object: Object3D;
  camera: Camera;
  /** The render target it will draw into; null for the screen. Selects the program variant. */
  target: WebGLRenderTarget | null;
}

/**
 * Compiles every material in the jobs and resolves when they can be drawn without stalling. Lights and the
 * environment come from each job's object, so set them up first (a time of day's lights, for example).
 */
export async function compileWithoutStalling(renderer: WebGLRenderer, jobs: CompileJob[]): Promise<void> {
  const parallel = hasParallelShaderCompile(renderer);
  const previous = renderer.getRenderTarget();
  const pending: Promise<unknown>[] = [];
  try {
    for (const job of jobs) {
      renderer.setRenderTarget(job.target);
      // compileAsync compiles synchronously before returning, so the target only needs to be bound for the call.
      if (parallel) pending.push(renderer.compileAsync(job.object, job.camera));
      else renderer.compile(job.object, job.camera);
    }
  } finally {
    renderer.setRenderTarget(previous);
  }
  if (!parallel) pending.push(gpuIdle(renderer));
  await Promise.all(pending);
  // three asks for each program's info log and uniform locations the first time it draws with it. Those calls
  // are synchronous, and mid-render they wait behind the draws already queued, including any shader variant the
  // driver builds at draw time. Asked now, with the GPU idle and the programs linked, they return at once, and
  // the first render makes no synchronous calls at all.
  for (const program of renderer.info.programs ?? []) {
    program.getUniforms();
    program.getAttributes();
  }
}
