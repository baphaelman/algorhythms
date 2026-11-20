/**
 * Chord notes (§11.3, revision 6): "Notes: n" (writes `count`) and the note list, one row per
 * voice low → high (by where the voices were heading) with ▲/▼ (one scale step in the key). The
 * first per-note change freezes the chord (one undo entry); then a "Frozen" badge, Unfreeze and
 * "Keep lines in order" (off: `byVoice`) show, and the count is locked until Unfreeze. The score's target dots (ArrivalDots) edit the same notes.
 */

import { useMemo } from 'react';
import { activeAt } from '../../../core/query';
import type { ChordMoment, Piece } from '../../../core/types';
import { noteLabel } from '../../../render';
import { moveChordNote, unfreezeChord, updateMoment } from '../../editor/actions';
import { chordKeepsOrder, chordNotes, chordOrderPatch } from '../../editor/chord-notes';
import { usePlayer } from '../../store';
import { CheckField, NumberField, fieldSetter } from './controls';
import { keyAt } from './fields';

/** The chord's notes for the current piece and score (memoised: freezing recompiles). */
export function useChordNotes(m: ChordMoment | null): number[] | null {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  // `compiled` follows `piece`; recompute when either changes.
  return useMemo(() => (m ? chordNotes(piece, compiled, m) : null), [piece, compiled, m]);
}

export function ChordNotes({ m, piece }: { m: ChordMoment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const notes = useChordNotes(m);
  const frozen = m.frozenFrom !== undefined;
  const key = keyAt(compiled, m.at, piece.key);
  const pool = piece.voices.length;
  const shown = m.count ?? notes?.length ?? Math.max(1, activeAt(compiled, m.at).length);
  const count = fieldSetter<number>(m.id, 'Edit note count', (_x, n) => ({ count: n }));

  return (
    <fieldset className="insp-group insp-chord-notes" data-testid="insp-chord-notes">
      <legend>Chord notes</legend>
      {frozen && (
        <div className="insp-frozen" data-testid="insp-chord-frozen">
          <span className="badge">Frozen</span>
          <button
            type="button"
            data-testid="insp-chord-unfreeze"
            onClick={() => unfreezeChord(m.id)}
          >
            Unfreeze
          </button>
        </div>
      )}
      {frozen && (
        <CheckField
          label="Keep lines in order"
          checked={chordKeepsOrder(m)}
          testId="insp-chord-order"
          onChange={(on) => {
            const patch = chordOrderPatch(m, on);
            if (patch) updateMoment(m.id, patch, on ? 'Keep lines in order' : 'Let lines cross');
          }}
        />
      )}
      <fieldset
        className="insp-plain"
        disabled={frozen}
        title={frozen ? 'Unfreeze to change' : undefined}
      >
        <legend className="sr-only">Note count</legend>
        <NumberField
          label="Notes"
          value={shown}
          set={count}
          integer
          step={1}
          min={1}
          max={pool}
          slider={pool > 1 ? { min: 1, max: pool, step: 1 } : undefined}
          testId="insp-chord-count"
        />
      </fieldset>
      {notes && notes.length > 0 ? (
        <ol className="insp-note-list" data-testid="insp-chord-note-list">
          {notes.map((p, i) => {
            const name = noteLabel(p, key);
            return (
              <li key={i} data-testid="chord-note" data-index={i} data-pitch={p}>
                <span className="note-name">{name}</span>
                <button
                  type="button"
                  className="step-move"
                  data-testid="chord-note-up"
                  aria-label={`Up a scale step: ${name}`}
                  onClick={() => moveChordNote(m.id, i, 1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="step-move"
                  data-testid="chord-note-down"
                  aria-label={`Down a scale step: ${name}`}
                  onClick={() => moveChordNote(m.id, i, -1)}
                >
                  ▼
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="insp-note">No notes: the chord does not apply here.</p>
      )}
    </fieldset>
  );
}
