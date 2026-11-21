/**
 * The tune inspector's note list (PLAN.md §6.2 `tune`, §11.3; R9-7): one row per note, in order:
 * its start, name (in the key at that time), length (beats with a tempo, else seconds), ▲/▼ by a
 * scale step and remove; "Add note" appends one. Each edit is one undo entry. Dragging the dots
 * on the score and typed input come with R9-8.
 */

import { activeAt, pitchAt } from '../../../core/query';
import type { Piece, TuneMoment, TuneNote } from '../../../core/types';
import { noteLabel } from '../../../render';
import { auditionPointsAfterEdit } from '../../audition';
import { updateMoment } from '../../editor/actions';
import {
  MIN_TUNE_LEN,
  addTuneNote,
  lenFromShown,
  lenShown,
  removeTuneNote,
  setTuneLen,
  stepTuneNote,
  tuneBeat,
  tuneNoteStarts,
} from '../../editor/tune';
import { usePlayer } from '../../store';
import { CompactNumber, fieldSetter } from './controls';
import { keyAt } from './fields';

/** m:ss.ss (notes can be closer than the inspector's usual tenths). */
function noteTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs - m * 6000) / 100;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

export function TuneNotes({ m, piece }: { m: TuneMoment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const beat = tuneBeat(piece.view);
  const starts = tuneNoteStarts(m);
  const unit = beat ? 'beats' : 'seconds';
  const write = (notes: TuneNote[] | null, label: string): boolean =>
    notes !== null && updateMoment(m.id, { notes }, label);
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
      {m.notes.length === 0 ? (
        <p className="insp-note">No notes yet.</p>
      ) : (
        <ol>
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
              <li key={k} data-testid="tune-note" data-index={k}>
                <span className="step-t">{noteTime(starts[k])}</span>
                <span className="step-n" data-testid="tune-note-name">
                  {name}
                </span>
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
