/**
 * Inspector form controls and their edit plumbing. Every change goes through the M4b editor:
 * typed values are one `updateMoment` each; drags (number-label scrubbing, range sliders) are one
 * gesture each, so a whole drag is one undo entry.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Moment, MomentId, Piece } from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import { beginGesture, cancelGesture, endGesture, updateGesture } from '../../editor/history';
import { patchMoment, type MomentPatch } from '../../editor/ops';
import { usePlayer } from '../../store';
import { formatNum, parseNum } from './fields';

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
}

/**
 * A number field. Type and press Enter (or leave the field) to commit; ↑/↓ step by `step`
 * (Shift ×10). Drag the label sideways to scrub: one undo entry per drag, Escape cancels.
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
  const [text, setText] = useState(format(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const shown = format(value);

  useEffect(() => {
    if (!focused.current) setText(shown);
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
      <div className="insp-ctl">
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
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            submit();
            if (parse(text) === null) {
              setText(shown);
              setError(null);
            }
          }}
          onChange={(e) => setText(e.target.value)}
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

/** A range slider: a pointer drag is one undo entry; each key press is one. */
export function Slider({ label, value, set, min, max, step, format, testId }: SliderProps) {
  const id = useId();
  const end = (): void => set.end();
  return (
    <Row label={label} htmlFor={id}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        onPointerDown={() => set.begin()}
        onChange={(e) => set.drag(Number(e.target.value))}
        onPointerUp={end}
        onKeyUp={end}
        onBlur={end}
      />
      <output htmlFor={id} className="unit">
        {format ? format(value) : formatNum(value, 2)}
      </output>
    </Row>
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
