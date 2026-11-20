/**
 * The walk's Steps list (§11.3 Walk, §6.2 Frozen walks): every step from `walkSteps` with ▲/▼.
 * The first move on an unfrozen walk freezes it (one undo entry). Rows and the score's step dots
 * share one selected step. The list scrolls inside a capped height, so long walks stay usable.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Piece, WalkMoment, WalkStepRecord } from '../../../core/types';
import { noteLabel } from '../../../render';
import { moveWalkStep } from '../../editor/actions';
import { selectStep, useStepSelection } from '../../editor/step-selection';
import { sameStep, stepsOf, type StepRef } from '../../editor/walk-steps';
import { usePlayer } from '../../store';
import { keyAt } from './fields';

/** m:ss.ss (ticks can be closer than the inspector's usual tenths). */
function stepTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs - m * 6000) / 100;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

const refOf = (s: WalkStepRecord): StepRef => ({
  momentId: s.momentId,
  tick: s.tick,
  voice: s.voice,
});

export function WalkSteps({ m, piece }: { m: WalkMoment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const selected = useStepSelection((s) => s.step);
  const steps = useMemo(() => stepsOf(compiled, m.id), [compiled, m.id]);
  const list = useRef<HTMLOListElement>(null);
  const names = useMemo(
    () => new Map(piece.voices.map((v) => [v.id, v.name ?? v.id] as const)),
    [piece.voices],
  );

  useEffect(() => {
    if (!selected || selected.momentId !== m.id) return;
    const row = list.current?.querySelector<HTMLElement>(
      `[data-tick="${selected.tick}"][data-voice="${CSS.escape(selected.voice)}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected, m.id]);

  return (
    <fieldset className="insp-group insp-steps" data-testid="insp-walk-step-list">
      <legend>
        Steps <span className="insp-count">{steps.length}</span>
      </legend>
      {steps.length === 0 ? (
        <p className="insp-note">No steps taken.</p>
      ) : (
        <ol ref={list}>
          {steps.map((s) => {
            const ref = refOf(s);
            const on = sameStep(ref, selected);
            const stored = m.fixed?.find((n) => n.tick === s.tick && n.voice === s.voice)?.pitch;
            const note = noteLabel(stored ?? s.to, keyAt(compiled, s.t, piece.key));
            const blocked = stored !== undefined && stored !== s.to;
            const voice = names.get(s.voice) ?? s.voice;
            const desc = `${voice} ${note} at ${stepTime(s.t)}`;
            return (
              <li
                key={`${s.tick}:${s.voice}`}
                data-testid="walk-step"
                data-tick={s.tick}
                data-voice={s.voice}
                className={on ? 'on' : undefined}
              >
                <button
                  type="button"
                  className="step-pick"
                  aria-pressed={on}
                  aria-label={`Select step: ${desc}`}
                  onClick={() => selectStep(on ? null : ref)}
                >
                  <span className="step-t">{stepTime(s.t)}</span>
                  <span className="step-v">{voice}</span>
                  <span className="step-n">
                    {note}
                    {blocked && <span title="Blocked: the voice holds"> ⊘</span>}
                  </span>
                </button>
                <button
                  type="button"
                  className="step-move"
                  data-testid="walk-step-up"
                  aria-label={`Up a scale step: ${desc}`}
                  onClick={() => {
                    selectStep(ref);
                    moveWalkStep(ref, 1);
                  }}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="step-move"
                  data-testid="walk-step-down"
                  aria-label={`Down a scale step: ${desc}`}
                  onClick={() => {
                    selectStep(ref);
                    moveWalkStep(ref, -1);
                  }}
                >
                  ▼
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </fieldset>
  );
}
