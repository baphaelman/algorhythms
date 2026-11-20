import { useRef, useState } from 'react';
import { createTestTone, stopTestTone } from '../audio/test-tone';
import { setDebug } from './debug';

type Status = 'idle' | 'starting' | 'playing' | 'error';

interface Engine {
  context: AudioContext;
  node: AudioWorkletNode;
}

const STATUS_TEXT: Record<Status, string> = {
  idle: 'Stopped',
  starting: 'Starting…',
  playing: 'Playing a 440 Hz sine through the AudioWorklet',
  error: 'Audio failed to start',
};

/** M0 placeholder page: one button that plays a 440 Hz sine through the TypeScript worklet. */
export function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const engine = useRef<Engine | null>(null);

  async function start() {
    setStatus('starting');
    // Create and resume the context synchronously inside the click, for Safari's autoplay rules.
    const context = new AudioContext({ latencyHint: 'playback' });
    void context.resume();
    try {
      const node = await createTestTone(context, { frequency: 440, amplitude: 0.2 });
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      node.connect(context.destination);
      node.connect(analyser);
      await context.resume();
      engine.current = { context, node };
      setDebug({ context, analyser });
      setStatus('playing');
    } catch (e) {
      void context.close();
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  function stop() {
    const current = engine.current;
    if (!current) return;
    engine.current = null;
    stopTestTone(current.node, 0.02);
    window.setTimeout(() => void current.context.close(), 100);
    setDebug({ context: undefined, analyser: undefined });
    setStatus('idle');
  }

  const playing = status === 'playing';
  return (
    <main className="page">
      <h1>AlgoRhythms</h1>
      <p className="tagline">An instrument and composer for pitch-line music. Coming soon.</p>
      <button
        type="button"
        className="play"
        onClick={playing ? stop : () => void start()}
        disabled={status === 'starting'}
      >
        {playing ? 'Stop' : 'Play'}
      </button>
      <p role="status" data-testid="status">
        {STATUS_TEXT[status]}
        {status === 'error' && error ? `: ${error}` : ''}
      </p>
    </main>
  );
}
