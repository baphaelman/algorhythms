/**
 * Editor overlay (§10 Drawing rules 7): with one walk selected, its steps (`walkSteps`) as dots on
 * the lines, where each step's glide arrives. Clicking a dot selects the step (and its row in the
 * inspector's Steps list); the selected step is highlighted. Positioned by direct style writes on
 * every score frame, like the lane; the Steps list is the keyboard path, so dots aren't tab stops.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { WalkMoment } from '../../core/types';
import { pitchToY } from '../../render';
import { useEditor } from '../editor/history';
import { selectStep, useStepSelection } from '../editor/step-selection';
import { sameStep, stepsOf } from '../editor/walk-steps';
import { onScoreFrame } from '../loop';
import { usePlayer } from '../store';
import './walk-dots.css';

const MARGIN = 8;

export function WalkStepDots() {
  const selection = useEditor((s) => s.selection);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const selected = useStepSelection((s) => s.step);
  const walk = useMemo(() => {
    if (selection.length !== 1) return null;
    const m = piece.moments.find((x) => x.id === selection[0]);
    return m?.type === 'walk' ? (m as WalkMoment) : null;
  }, [selection, piece]);
  const steps = useMemo(() => (walk ? stepsOf(compiled, walk.id) : []), [walk, compiled]);

  const dots = useRef<(HTMLButtonElement | null)[]>([]);
  const geo = useRef<{ t: number; p: number }[]>([]);
  useLayoutEffect(() => {
    geo.current = steps.map((s) => ({ t: s.t + (walk?.stepGlide ?? 0), p: s.to }));
  }, [steps, walk]);

  useEffect(
    () =>
      onScoreFrame((v) => {
        const g = geo.current;
        for (let i = 0; i < g.length; i++) {
          const el = dots.current[i];
          if (!el) continue;
          const x = (g[i].t - v.start) * v.pps;
          const show = x >= -MARGIN && x <= v.width + MARGIN;
          const tf = show
            ? `translate(${x.toFixed(1)}px, ${pitchToY(v, g[i].p).toFixed(1)}px)`
            : '';
          if (el.style.transform !== tf) el.style.transform = tf;
          if (el.hidden === show) el.hidden = !show;
        }
      }),
    [],
  );

  if (!walk || steps.length === 0) return null;
  return (
    <div className="walk-dots" data-testid="walk-dots" aria-hidden="true">
      {steps.map((s, i) => {
        const ref = { momentId: s.momentId, tick: s.tick, voice: s.voice };
        const on = sameStep(ref, selected);
        return (
          <button
            key={`${s.tick}:${s.voice}`}
            ref={(el) => {
              dots.current[i] = el;
            }}
            type="button"
            tabIndex={-1}
            hidden
            className={on ? 'walk-dot on' : 'walk-dot'}
            data-testid="walk-dot"
            data-tick={s.tick}
            data-voice={s.voice}
            data-selected={on ? 'true' : undefined}
            onClick={() => selectStep(ref)}
          />
        );
      })}
    </div>
  );
}
