/**
 * Chord picker (PLAN.md §11.3, inspector revision 5): a header with the chord's name, its Roman
 * numeral in the key in effect and the notes the moment produces, then one-click choices: the
 * key's diatonic chords, root, quality, bass and voicing. Every pick writes a `chord` NoteSet (or
 * the moment's voicing) as one undo entry, and auditions the result (../../audition.ts).
 */

import {
  CHORD_QUALITIES,
  chordSymbol,
  diatonicChords,
  qualityById,
  readChord,
  romanNumeral,
  type ChordBass,
  type ChordReading,
  type DiatonicChord,
} from '../../../core/chord-spec';
import { parseChord } from '../../../core/chords';
import { harmonyLabel, spellPc } from '../../../core/harmony';
import { noteName, pitchClassOf } from '../../../core/scales';
import type { Key, MomentId, NoteSet, Voicing } from '../../../core/types';
import { auditionAfterEdit } from '../../audition';
import { usePlayer } from '../../store';
import { formatNum, liveNotes, prefersFlats } from './fields';

const BASSES: readonly (readonly [ChordBass, string])[] = [
  ['any', 'Any'],
  ['root', 'Root'],
  ['third', '3rd'],
  ['fifth', '5th'],
];

const VOICINGS: readonly (readonly [Voicing, string])[] = [
  ['even', 'Even'],
  ['close', 'Close'],
  ['nearest', 'Nearest'],
];

const ROOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/**
 * The key's diatonic chords as one-click chips (numeral over the letter chord); the one `reading`
 * names is pressed. Shared with the progression inspector. Nothing for scales without them.
 */
export function DiatonicChips({
  chords,
  keyIn: key,
  reading,
  onPick,
  legend = 'From the key',
  testId,
}: {
  chords: readonly DiatonicChord[];
  keyIn: Key;
  reading: ChordReading | null;
  onPick: (d: DiatonicChord) => void;
  legend?: string;
  testId?: string;
}) {
  if (chords.length === 0) return null;
  return (
    <fieldset className="chips diatonic" data-testid={testId}>
      <legend>{legend}</legend>
      {chords.map((d) => {
        const on =
          reading?.root === d.root && reading.quality === d.quality.id && reading.bass === 'any';
        return (
          <button
            key={d.degree}
            type="button"
            aria-pressed={on}
            aria-label={`${d.numeral} ${d.symbol}`}
            data-numeral={d.numeral}
            onClick={() => onPick(d)}
          >
            <b>{d.numeral}</b>
            <small>{spellPc(d.root, key) + d.quality.suffix.replace(/b/g, '♭')}</small>
          </button>
        );
      })}
    </fieldset>
  );
}

/** The chord's display name: the letter chord for a written symbol, else the compiled label. */
function chordName(value: NoteSet, key: Key, compiledLabel: string | undefined): string {
  if (value.kind === 'chord') {
    const r = parseChord(value.symbol, key);
    if (r.ok) {
      const label = harmonyLabel(value.symbol, r.pcs, r.bass ?? r.root, key);
      const dot = label.indexOf(' · ');
      return dot < 0 ? label : label.slice(dot + 3);
    }
  }
  return compiledLabel ?? '—';
}

export function ChordPicker({
  value,
  keyAtMoment: key,
  momentId,
  voicing,
  onChange,
  onVoicing,
}: {
  value: NoteSet;
  keyAtMoment: Key;
  momentId: MomentId;
  voicing: Voicing;
  onChange: (v: NoteSet, label: string) => void;
  onVoicing: (v: Voicing) => void;
}) {
  const compiled = usePlayer((s) => s.compiled);
  const reading: ChordReading | null = value.kind === 'chord' ? readChord(value.symbol, key) : null;
  const compiledLabel = compiled.harmony?.find((h) => h.momentId === momentId)?.label;
  const name = chordName(value, key, compiledLabel);
  const numeral = reading
    ? romanNumeral(reading.root, qualityById(reading.quality ?? ''), key)
    : '';
  const flats = prefersFlats(key);
  const live = liveNotes(compiled, momentId)
    .map((p) => (Number.isInteger(p) ? noteName(p, flats) : formatNum(p, 2)))
    .join(' ');

  const current = value.kind === 'chord' ? value.symbol.trim() : null;
  const write = (symbol: string, label: string): void => {
    if (symbol === current) return;
    onChange({ kind: 'chord', symbol }, label);
    auditionAfterEdit(momentId);
  };
  const bassOf = (r: ChordReading | null): ChordBass => (r && r.bass !== 'other' ? r.bass : 'any');
  const pick = (
    patch: Partial<{ root: number; quality: string; bass: ChordBass }>,
    label: string,
  ) =>
    write(
      chordSymbol(
        {
          root: patch.root ?? reading?.root ?? pitchClassOf(key.tonic),
          quality: patch.quality ?? reading?.quality ?? 'maj',
          bass: patch.bass ?? bassOf(reading),
        },
        key,
      ),
      label,
    );

  const diatonic = diatonicChords(key);

  return (
    <div className="chord-picker" data-testid="insp-chord-picker">
      <div className="chord-head">
        <span className="chord-name" data-testid="insp-chord-name">
          {name}
        </span>
        {numeral && (
          <span className="chord-numeral" data-testid="insp-chord-numeral">
            {numeral}
          </span>
        )}
        <span
          className="chord-live"
          data-testid="insp-chord-live"
          title="Notes this moment produces"
        >
          {live || '—'}
        </span>
      </div>

      <DiatonicChips
        chords={diatonic}
        keyIn={key}
        reading={reading}
        onPick={(d) => write(d.symbol, 'Pick chord')}
      />

      <fieldset className="chips roots">
        <legend>Root</legend>
        {ROOTS.map((pc) => (
          <button
            key={pc}
            type="button"
            aria-pressed={reading?.root === pc}
            onClick={() => pick({ root: pc }, 'Change chord root')}
          >
            {spellPc(pc, key)}
          </button>
        ))}
      </fieldset>

      <fieldset className="chips">
        <legend>Quality</legend>
        {CHORD_QUALITIES.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={reading?.quality === c.id}
            onClick={() => pick({ quality: c.id }, 'Change chord quality')}
          >
            {c.label}
          </button>
        ))}
      </fieldset>

      <fieldset className="chips">
        <legend>Bass</legend>
        {BASSES.map(([b, text]) => (
          <button
            key={b}
            type="button"
            aria-pressed={reading !== null && reading.bass === b}
            onClick={() => pick({ bass: b }, 'Change chord bass')}
          >
            {text}
          </button>
        ))}
      </fieldset>

      <fieldset className="chips">
        <legend>Voicing</legend>
        {VOICINGS.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={voicing === v}
            onClick={() => {
              if (v === voicing) return;
              onVoicing(v);
              auditionAfterEdit(momentId);
            }}
          >
            {text}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
