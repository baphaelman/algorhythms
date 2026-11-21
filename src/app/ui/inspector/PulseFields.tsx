/**
 * The pulse inspector (PLAN.md §6.2 `pulse`, §11.3; R9-7): region, step (beat values with a
 * tempo), the accent pattern as a row of step cells, decay, floor, mode and re-strike. Every edit
 * is one undo entry; a drag on a cell or a slider is one gesture.
 */

import { useRef, useState } from 'react';
import type { Piece, PulseMoment } from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import {
  BEAT_VALUES,
  PULSE_MODES,
  accentAtY,
  addStep,
  beatSeconds,
  beatValueOf,
  removeStep,
  setAccent,
} from '../../editor/pulse';
import { tuneBeat } from '../../editor/tune';
import { CheckField, Chips, NumberField, fieldSetter } from './controls';
import { formatNum } from './fields';

const round6 = (t: number): number => Math.round(t * 1e6) / 1e6;

export function PulseFields({ m, piece }: { m: PulseMoment; piece: Piece }) {
  const beat = tuneBeat(piece.view);
  const region = fieldSetter<number>(m.id, 'Edit pulse region', (x, v) => ({
    until: round6(x.at + v),
  }));
  const step = fieldSetter<number>(m.id, 'Edit pulse step', (_x, v) => ({ step: v }));
  const decay = fieldSetter<number>(m.id, 'Edit decay', (_x, v) => ({ decay: v }));
  const floor = fieldSetter<number>(m.id, 'Edit floor', (_x, v) => ({ floor: v / 100 }));
  const len = m.until - m.at;
  const picked = beatValueOf(m.step, beat);
  return (
    <>
      <NumberField
        label="Region"
        unit="s"
        value={len}
        set={region}
        min={0.05}
        step={0.5}
        slider={{ min: 1, max: Math.max(30, Math.ceil(len / 10) * 10) }}
        testId="insp-pulse-region"
      />
      {beat !== null && (
        <Chips
          legend="Step"
          className="beat-values"
          testId="insp-pulse-beats"
          options={BEAT_VALUES}
          pressed={(b) => b === picked}
          onPick={(b) => {
            const s = beatSeconds(b, beat);
            if (s !== m.step) updateMoment(m.id, { step: s }, 'Change pulse step');
          }}
        />
      )}
      <NumberField
        label={beat !== null ? 'Step (s)' : 'Step'}
        unit="s"
        value={m.step}
        set={step}
        min={0.01}
        max={10}
        step={0.01}
        slider={{ min: 0.05, max: 2 }}
        testId="insp-pulse-step"
      />
      <PatternCells m={m} />
      <NumberField
        label="Decay"
        unit="s"
        value={m.decay}
        set={decay}
        min={0}
        max={10}
        step={0.05}
        slider={{ min: 0, max: 2 }}
        testId="insp-pulse-decay"
      />
      <NumberField
        label="Floor"
        unit="%"
        value={Math.round(m.floor * 100)}
        set={floor}
        integer
        step={1}
        min={0}
        max={100}
        slider={{ min: 0, max: 100 }}
        testId="insp-pulse-floor"
      />
      <Chips
        legend="Mode"
        className="pulse-modes"
        testId="insp-pulse-mode"
        options={PULSE_MODES}
        pressed={(v) => v === m.mode}
        onPick={(mode) => mode !== m.mode && updateMoment(m.id, { mode }, 'Change pulse mode')}
      />
      <CheckField
        label="Re-strike each hit"
        checked={m.strike !== false}
        testId="insp-pulse-strike"
        title="Plucked and struck sounds sound again on every hit"
        onChange={(on) =>
          updateMoment(m.id, { strike: on ? undefined : false }, on ? 'Re-strike' : 'No re-strike')
        }
      />
    </>
  );
}

/** "50 %" or "rest". */
const accentText = (a: number): string => (a > 0 ? `${formatNum(a * 100, 0)} %` : 'rest');

/**
 * The pattern: one cell per step, its fill the accent (empty: a rest). Press or drag on a cell to
 * set its accent from the height (one undo entry per press); keys on a focused cell: ↑/↓ by 5 %
 * (Shift or Page keys: 25 %), Home rests it, End sets it to full, ←/→ move between cells.
 */
function PatternCells({ m }: { m: PulseMoment }) {
  const [focus, setFocus] = useState(0);
  const cells = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<{ pointerId: number; i: number } | null>(null);
  const n = m.pattern.length;
  const cur = Math.min(focus, n - 1);

  const setter = (i: number) =>
    fieldSetter<number>(m.id, 'Edit accent', (x, v) => ({
      pattern: setAccent((x as PulseMoment).pattern, i, v) ?? (x as PulseMoment).pattern,
    }));
  const at = (e: React.PointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return accentAtY(e.clientY - r.top, r.height);
  };
  const commitKey = (i: number, v: number): void => {
    const p = setAccent(m.pattern, i, v);
    if (p) updateMoment(m.id, { pattern: p }, 'Edit accent');
  };
  const move = (i: number): void => {
    const j = Math.max(0, Math.min(n - 1, i));
    setFocus(j);
    cells.current[j]?.focus();
  };

  return (
    <fieldset className="insp-group pulse-pattern" data-testid="insp-pulse-pattern">
      <legend>
        Pattern <span className="insp-count">{n}</span>
      </legend>
      <div className="pulse-cells" role="group" aria-label="Accent per step">
        {m.pattern.map((a, i) => (
          <div
            key={i}
            ref={(el) => {
              cells.current[i] = el;
            }}
            className="pulse-cell"
            data-testid="pulse-cell"
            data-rest={a <= 0 || undefined}
            role="slider"
            tabIndex={i === cur ? 0 : -1}
            aria-label={`Step ${i + 1} accent`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(a * 100)}
            aria-valuetext={accentText(a)}
            title={`Step ${i + 1}: ${accentText(a)}. Drag up or down; Home rests it`}
            onFocus={() => setFocus(i)}
            onPointerDown={(e) => {
              if (e.button !== 0 || drag.current) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setFocus(i);
              drag.current = { pointerId: e.pointerId, i };
              const s = setter(i);
              s.begin();
              s.drag(at(e));
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d?.pointerId === e.pointerId) setter(d.i).drag(at(e));
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              if (d?.pointerId !== e.pointerId) return;
              drag.current = null;
              setter(d.i).end();
              cells.current[d.i]?.focus();
            }}
            onPointerCancel={(e) => {
              const d = drag.current;
              if (d?.pointerId !== e.pointerId) return;
              drag.current = null;
              setter(d.i).end(true);
            }}
            onKeyDown={(e) => {
              const big = e.shiftKey ? 0.25 : 0.05;
              let v: number | null = null;
              if (e.key === 'ArrowUp') v = a + big;
              else if (e.key === 'ArrowDown') v = a - big;
              else if (e.key === 'PageUp') v = a + 0.25;
              else if (e.key === 'PageDown') v = a - 0.25;
              else if (e.key === 'Home') v = 0;
              else if (e.key === 'End') v = 1;
              else if (e.key === 'ArrowLeft') move(i - 1);
              else if (e.key === 'ArrowRight') move(i + 1);
              else return;
              e.preventDefault();
              e.stopPropagation();
              if (v !== null) commitKey(i, v);
            }}
          >
            <span className="pulse-fill" style={{ height: `${Math.round(a * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="pulse-steps">
        <button
          type="button"
          data-testid="pulse-add-step"
          aria-label="Add a step"
          disabled={addStep(m.pattern) === null}
          onClick={() => {
            const p = addStep(m.pattern);
            if (p) updateMoment(m.id, { pattern: p }, 'Add pulse step');
          }}
        >
          + step
        </button>
        <button
          type="button"
          data-testid="pulse-remove-step"
          aria-label="Remove the last step"
          disabled={removeStep(m.pattern) === null}
          onClick={() => {
            const p = removeStep(m.pattern);
            if (p) updateMoment(m.id, { pattern: p }, 'Remove pulse step');
          }}
        >
          − step
        </button>
      </div>
    </fieldset>
  );
}
