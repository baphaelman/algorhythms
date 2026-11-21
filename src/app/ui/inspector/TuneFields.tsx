/**
 * The tune inspector's note list (PLAN.md §6.2 `tune`, §11.3; R9-7): one row per note, in order:
 * its start, name (in the key at that time), length (beats with a tempo, else seconds), ▲/▼ by a
 * scale step and remove; "Add note" appends one. Each edit is one undo entry. R9-8: a text field
 * takes the notes typed ("F#5 2, E5 1, D5 1"), committed on Enter or blur once valid; a row and
 * the score's tune dot share the dot selection (picking a row selects its dot, and the other way
 * round).
 */

import { useEffect, useId, useMemo, useRef } from 'react';
import { activeAt, pitchAt } from '../../../core/query';
import type { Piece, TuneMoment, TuneNote } from '../../../core/types';
import { noteLabel } from '../../../render';
import { auditionPointsAfterEdit, auditionTuneAfterEdit } from '../../audition';
import { updateMoment } from '../../editor/actions';
import { clearDots, selectDots, useDotSelection } from '../../editor/dot-selection';
import {
  MIN_TUNE_LEN,
  addTuneNote,
  formatTuneText,
  lenFromShown,
  parseTuneText,
  lenShown,
  melodyOptions,
  melodyPatch,
  removeTuneNote,
  setTuneLen,
  stepTuneNote,
  tuneBeat,
  tuneDots,
  tuneNoteStarts,
} from '../../editor/tune';
import { usePlayer } from '../../store';
import { CompactNumber, Row, TextField, fieldSetter } from './controls';
import { keyAt } from './fields';

/** m:ss.ss (notes can be closer than the inspector's usual tenths). */
function noteTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs - m * 6000) / 100;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/**
 * "Melody on" (owner, 2026-11-21): which sounding note carries the tune. A note sets the target to
 * its voice; "Highest/Lowest of <part>" keeps the part and sets `line`. One undo entry per pick;
 * the first note sounds on its new line (stopped transport only).
 */
export function MelodyOn({ m, piece }: { m: TuneMoment; piece: Piece }) {
  const id = useId();
  const compiled = usePlayer((s) => s.compiled);
  const { options, current } = useMemo(
    () => melodyOptions(piece, compiled, m),
    [piece, compiled, m],
  );
  return (
    <Row label="Melody on" htmlFor={id}>
      <select
        id={id}
        value={current}
        data-testid="insp-melody-on"
        onChange={(e) => {
          const o = options.find((x) => x.value === e.target.value);
          if (!o || o.value === current) return;
          if (!updateMoment(m.id, melodyPatch(piece, m, o.choice), 'Change melody line')) return;
          const first = m.notes[0];
          if (first) auditionTuneAfterEdit(m.id, first.pitch, m.at + first.len / 2);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function TuneNotes({ m, piece }: { m: TuneMoment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const beat = tuneBeat(piece.view);
  const starts = tuneNoteStarts(m);
  const unit = beat ? 'beats' : 'seconds';
  const write = (notes: TuneNote[] | null, label: string): boolean =>
    notes !== null && updateMoment(m.id, { notes }, label);
  const sel = useDotSelection((s) => s.dots);
  /** Notes whose score dot is selected. */
  const picked = useMemo(() => {
    const out = new Set<number>();
    for (const d of sel) if (d.momentId === m.id && d.note !== undefined) out.add(d.note);
    return out;
  }, [sel, m.id]);
  const list = useRef<HTMLOListElement>(null);
  const first = picked.size > 0 ? Math.min(...picked) : -1;
  useEffect(() => {
    if (first < 0) return;
    list.current?.querySelector(`[data-index="${first}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [first]);
  const pick = (k: number): void => {
    if (picked.has(k) && picked.size === 1) {
      clearDots();
      return;
    }
    const d = tuneDots(compiled, m)[k];
    if (d) selectDots([d]);
  };
  const text = formatTuneText(m, beat, (t) => keyAt(compiled, t, piece.key));
  const lenSetter = (k: number) =>
    fieldSetter<number>(m.id, 'Edit note length', (x, v) => {
      const notes = (x as TuneMoment).notes;
      return { notes: setTuneLen(notes, k, lenFromShown(v, beat)) ?? notes };
    });

  return (
    <fieldset className="insp-group insp-steps insp-tune" data-testid="insp-tune-notes">
      <legend>
        Notes <span className="insp-count">{m.notes.length}</span>{' '}
        <span className="dim">lengths in {unit}</span>
      </legend>
      <TextField
        label="Type"
        value={text}
        placeholder={beat ? 'F#5 2, E5 1, D5 1' : 'F#5 1, E5 0.5, D5 0.5'}
        parse={(t) => {
          const r = parseTuneText(t, beat, m.notes);
          return r.ok ? { ok: true } : r;
        }}
        onCommit={(t) => {
          const r = parseTuneText(t, beat, m.notes);
          if (r.ok) write(r.notes, 'Type tune notes');
        }}
        testId="tune-text"
      />
      {m.notes.length === 0 ? (
        <p className="insp-note">No notes yet.</p>
      ) : (
        <ol ref={list}>
          {m.notes.map((n, k) => {
            const key = keyAt(compiled, starts[k], piece.key);
            const name = noteLabel(n.pitch, key);
            const desc = `note ${k + 1}, ${name} at ${noteTime(starts[k])}`;
            const step = (dir: 1 | -1): void => {
              const notes = stepTuneNote(m.notes, k, dir, key);
              if (!write(notes, 'Move tune note') || !notes) return;
              // Sounds the note at its new pitch once the edit has compiled (§11.3 auditioning).
              auditionPointsAfterEdit([{ pitch: notes[k].pitch, t: starts[k] + n.len / 2 }]);
            };
            return (
              <li
                key={k}
                data-testid="tune-note"
                data-index={k}
                className={picked.has(k) ? 'on' : undefined}
                data-picked={picked.has(k) ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="step-pick"
                  data-testid="tune-note-pick"
                  aria-pressed={picked.has(k)}
                  aria-label={`Select ${desc}`}
                  onClick={() => pick(k)}
                >
                  <span className="step-t">{noteTime(starts[k])}</span>
                  <span className="step-n" data-testid="tune-note-name">
                    {name}
                  </span>
                </button>
                <CompactNumber
                  value={lenShown(n.len, beat)}
                  set={lenSetter(k)}
                  min={beat ? MIN_TUNE_LEN / beat : MIN_TUNE_LEN}
                  max={beat ? 64 : 60}
                  step={beat ? 0.25 : 0.05}
                  bigStep={beat ? 1 : 0.5}
                  digits={beat ? 3 : 2}
                  glyph={beat ? '♩' : 's'}
                  title={`Length in ${unit}. Drag sideways to change`}
                  className="weight-box tune-len"
                  label={`Length of ${desc}, in ${unit}`}
                  testId="tune-note-len"
                />
                <button
                  type="button"
                  className="step-move"
                  data-testid="tune-note-up"
                  aria-label={`Up a scale step: ${desc}`}
                  onClick={() => step(1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="step-move"
                  data-testid="tune-note-down"
                  aria-label={`Down a scale step: ${desc}`}
                  onClick={() => step(-1)}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="step-move"
                  data-testid="tune-note-remove"
                  aria-label={`Remove ${desc}`}
                  title="Remove this note"
                  onClick={() => write(removeTuneNote(m.notes, k), 'Remove tune note')}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="insp-actions">
        <button
          type="button"
          data-testid="tune-add"
          onClick={() => {
            const end = starts.at(-1) ?? m.at;
            const key = keyAt(compiled, end, piece.key);
            // An empty tune starts on the lowest sounding note (the line it would take), else C4.
            const low = Math.min(
              ...activeAt(compiled, m.at).map((v) => pitchAt(compiled.voices[v], m.at) ?? 60),
            );
            write(
              addTuneNote(m.notes, key, Number.isFinite(low) ? low : 60, beat),
              'Add tune note',
            );
          }}
        >
          + Add note
        </button>
      </div>
    </fieldset>
  );
}
