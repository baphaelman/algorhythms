import { useEffect, useRef } from 'react';
import { attachCanvasInput } from '../canvas-input';
import { startScoreLoop } from '../loop';
import { attachPaletteDrop } from '../palette-drop';
import { usePlayer } from '../store';
import { ArrivalDots } from './ArrivalDots';

/** The score canvas. Drawn by `startScoreLoop` outside React; this component only mounts it. */
export function ScoreView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const voices = usePlayer((s) => s.compiled.voices.length);
  const title = usePlayer((s) => s.piece.meta.title);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const stopLoop = startScoreLoop(el, tip.current);
    const detach = attachCanvasInput(el);
    const detachDrop = attachPaletteDrop(el);
    return () => {
      stopLoop();
      detach();
      detachDrop();
    };
  }, []);

  return (
    <div className="stage" data-testid="stage">
      <canvas
        ref={canvas}
        id="score"
        role="img"
        aria-label={`Pitch lines for ${voices} voices over time: ${title}. Press Space to play and pause.`}
      />
      <ArrivalDots />
      <div ref={tip} className="score-hover" data-testid="score-hover" aria-hidden="true" hidden />
    </div>
  );
}
