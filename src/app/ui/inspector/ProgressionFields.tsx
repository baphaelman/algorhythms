/**
 * The progression inspector (PLAN.md §6.2 `progression`, revision 10; owner notes 2026-11-22):
 * the chords as editable rows (name: click to change it; length: a slider and a box, beats with a
 * tempo, else seconds; ↑/↓ reorder; × remove), then the key's chords as chips, as in the chord
 * picker: a chip appends that chord with the default spacing (`progressionSpacing`), or, while a
 * row is being changed, replaces that chord. Either auditions the chord when stopped. The typed
 * field ("IV 2, V 2, iii 2, vi 2"; a missing length is the default spacing) stays below as a
 * secondary way in; then the chord moment's voicing, notes count, assign and register. A changed
 * or hovered row highlights its chord on the lane bar. Each edit is one undo entry.
 */

import { useEffect, useState } from 'react';
import { diatonicChords, readChord } from '../../../core/chord-spec';
import { parseChord } from '../../../core/chords';
import { progressionStarts } from '../../../core/moments/progression';
import { activeAt } from '../../../core/query';
import type { Piece, ProgressionChord, ProgressionMoment } from '../../../core/types';
import { auditionAtAfterEdit } from '../../audition';
import { updateMoment } from '../../editor/actions';
import {
  MAX_BEATS,
  MAX_SECONDS,
  appendProgressionChord,
  formatProgressionText,
  moveProgressionChord,
  parseProgressionText,
  progressionChordNames,
  progressionSpacing,
  removeProgressionChord,
  retimeProgressionChord,
  setProgressionChord,
} from '../../editor/progression';
import { MIN_TUNE_LEN, lenFromShown, lenShown, tuneBeat } from '../../editor/tune';
import { setProgressionFocus } from '../../progression-focus';
import { usePlayer } from '../../store';
import {
  CompactNumber,
  NumberField,
  RangeInput,
  SelectField,
  TextField,
  fieldSetter,
} from './controls';
import { DiatonicChips } from './ChordPicker';
import { formatNum, keyAt, sliderPlan } from './fields';
import { AssignField, RegisterFields } from './ChordSettings';

/** m:ss.ss. */
function chordTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs - m * 6000) / 100;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/** The length slider's range: 0.5–32 beats with a tempo, else 0.5–20 s (the box goes further). */
const SLIDER = {
  beats: { min: 0.5, max: 32, step: 0.5 },
  seconds: { min: 0.5, max: 20, step: 0.1 },
};

export function ProgressionFields({ m, piece }: { m: ProgressionMoment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const beat = tuneBeat(piece.view);
  const unit = beat ? 'beats' : 'seconds';
  const starts = progressionStarts(m);
  const keyOf = (t: number) => keyAt(compiled, t, piece.key);
  const names = progressionChordNames(m, compiled.harmony, keyOf);
  const text = formatProgressionText(m.chords, beat);
  const spacing = progressionSpacing(piece, m);
  const parse = (t: string) => parseProgressionText(t, beat, keyOf(m.at), m.chords, spacing);
  const count = fieldSetter<number>(m.id, 'Edit note count', (_x, n) => ({ count: n }));
  const shownCount = m.count ?? Math.max(1, activeAt(compiled, m.at).length);

  // The row being changed by the chips (null: the chips append).
  const [editing, setEditing] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Undo can shorten the list under the changing row.
  const changing = editing !== null && editing < m.chords.length ? editing : null;
  const focus = hover ?? changing;
  useEffect(() => setProgressionFocus(m.id, focus ?? -1), [m.id, focus]);
  useEffect(() => () => setProgressionFocus(null), []);

  /** Writes `chords` as one undo entry; with `sound`, auditions chord `sound` once compiled. */
  const write = (chords: ProgressionChord[] | null, label: string, sound?: number): boolean => {
    if (!chords || !updateMoment(m.id, { chords }, label)) return false;
    if (sound !== undefined) {
      const st = progressionStarts({ at: m.at, chords });
      auditionAtAfterEdit(Math.max(st[sound], st[sound + 1] - 0.01));
    }
    return true;
  };
  const lenSetter = (k: number) =>
    fieldSetter<number>(m.id, 'Edit chord length', (x, v) => ({
      chords:
        retimeProgressionChord((x as ProgressionMoment).chords, k, lenFromShown(v, beat)) ??
        (x as ProgressionMoment).chords,
    }));

  // Chips: the key at the end (an appended chord), or at the changed chord's start.
  const chipKey = keyOf(changing !== null ? starts[changing] : starts[m.chords.length]);
  const chips = diatonicChords(chipKey);
  const reading = changing !== null ? readChord(m.chords[changing].notes, chipKey) : null;
  const pick = (numeral: string): void => {
    if (changing !== null) {
      write(setProgressionChord(m.chords, changing, numeral), 'Change chord', changing);
    } else {
      write(appendProgressionChord(m.chords, numeral, spacing), 'Add chord', m.chords.length);
    }
  };

  const lo = beat ? MIN_TUNE_LEN / beat : MIN_TUNE_LEN;
  const hi = beat ? MAX_BEATS : MAX_SECONDS;
  const bounds = beat ? SLIDER.beats : SLIDER.seconds;
  const plan = sliderPlan({ min: lo, max: hi, step: bounds.step, integer: false, slider: bounds });
  const spacingShown = formatNum(lenShown(spacing, beat), 3);

  return (
    <>
      <fieldset className="insp-group insp-steps insp-prog" data-testid="insp-prog">
        <legend>
          Chords <span className="insp-count">{m.chords.length}</span>{' '}
          <span className="dim">lengths in {unit}</span>
        </legend>
        {m.chords.length === 0 ? (
          <p className="insp-note">No chords yet: pick one below.</p>
        ) : (
          <ol onPointerLeave={() => setHover(null)}>
            {m.chords.map((c, k) => {
              const desc = `chord ${k + 1}, ${names[k]} at ${chordTime(starts[k])}`;
              const shown = lenShown(c.len, beat);
              const set = lenSetter(k);
              return (
                <li
                  key={k}
                  data-testid="prog-chord"
                  data-index={k}
                  className={k === changing ? 'on' : undefined}
                  onPointerEnter={() => setHover(k)}
                >
                  <button
                    type="button"
                    className="step-pick prog-name"
                    aria-pressed={k === changing}
                    aria-label={`Change ${desc}`}
                    title={`${chordTime(starts[k])} · ${c.notes}: click to change`}
                    data-testid="prog-chord-pick"
                    onClick={() => setEditing(k === changing ? null : k)}
                  >
                    <span className="step-n" data-testid="prog-chord-name">
                      {names[k]}
                    </span>
                  </button>
                  {plan && (
                    <span className="prog-len-slider">
                      <RangeInput
                        label={`Length of ${desc}, in ${unit}`}
                        value={shown}
                        set={set}
                        min={plan.min}
                        max={plan.max}
                        step={plan.step}
                        valueText={`${formatNum(shown, 3)} ${unit}`}
                        testId="prog-chord-len-slider"
                      />
                    </span>
                  )}
                  <CompactNumber
                    value={shown}
                    set={set}
                    min={lo}
                    max={hi}
                    step={beat ? 0.25 : 0.05}
                    bigStep={beat ? 1 : 0.5}
                    digits={beat ? 3 : 2}
                    glyph={beat ? '♩' : 's'}
                    title={`Length in ${unit}. Drag sideways to change`}
                    className="weight-box tune-len"
                    label={`Length of ${desc}, in ${unit}`}
                    testId="prog-chord-len"
                  />
                  <button
                    type="button"
                    className="step-move"
                    data-testid="prog-chord-up"
                    aria-label={`Move earlier: ${desc}`}
                    disabled={k === 0}
                    onClick={() => {
                      if (write(moveProgressionChord(m.chords, k, -1), 'Move chord'))
                        if (changing === k) setEditing(k - 1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="step-move"
                    data-testid="prog-chord-down"
                    aria-label={`Move later: ${desc}`}
                    disabled={k === m.chords.length - 1}
                    onClick={() => {
                      if (write(moveProgressionChord(m.chords, k, 1), 'Move chord'))
                        if (changing === k) setEditing(k + 1);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="step-move"
                    data-testid="prog-chord-remove"
                    aria-label={`Remove ${desc}`}
                    onClick={() => {
                      if (write(removeProgressionChord(m.chords, k), 'Remove chord')) {
                        setHover(null);
                        if (changing !== null && changing >= k)
                          setEditing(changing === k ? null : changing - 1);
                      }
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="prog-chips">
          {chips.length > 0 ? (
            <DiatonicChips
              chords={chips}
              keyIn={chipKey}
              reading={reading}
              legend={
                changing !== null
                  ? `Change chord ${changing + 1} to`
                  : `Add from the key (${spacingShown} ${beat ? 'beats' : 's'})`
              }
              testId="prog-chips"
              onPick={(d) => pick(d.numeral)}
            />
          ) : (
            <p className="insp-note">This scale has no diatonic chords: type them below.</p>
          )}
          {changing !== null && (
            <div className="prog-change">
              <TextField
                label="Chord"
                value={m.chords[changing].notes}
                parse={(t) => {
                  const r = parseChord(t.trim(), keyOf(starts[changing]));
                  return r.ok ? { ok: true } : { ok: false, error: r.error };
                }}
                onCommit={(t) =>
                  write(setProgressionChord(m.chords, changing, t.trim()), 'Change chord', changing)
                }
                testId="prog-chord-symbol"
              />
              <button
                type="button"
                className="prog-done"
                data-testid="prog-change-done"
                onClick={() => setEditing(null)}
              >
                Done
              </button>
            </div>
          )}
        </div>
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
