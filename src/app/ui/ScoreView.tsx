import { useEffect, useRef } from 'react';
import { attachCanvasInput } from '../canvas-input';
import { startScoreLoop } from '../loop';
import { usePlayer } from '../store';

/** The score canvas. Drawn by `startScoreLoop` outside React; this component only mounts it. */
export function ScoreView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const voices = usePlayer((s) => s.compiled.voices.length);
  const title = usePlayer((s) => s.piece.meta.title);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const stopLoop = startScoreLoop(el);
    const detach = attachCanvasInput(el);
    return () => {
      stopLoop();
      detach();
    };
  }, []);

  return (
    <div className="stage" data-testid="stage">
      <canvas
        ref={canvas}
        id="score"
        role="img"
        aria-label={`Pitch lines for ${voices} voices over time: ${title}. Click or press Space to play and pause.`}
      />
    </div>
  );
}
