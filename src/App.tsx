import { buildTestScene } from './scene/testScene';
import type { SceneSetup } from './scene/types';
import { ControlPanel } from './ui/ControlPanel';
import { HelpOverlay } from './ui/HelpOverlay';
import { useShortcuts } from './ui/shortcuts';
import { Viewport } from './ui/Viewport';
import { useStore } from './state/store';

const params = new URLSearchParams(window.location.search);
const DEBUG = params.get('debug') === '1';

function loadScene(): Promise<SceneSetup> {
  return Promise.resolve(buildTestScene());
}

/** WebGL2 with float render targets is required (§4). */
function unsupportedReason(): string | null {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'This browser does not support WebGL2.';
  const ok = gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return ok ? null : 'This browser cannot render to floating-point textures (EXT_color_buffer_float).';
}

const UNSUPPORTED = unsupportedReason();

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="error-screen">
      <h1>Viewfinder can’t run here</h1>
      <p>{message}</p>
      <p>Try the latest desktop Chrome, Safari or Firefox.</p>
    </div>
  );
}

export default function App() {
  useShortcuts(DEBUG);
  const error = useStore((s) => s.runtime.error);
  if (UNSUPPORTED) return <ErrorScreen message={UNSUPPORTED} />;
  if (error) return <ErrorScreen message={error} />;
  return (
    <div className="app">
      <Viewport loadScene={loadScene} debug={DEBUG} />
      <ControlPanel />
      <HelpOverlay />
    </div>
  );
}
