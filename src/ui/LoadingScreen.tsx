import { useStore } from '../state/store';

const mb = (n: number) => (n / 1e6).toFixed(1);

export function LoadingScreen() {
  const loading = useStore((s) => s.runtime.loading);
  if (!loading) return null;
  const { loadedBytes, totalBytes, stage } = loading;
  const pct = totalBytes > 0 ? Math.min(100, (loadedBytes / totalBytes) * 100) : 0;
  return (
    <div className="loading">
      <div className="loading-card">
        <h1>Setting up the courtyard</h1>
        <p>{stage === 'shaders' ? 'Compiling shaders' : `${mb(loadedBytes)} / ${mb(totalBytes)} MB`}</p>
        <div className="loading-bar"><div style={{ width: `${pct}%` }} /></div>
      </div>
    </div>
  );
}
