import { useState } from 'react';
import { useStore } from '../state/store';

/** `?bench=1`: a plain status line while it runs (no blur, so it doesn't cost frames), then the report. */
export function BenchmarkOverlay() {
  const bench = useStore((s) => s.bench);
  const [copied, setCopied] = useState(false);
  if (!bench) return null;
  if (!bench.report) return <div className="bench-status">Benchmark · {bench.status}</div>;
  const copy = () => {
    void navigator.clipboard.writeText(bench.report!).then(() => setCopied(true));
  };
  return (
    <div className="bench">
      <pre>{bench.report}</pre>
      <div className="bench-actions">
        <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" onClick={() => useStore.getState().setBench(null)}>Close</button>
      </div>
    </div>
  );
}
