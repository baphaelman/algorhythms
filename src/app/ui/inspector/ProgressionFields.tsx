/**
 * The progression inspector (PLAN.md §6.2 `progression`, revision 10): the chords typed ("IV 2,
 * V 2, iii 2, vi 2", lengths in beats with a tempo, else seconds; a missing length repeats the
 * previous one), committed on Enter or blur once valid; the list of chords (start, name in the
 * key at that time, length); then the chord moment's voicing, notes count, assign and register.
 * Each edit is one undo entry.
 */

import { progressionStarts } from '../../../core/moments/progression';
import { activeAt } from '../../../core/query';
import type { Piece, ProgressionMoment } from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import {
  formatProgressionText,
  parseProgressionText,
  progressionChordNames,
} from '../../editor/progression';
import { MIN_TUNE_LEN, lenFromShown, lenShown, tuneBeat } from '../../editor/tune';
import { usePlayer } from '../../store';
import { CompactNumber, NumberField, SelectField, TextField, fieldSetter } from './controls';
import { keyAt } from './fields';
import { AssignField, RegisterFields } from './ChordSettings';

/** m:ss.ss. */
function chordTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs - m * 6000) / 100;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

export function ProgressionFields({ m, piece }: { m: ProgressionMoment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const beat = tuneBeat(piece.view);
  const unit = beat ? 'beats' : 'seconds';
  const meter = piece.view.meter && piece.view.meter > 0 ? piece.view.meter : 4;
  const starts = progressionStarts(m);
  const keyOf = (t: number) => keyAt(compiled, t, piece.key);
  const names = progressionChordNames(m, compiled.harmony, keyOf);
  const text = formatProgressionText(m.chords, beat);
  const parse = (t: string) =>
    parseProgressionText(t, beat, keyOf(m.at), m.chords, beat ? beat * meter : 2);
  const lenSetter = (k: number) =>
    fieldSetter<number>(m.id, 'Edit chord length', (x, v) => {
      const chords = (x as ProgressionMoment).chords;
      const len = lenFromShown(v, beat);
      return { chords: chords.map((c, i) => (i === k ? { ...c, len } : c)) };
    });
  const count = fieldSetter<number>(m.id, 'Edit note count', (_x, n) => ({ count: n }));
  const shownCount = m.count ?? Math.max(1, activeAt(compiled, m.at).length);

  return (
    <>
      <fieldset className="insp-group insp-steps insp-prog" data-testid="insp-prog">
        <legend>
          Chords <span className="insp-count">{m.chords.length}</span>{' '}
          <span className="dim">lengths in {unit}</span>
        </legend>
        <TextField
          label="Type"
          value={text}
          placeholder={beat ? 'IV 2, V 2, iii 2, vi 2' : 'IV 1, V 1, iii 1, vi 1'}
          parse={(t) => {
            const r = parse(t);
            return r.ok ? { ok: true } : r;
          }}
          onCommit={(t) => {
            const r = parse(t);
            if (r.ok) updateMoment(m.id, { chords: r.chords }, 'Type chords');
          }}
          testId="prog-text"
        />
        {m.chords.length === 0 ? (
          <p className="insp-note">No chords yet.</p>
        ) : (
          <ol>
            {m.chords.map((c, k) => {
              const desc = `chord ${k + 1}, ${names[k]} at ${chordTime(starts[k])}`;
              return (
                <li key={k} data-testid="prog-chord" data-index={k}>
                  <span className="step-pick">
                    <span className="step-t">{chordTime(starts[k])}</span>
                    <span className="step-n" data-testid="prog-chord-name" title={c.notes}>
                      {names[k]}
                    </span>
                  </span>
                  <CompactNumber
                    value={lenShown(c.len, beat)}
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
                    testId="prog-chord-len"
                  />
                </li>
              );
            })}
          </ol>
        )}
      </fieldset>
      <SelectField
        label="Voicing"
        value={m.voicing}
        options={[
          ['even', 'Even'],
          ['close', 'Close'],
          ['nearest', 'Nearest'],
        ]}
        onChange={(voicing) => updateMoment(m.id, { voicing }, 'Change voicing')}
        testId="prog-voicing"
      />
      <NumberField
        label="Notes"
        value={shownCount}
        set={count}
        integer
        step={1}
        min={1}
        max={piece.voices.length}
        testId="prog-count"
      />
      <AssignField m={m} />
      <RegisterFields m={m} />
    </>
  );
}
