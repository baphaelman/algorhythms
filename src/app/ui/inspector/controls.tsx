/**
 * Inspector form controls and their edit plumbing. Every change goes through the M4b editor:
 * typed values are one `updateMoment` each; drags (number-label scrubbing, range sliders) are one
 * gesture each, so a whole drag is one undo entry.
 */

import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react';
import type { Moment, MomentId, Piece } from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import { beginGesture, cancelGesture, endGesture, updateGesture } from '../../editor/history';
import { patchMoment, type MomentPatch } from '../../editor/ops';
import { usePlayer } from '../../store';
import {
  SHIFT_OCTAVES,
  draftReduce,
  formatNum,
  formatShift,
  formatSigned,
  parseNum,
  shiftAtPosition,
  shiftPosition,
} from './fields';

/** Builds a patch from the moment as it is when the change applies. */
export type Patcher<V> = (m: Moment, v: V) => MomentPatch;

function find(p: Piece, id: MomentId): Moment | undefined {
  return p.moments.find((m) => m.id === id);
}

/** Applies `fn(moment)` to moment `id` as one undo entry. */
export function commit(id: MomentId, fn: (m: Moment) => MomentPatch, label: string): boolean {
  const m = find(usePlayer.getState().piece, id);
  return m ? updateMoment(id, fn(m), label) : false;
}

/** A value setter for one field: `commit` for typed values, `begin`/`drag`/`end` for drags. */
export interface Setter<V> {
  commit(v: V): void;
  begin(): void;
  drag(v: V): void;
  end(cancel?: boolean): void;
}

/** True while an inspector drag gesture is open (there is only one pointer). */
let dragging = false;

/**
 * A `Setter` for moment `id` whose patch comes from `patch(moment, value)`. Stateless apart from
 * the module's one open drag, so a fresh setter per render is fine.
 */
export function fieldSetter<V>(id: MomentId, label: string, patch: Patcher<V>): Setter<V> {
  const s: Setter<V> = {
    commit: (v) => void commit(id, (m) => patch(m, v), label),
    begin() {
      if (dragging) return;
      dragging = true;
      beginGesture(label);
    },
    drag(v) {
      if (!dragging) s.begin();
      // The recipe gets the piece at gesture start, so each frame patches from the same base.
      updateGesture((p) => {
        const m = find(p, id);
        return m ? patchMoment(p, id, patch(m, v)) : p;
      });
    },
    end(cancel = false) {
      if (!dragging) return;
      dragging = false;
      if (cancel) cancelGesture();
      else endGesture();
    },
  };
  return s;
}

// ---------------------------------------------------------------------------------------------

interface RowProps {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** A labelled row: label on the left, control on the right. */
export function Row({ label, htmlFor, children, className }: RowProps) {
  return (
    <div className={className ? `insp-row ${className}` : 'insp-row'}>
      {htmlFor ? (
        <label htmlFor={htmlFor}>{label}</label>
      ) : (
        <span className="insp-label">{label}</span>
      )}
      <div className="insp-ctl">{children}</div>
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  set: Setter<number>;
  min?: number;
  max?: number;
  /** Arrow-key and drag step (also the rounding unit when `integer`). */
  step?: number;
  integer?: boolean;
  unit?: string;
  format?: (v: number) => string;
  parse?: (text: string) => number | null;
  /** Extra validation; returns an error message or null. */
  check?: (v: number) => string | null;
  testId?: string;
  /** Adds a range slider over [min, max] (may be narrower than the typed range). */
  slider?: { min: number; max: number; step?: number };
}

/**
 * A number field. Type and press Enter (or leave the field) to commit; ↑/↓ step by `step`
 * (Shift ×10). Drag the label sideways to scrub: one undo entry per drag, Escape cancels. With
 * `slider`, a range slider sits before the text box; each slider drag is one undo entry too.
 * Disabled with its enclosing `<fieldset disabled>`.
 */
export function NumberField(props: NumberFieldProps) {
  const {
    label,
    value,
    set,
    min = -Infinity,
    max = Infinity,
    step = 0.1,
    integer = false,
    unit,
  } = props;
  const format = props.format ?? ((v: number) => formatNum(v));
  const id = useId();
  const shown = format(value);
  const [draft, dispatch] = useReducer(draftReduce, { text: shown, dirty: false });
  const text = draft.text;
  const setText = (t: string): void => dispatch({ type: 'set', text: t });
  const [error, setError] = useState<string | null>(null);

  // An outside change (undo, another edit) drops a typed draft: blur must not commit it.
  useEffect(() => {
    dispatch({ type: 'external', shown });
  }, [shown]);

  const clamp = (v: number): number => {
    const r = integer ? Math.round(v) : Math.round(v / step) * step;
    return Math.min(max, Math.max(min, Number(formatNum(r, 6))));
  };
  const parse = (t: string): number | null => {
    const v = props.parse ? props.parse(t) : parseNum(t);
    if (v === null) return null;
    if (integer && !Number.isInteger(v)) return null;
    return v >= min && v <= max ? v : null;
  };
  const describe = (): string => {
    const parts: string[] = [integer ? 'a whole number' : 'a number'];
    if (min > -Infinity && max < Infinity)
      parts.push(`from ${formatNum(min)} to ${formatNum(max)}`);
    else if (min > -Infinity) parts.push(`of at least ${formatNum(min)}`);
    else if (max < Infinity) parts.push(`of at most ${formatNum(max)}`);
    return `Enter ${parts.join(' ')}.`;
  };

  const submit = (): void => {
    const v = parse(text);
    if (v === null) {
      setError(props.parse ? 'Not a valid value.' : describe());
      return;
    }
    const bad = props.check?.(v) ?? null;
    if (bad) {
      setError(bad);
      return;
    }
    setError(null);
    if (v !== value) set.commit(v);
    setText(format(v));
  };

  // Label scrubbing.
  const drag = useRef<{ x: number; v0: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLLabelElement>): void => {
    if (e.button !== 0) return;
    if (document.getElementById(id)?.matches(':disabled')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, v0: value, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLLabelElement>): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const v = clamp(d.v0 + Math.round(dx / 4) * step * (e.shiftKey ? 10 : 1));
    if (props.check?.(v)) return;
    set.drag(v);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLLabelElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) set.end();
    else document.getElementById(id)?.focus();
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="insp-row">
      <label
        htmlFor={id}
        className="scrub-label"
        title="Drag sideways to change"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          if (drag.current?.moved) set.end(true);
          drag.current = null;
        }}
      >
        {label}
      </label>
      <div className={props.slider ? 'insp-ctl with-slider' : 'insp-ctl'}>
        {props.slider && (
          <RangeInput
            label={label}
            value={value}
            set={set}
            min={props.slider.min}
            max={props.slider.max}
            step={props.slider.step ?? step}
            filter={(v) => (props.check?.(v) ? null : v)}
            testId={props.testId ? `${props.testId}-slider` : undefined}
          />
        )}
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          data-testid={props.testId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onBlur={() => {
            if (!draft.dirty) {
              setText(shown);
              setError(null);
              return;
            }
            submit();
            if (parse(text) === null) {
              setText(shown);
              setError(null);
            }
          }}
          onChange={(e) => dispatch({ type: 'type', text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              setText(shown);
              setError(null);
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const base = parse(text) ?? value;
              const v = clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
              if (props.check?.(v)) return;
              setError(null);
              setText(format(v));
              if (v !== value) set.commit(v);
            }
          }}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {error && (
        <small id={`${id}-err`} className="field-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  set: Setter<number>;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  testId?: string;
}

/**
 * A bare range input on a `Setter`: a pointer drag is one undo entry (one gesture from pointer
 * down to up); a held arrow key is one entry per key release. `filter` may reject a value (null).
 */
function RangeInput({
  id,
  label,
  value,
  set,
  min,
  max,
  step,
  filter,
  testId,
}: {
  id?: string;
  label?: string;
  value: number;
  set: Setter<number>;
  min: number;
  max: number;
  step: number;
  filter?: (v: number) => number | null;
  testId?: string;
}) {
  const end = (): void => set.end();
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={Math.min(max, Math.max(min, value))}
      aria-label={id ? undefined : label}
      data-testid={testId}
      onPointerDown={() => set.begin()}
      onChange={(e) => {
        const v = filter ? filter(Number(e.target.value)) : Number(e.target.value);
        if (v !== null) set.drag(v);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyUp={end}
      onBlur={end}
    />
  );
}

/** A range slider with its value shown: a pointer drag is one undo entry; each key press is one. */
export function Slider({ label, value, set, min, max, step, format, testId }: SliderProps) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <RangeInput id={id} value={value} set={set} min={min} max={max} step={step} testId={testId} />
      <output htmlFor={id} className="unit">
        {format ? format(value) : formatNum(value, 2)}
      </output>
    </Row>
  );
}

/**
 * The shift amount slider (§11.3): centred on 0, ±SHIFT_OCTAVES octaves of `octave` steps, with
 * a mark at each octave that a drag snaps to. A pointer drag is one undo entry (heard while
 * dragging); ←/→ (↑/↓) step by 1 and Page Up/Down by an octave, one entry per press.
 */
export function ShiftSlider({
  label,
  value,
  set,
  octave,
  testId,
}: {
  label: string;
  value: number;
  set: Setter<number>;
  octave: number;
  testId?: string;
}) {
  const id = useId();
  const r = SHIFT_OCTAVES * octave;
  const marks: number[] = [];
  for (let k = -SHIFT_OCTAVES; k <= SHIFT_OCTAVES; k++) marks.push(k * octave);
  const end = (): void => set.end();
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const d: Record<string, number> = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageDown: -octave,
      PageUp: octave,
      Home: -2 * r,
      End: 2 * r,
    };
    const step = d[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const v = Math.min(r, Math.max(-r, Math.round(value) + step));
    if (v !== value) set.commit(v);
  };
  return (
    <Row label={label} htmlFor={id}>
      {/* Marks are drawn, not a <datalist>: Chrome snaps `step="any"` thumbs to datalist ticks. */}
      <span className="shift-track">
        <input
          id={id}
          type="range"
          min={-r}
          max={r}
          step="any"
          value={Math.min(r, Math.max(-r, value))}
          aria-valuetext={formatShift(value, octave)}
          data-testid={testId}
          onPointerDown={() => set.begin()}
          onChange={(e) => {
            const v = shiftAtPosition((Number(e.target.value) + r) / (2 * r), octave);
            if (v !== value) set.drag(v);
          }}
          onKeyDown={onKeyDown}
          onPointerUp={end}
          onPointerCancel={end}
          onBlur={end}
        />
        {marks.map((v) => (
          <i
            key={v}
            aria-hidden="true"
            className={v === 0 ? 'shift-mark zero' : 'shift-mark'}
            style={{ left: `calc(8px + (100% - 16px) * ${shiftPosition(v, octave)})` }}
          />
        ))}
      </span>
      <output
        htmlFor={id}
        className="unit shift-value"
        title={formatShift(value, octave)}
        data-testid={testId && `${testId}-value`}
      >
        {formatSigned(value)}
      </output>
    </Row>
  );
}

/**
 * A row of toggle chips (`aria-pressed` buttons) in a labelled group. `pressed` decides each
 * chip's state; `onPick` runs on click. Disabled with its enclosing `<fieldset disabled>`.
 */
export function Chips<T extends string | number>({
  legend,
  options,
  pressed,
  onPick,
  className,
  testId,
}: {
  legend: string;
  options: readonly (readonly [T, string])[];
  pressed: (v: T) => boolean;
  onPick: (v: T) => void;
  className?: string;
  testId?: string;
}) {
  return (
    <fieldset className={className ? `chips ${className}` : 'chips'} data-testid={testId}>
      <legend>{legend}</legend>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={pressed(v)} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </fieldset>
  );
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  testId?: string;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: SelectFieldProps<T>) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <select
        id={id}
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="insp-check">
      <input
        type="checkbox"
        checked={checked}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * A text field that commits on Enter or blur, only when `parse` accepts the text. `feedback`
 * describes the current text live (ok or error).
 */
export function TextField({
  label,
  value,
  parse,
  onCommit,
  feedback,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  parse: (text: string) => { ok: true } | { ok: false; error: string };
  onCommit: (text: string) => void;
  feedback?: (text: string) => { ok: boolean; text: string } | null;
  placeholder?: string;
  testId?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [shownError, setShownError] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  const live = feedback ? feedback(text) : null;
  const submit = (): void => {
    const r = parse(text);
    if (!r.ok) {
      setShownError(r.error);
      return;
    }
    setShownError(null);
    if (text !== value) onCommit(text);
  };
  const error = shownError ?? (live && !live.ok ? live.text : null);

  return (
    <div className="insp-row">
      <label htmlFor={id}>{label}</label>
      <div className="insp-ctl">
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={placeholder}
          data-testid={testId}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-fb`}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            submit();
          }}
          onChange={(e) => {
            setText(e.target.value);
            setShownError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              setText(value);
              setShownError(null);
            }
          }}
        />
      </div>
      <small
        id={`${id}-fb`}
        className={error ? 'field-error' : 'insp-feedback'}
        aria-live="polite"
        data-testid={testId ? `${testId}-feedback` : undefined}
      >
        {error ?? (live?.ok ? live.text : '')}
      </small>
    </div>
  );
}

/**
 * A compact note-weight box for a note row (revision 8): "×" then the weight. Type and press
 * Enter (or leave) to commit; ↑/↓ step by 0.25 (Shift: 1), one entry per press. Drag the "×"
 * sideways to scrub: one undo entry per drag.
 */
export function WeightBox({
  value,
  set,
  min,
  max,
  label,
  testId,
}: {
  value: number;
  set: Setter<number>;
  min: number;
  max: number;
  label: string;
  testId?: string;
}) {
  const id = useId();
  const shown = formatNum(value, 2);
  const [draft, dispatch] = useReducer(draftReduce, { text: shown, dirty: false });
  const text = draft.text;
  const setText = (t: string): void => dispatch({ type: 'set', text: t });
  // An outside change (undo) drops a typed draft.
  useEffect(() => {
    dispatch({ type: 'external', shown });
  }, [shown]);
  const clamp = (v: number): number => Math.min(max, Math.max(min, Math.round(v * 100) / 100));
  const submit = (): void => {
    if (!draft.dirty) return;
    const v = parseNum(text, min, max);
    if (v === null) {
      setText(shown);
      return;
    }
    if (Math.abs(v - value) > 1e-9) set.commit(v);
    setText(formatNum(v, 2));
  };
  const drag = useRef<{ x: number; v0: number; moved: boolean } | null>(null);
  return (
    <span className="weight-box">
      <label
        htmlFor={id}
        className="scrub-label"
        title="Weight: loudness, as this many lines. Drag sideways to change"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, v0: value, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          if (!d.moved && Math.abs(dx) < 3) return;
          d.moved = true;
          set.drag(clamp(d.v0 + Math.round(dx / 6) * (e.shiftKey ? 1 : 0.25)));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.moved) set.end();
          else document.getElementById(id)?.focus();
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          if (drag.current?.moved) set.end(true);
          drag.current = null;
        }}
      >
        ×
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        value={text}
        data-testid={testId}
        onBlur={submit}
        onChange={(e) => {
          dispatch({ type: 'type', text: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            setText(shown);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = parseNum(text, min, max) ?? value;
            const v = clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1 : 0.25));
            setText(formatNum(v, 2));
            if (Math.abs(v - value) > 1e-9) set.commit(v);
          }
        }}
      />
    </span>
  );
}
