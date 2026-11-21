/**
 * The tune inspector's note list (PLAN.md §6.2 `tune`, §11.3; R9-7): one row per note, in order:
 * its start, name (in the key at that time), length (beats with a tempo, else seconds), ▲/▼ by a
 * scale step and remove; "Add note" appends one. Each edit is one undo entry. R9-8: a text field
 * takes the notes typed ("F#5 2, E5 1, D5 1"), committed on Enter or blur once valid; a row and
 * the score's tune dot share the dot selection (picking a row selects its dot, and the other way
 * round). "Random melody" replaces the notes with a fresh roll (owner, 2026-11-21).
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { activeAt, pitchAt } from '../../../core/query';
import type { Piece, TuneMoment, TuneNote } from '../../../core/types';
import { noteLabel } from '../../../render';
import {
  auditionMelodyAfterEdit,
  auditionPointsAfterEdit,
  auditionTuneAfterEdit,
} from '../../audition';
import { updateMoment } from '../../editor/actions';
import { randomU32 } from '../../editor/ops';
import { clearDots, selectDots, useDotSelection } from '../../editor/dot-selection';
import {
  MIN_TUNE_LEN,
  addTuneNote,
  formatTuneText,
  lenFromShown,
  parseTuneText,
  lenShown,
  melodyMove,
  melodyOptions,
  melodyVoice,
  type MelodyOption,
  randomMelody,
  removeTuneNote,
  setTuneLen,
  stepTuneNote,
  tuneBeat,
  tuneDots,
  tuneNoteStarts,
} from '../../editor/tune';
import { setLineHighlight } from '../../line-highlight';
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
 * its voice; "Highest/Lowest of <part>" keeps the part and sets `line`; either moves the notes to
 * the new line (`melodyMove`). One undo entry per pick; the first note sounds on its new line
 * (stopped transport only). A listbox, not a native select, so hovering or arrowing to an option
 * can highlight its line on the score (`setLineHighlight`).
 */
export function MelodyOn({ m, piece }: { m: TuneMoment; piece: Piece }) {
  const id = useId();
  const listId = `${id}-list`;
  const compiled = usePlayer((s) => s.compiled);
  const { options, current } = useMemo(
    () => melodyOptions(piece, compiled, m),
    [piece, compiled, m],
  );
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** Each option's line (compiled once per option while the piece is unchanged). */
  const voices = useRef(new Map<string, number | undefined>());
  useEffect(() => voices.current.clear(), [piece, m]);
  const voiceOf = (o: MelodyOption): number | undefined => {
    if (!voices.current.has(o.value)) voices.current.set(o.value, melodyVoice(piece, m, o.choice));
    return voices.current.get(o.value);
  };
  const point = (k: number): void => {
    setActive(k);
    const o = options[k];
    setLineHighlight(o ? voiceOf(o) : undefined);
  };
  const show = (): void => {
    setOpen(true);
    point(
      Math.max(
        0,
        options.findIndex((o) => o.value === current),
      ),
    );
  };
  const close = (refocus: boolean): void => {
    setOpen(false);
    setActive(-1);
    setLineHighlight(undefined);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  // Unmounting (another selection) clears the highlight.
  useEffect(() => () => setLineHighlight(undefined), []);
  const choose = (o: MelodyOption | undefined): void => {
    close(true);
    if (!o || o.value === current) return;
    const patch = melodyMove(piece, compiled, m, o.choice);
    if (!updateMoment(m.id, patch, 'Change melody line')) return;
    const first = (patch.notes ?? m.notes)[0];
    if (first) auditionTuneAfterEdit(m.id, first.pitch, m.at + first.len / 2);
  };
  const label = options.find((o) => o.value === current)?.label ?? '';
  return (
    <Row label="Melody on" htmlFor={id}>
      <div className="insp-listbox">
        <button
          ref={button}
          id={id}
          type="button"
          className="insp-listbox-button"
          data-testid="insp-melody-on"
          data-value={current}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => (open ? close(true) : show())}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              show();
            }
          }}
        >
          <span>{label}</span>
          <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <ul
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={id}
            aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
            data-testid="insp-melody-list"
            onPointerLeave={() => setLineHighlight(undefined)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
            }}
            onKeyDown={(e) => {
              const n = options.length;
              let k: number | null = null;
              if (e.key === 'ArrowDown') k = Math.min(n - 1, active + 1);
              else if (e.key === 'ArrowUp') k = Math.max(0, active - 1);
              else if (e.key === 'Home') k = 0;
              else if (e.key === 'End') k = n - 1;
              else if (e.key === 'Enter') {
                e.preventDefault();
                choose(options[active]);
                return;
              } else if (e.key === 'Escape') {
                // Used here: the editor must not also clear the selection.
                e.preventDefault();
                close(true);
                return;
              } else if (e.key === 'Tab') {
                close(false);
                return;
              }
              if (k === null) return;
              e.preventDefault();
              point(k);
            }}
          >
            {options.map((o, k) => (
              <li
                key={o.value}
                id={`${id}-o${k}`}
                role="option"
                data-index={k}
                data-value={o.value}
                data-testid="insp-melody-option"
                aria-selected={o.value === current}
                className={k === active ? 'active' : undefined}
                onPointerEnter={() => point(k)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
              >
                {o.label}
              </li>
            ))}
          </ul>
        )}
      </div>
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
        <button
          type="button"
          data-testid="tune-random"
          title="Replace the notes with a new random melody, as long as the tune"
          onClick={() => {
            // A new seed each press; a roll equal to the current notes is rolled again.
            const same = JSON.stringify(m.notes);
            let notes = randomMelody(piece, compiled, m, randomU32());
            for (let i = 0; i < 4 && JSON.stringify(notes) === same; i++)
              notes = randomMelody(piece, compiled, m, randomU32());
            if (write(notes, 'Random melody')) auditionMelodyAfterEdit(m.id, notes, m.at);
          }}
        >
          Random melody
        </button>
      </div>
    </fieldset>
  );
}
