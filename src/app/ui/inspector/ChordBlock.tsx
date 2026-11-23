/**
 * The chord block inspector (PLAN.md §6.4, M10b-4): one form for every Chords-row moment (chord,
 * unison, split, merge, shift, spread, progression chord k). Notes (the chord picker, or relative
 * to the block before), Notes: n, Arrive (Land, Float, Custom: the Transition sliders), and typed
 * chords that fill a run of blocks. A legacy block is rewritten as a chord by its first edit
 * (../../editor/chord-block), in the same undo entry; selecting it changes nothing.
 */

import { useMemo, useState } from 'react';
import { activeAt } from '../../../core/query';
import type {
  ChordMoment,
  Key,
  Moment,
  NoteSet,
  Piece,
  ShiftMoment,
  SpreadMoment,
  Voicing,
} from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import {
  chordBlockView,
  editChordBlock,
  fillProgression,
  type BlockEdit,
} from '../../editor/chord-block';
import { defaultMoment } from '../../editor/new-moment';
import { parseProgressionText, progressionSpacing } from '../../editor/progression';
import {
  arriveOf,
  setAbsolute,
  setArrive,
  setNotesCount,
  setRelative,
  type Arrive,
  type RelativeShape,
} from '../../editor/rows';
import { tuneBeat } from '../../editor/tune';
import { useProgressionFocus } from '../../progression-focus';
import { usePlayer } from '../../store';
import { AssignField, RegisterFields } from './ChordSettings';
import { ChordNotes } from './ChordNotes';
import { GlideFields } from './CommonFields';
import {
  Chips,
  NumberField,
  SelectField,
  ShiftSlider,
  TextField,
  fieldSetter,
  type Setter,
} from './controls';
import { shiftOctave } from './fields';
import { NoteSetField } from './NoteSetField';

const NOTES_MODES = [
  ['chord', 'Chord'],
  ['relative', 'Relative'],
] as const;

const NOTES_HINTS: Record<(typeof NOTES_MODES)[number][0], string> = {
  chord: 'Pick the chord',
  relative: 'Change the block before: move it, widen it or turn it upside down',
};

type ShapeKind = RelativeShape['kind'];

const SHAPES: readonly (readonly [ShapeKind, string])[] = [
  ['moved', 'Moved'],
  ['spacing', 'Wider/Closer'],
  ['upside-down', 'Upside down'],
];

const SHAPE_HINTS: Record<ShapeKind, string> = {
  moved: 'Same shape, moved by steps or semitones',
  spacing: 'Same notes, spaced wider or closer',
  'upside-down': 'Mirrored around the middle',
};

/** A starting shape when switching to one. */
const SHAPE_DEFAULTS: Record<ShapeKind, RelativeShape> = {
  moved: { kind: 'moved', by: 2, unit: 'scaleSteps' },
  spacing: { kind: 'spacing', factor: 1.5 },
  'upside-down': { kind: 'upside-down' },
};

const ARRIVES: readonly (readonly [Arrive, string])[] = [
  ['land', 'Land'],
  ['float', 'Float'],
  ['custom', 'Custom'],
];

const ARRIVE_HINTS: Record<Arrive, string> = {
  land: 'A quick glide that arrives on the marker',
  float: 'A slow, staggered glide from the marker',
  custom: 'Set the glide yourself',
};

/** New notes replace a frozen chord; a per-voice freeze gives the chord its assign back. */
function withNotes(m: Moment, notes: NoteSet): Moment {
  if (m.type !== 'chord') return setAbsolute(m, notes);
  const out: ChordMoment = { ...m, notes };
  delete out.frozenFrom;
  if (m.byVoice) {
    delete out.byVoice;
    out.assign = m.frozenFrom?.assign ?? 'ordered';
  }
  return out;
}

const withVoicing =
  (voicing: Voicing): BlockEdit =>
  (m) =>
    m.type === 'chord' && m.voicing !== voicing ? { ...m, voicing } : m;

export function ChordBlockFields({ m, piece, keyAt }: { m: Moment; piece: Piece; keyAt: Key }) {
  const compiled = usePlayer((s) => s.compiled);
  const focus = useProgressionFocus();
  const k = m.type === 'progression' && focus.id === m.id ? focus.k : 0;
  const view = useMemo(() => chordBlockView(piece, compiled, m, k), [piece, compiled, m, k]);
  const write = (fn: BlockEdit, label: string): boolean => editChordBlock(m.id, k, fn, label);
  const defaults = piece.defaults.glide;
  const arrive = arriveOf(view.chord ?? m, defaults);
  // Custom stays open while its sliders are used (Land at the marker may be ticked there).
  const [custom, setCustom] = useState(arrive === 'custom');
  const relative = view.shape !== null;

  return (
    <>
      <fieldset className="insp-group insp-block" data-testid="insp-block-notes">
        <legend>Notes</legend>
        <Chips
          legend="Notes from"
          className="insp-seg"
          testId="insp-notes-mode"
          options={NOTES_MODES}
          hint={(v) => NOTES_HINTS[v]}
          pressed={(v) => (v === 'relative') === relative}
          onPick={(v) => {
            if ((v === 'relative') === relative) return;
            if (v === 'relative')
              write((x) => setRelative(x, SHAPE_DEFAULTS.moved), 'Relative notes');
            else
              write(
                (x, p, s) => setAbsolute(x, defaultMoment('chord', x.at, x.id, p, s).notes),
                'Chord notes',
              );
          }}
        />
        {view.shape && (m.type === 'shift' || m.type === 'spread') && (
          <RelativeFields m={m} shape={view.shape} keyAt={keyAt} write={write} />
        )}
        {view.chord && (
          <AbsoluteFields
            m={m}
            chord={view.chord}
            legacy={view.legacy}
            piece={piece}
            keyAt={keyAt}
            write={write}
          />
        )}
      </fieldset>

      <Chips
        legend="Arrive"
        className="insp-seg"
        testId="insp-arrive-mode"
        options={ARRIVES}
        hint={(v) => ARRIVE_HINTS[v]}
        pressed={(v) => v === arrive}
        onPick={(v) => {
          setCustom(v === 'custom');
          if (v !== arrive)
            write((x) => setArrive(x, v, defaults), `Arrive: ${v[0].toUpperCase()}${v.slice(1)}`);
        }}
      />
      {(custom || arrive === 'custom') && <GlideFields m={m} piece={piece} />}

      <ChordsTyping m={m} k={k} piece={piece} keyAt={keyAt} />
    </>
  );
}

/** The chord picker and Notes: n; the per-note list, assign and register for a plain chord. */
function AbsoluteFields({
  m,
  chord,
  legacy,
  piece,
  keyAt,
  write,
}: {
  m: Moment;
  chord: ChordMoment;
  legacy: boolean;
  piece: Piece;
  keyAt: Key;
  write: (fn: BlockEdit, label: string) => boolean;
}) {
  return (
    <>
      <NoteSetField
        value={chord.notes}
        keyAtMoment={keyAt}
        momentId={m.id}
        voicing={chord.voicing}
        onChange={(notes, l) => write((x) => withNotes(x, notes), l)}
        onVoicing={(v) => write(withVoicing(v), 'Change voicing')}
      />
      {legacy || m.type !== 'chord' ? (
        <BlockCount m={chord} piece={piece} write={write} />
      ) : (
        <>
          <ChordNotes m={m} piece={piece} />
          <details className="insp-advanced" data-testid="insp-chord-more">
            <summary>More</summary>
            <AssignField m={m} />
            <RegisterFields m={m} />
          </details>
        </>
      )}
    </>
  );
}

/** A setter that commits typed values, and a drag once when it ends (one rewrite). */
function commitOnEnd(commit: (v: number) => void): Setter<number> {
  let last: number | null = null;
  return {
    commit,
    begin() {
      last = null;
    },
    drag(v) {
      last = v;
    },
    end(cancel = false) {
      if (!cancel && last !== null) commit(last);
      last = null;
    },
  };
}

/**
 * Notes: n of a legacy block (a plain chord's is in ChordNotes): a slider over 1…pool; the
 * value commits when a drag ends, rewriting the block once.
 */
function BlockCount({
  m,
  piece,
  write,
}: {
  m: ChordMoment;
  piece: Piece;
  write: (fn: BlockEdit, label: string) => boolean;
}) {
  const compiled = usePlayer((s) => s.compiled);
  const pool = piece.voices.length;
  const shown = m.count ?? Math.max(1, activeAt(compiled, m.at).length);
  const commit = (n: number): void =>
    void write((x) => (x.type === 'chord' ? setNotesCount(x, n, pool) : x), 'Edit note count');
  const set = commitOnEnd(commit);
  return (
    <NumberField
      label="Notes"
      value={shown}
      set={set}
      integer
      step={1}
      min={1}
      max={pool}
      testId="insp-chord-count"
    />
  );
}

/** Relative to the block before: moved (by, unit), wider/closer (factor) or upside down. */
function RelativeFields({
  m,
  shape,
  keyAt,
  write,
}: {
  m: ShiftMoment | SpreadMoment;
  shape: RelativeShape;
  keyAt: Key;
  write: (fn: BlockEdit, label: string) => boolean;
}) {
  return (
    <>
      <Chips
        legend="Shape"
        className="insp-seg"
        testId="insp-relative"
        options={SHAPES}
        hint={(v) => SHAPE_HINTS[v]}
        pressed={(v) => v === shape.kind}
        onPick={(v) => {
          if (v === shape.kind) return;
          write((x) => setRelative(x, SHAPE_DEFAULTS[v]), SHAPES.find((s) => s[0] === v)![1]);
        }}
      />
      {m.type === 'shift' && <MovedFields m={m} keyAt={keyAt} />}
      {m.type === 'spread' && m.factor !== -1 && <SpacingField m={m} />}
    </>
  );
}

function MovedFields({ m, keyAt }: { m: ShiftMoment; keyAt: Key }) {
  const by = fieldSetter<number>(m.id, 'Edit shift', (_x, v) => ({ by: v }));
  return (
    <>
      <ShiftSlider
        label="By"
        value={m.by}
        set={by}
        octave={shiftOctave(m.unit, keyAt)}
        testId="insp-shift-by"
      />
      <SelectField
        label="Unit"
        value={m.unit}
        options={[
          ['scaleSteps', 'Scale steps'],
          ['semitones', 'Semitones'],
        ]}
        onChange={(unit) => updateMoment(m.id, { unit }, 'Change shift unit')}
      />
    </>
  );
}

function SpacingField({ m }: { m: SpreadMoment }) {
  const factor = fieldSetter<number>(m.id, 'Edit spread', (_x, v) => ({ factor: v }));
  return (
    <NumberField
      label="Spacing"
      unit="×"
      value={m.factor}
      set={factor}
      min={0}
      max={8}
      step={0.05}
      testId="insp-spread-factor"
    />
  );
}

/** Typed chords ("IV 2, V 2"): fill a run of chord blocks from this block's time. */
function ChordsTyping({ m, k, piece, keyAt }: { m: Moment; k: number; piece: Piece; keyAt: Key }) {
  // Bumped after a fill, so the field empties.
  const [round, setRound] = useState(0);
  const beat = tuneBeat(piece.view);
  const spacing = progressionSpacing(piece, m);
  const parse = (t: string) => parseProgressionText(t, beat, keyAt, [], spacing);
  return (
    <TextField
      key={round}
      label="Type chords"
      value=""
      placeholder={beat ? 'IV 2, V 2 (beats)' : 'IV 2, V 2 (seconds)'}
      testId="insp-block-chords"
      parse={(t) => {
        const r = parse(t);
        return r.ok ? { ok: true } : r;
      }}
      onCommit={(t) => {
        const r = parse(t);
        if (r.ok && fillProgression(m.id, k, r.chords)) setRound((n) => n + 1);
      }}
    />
  );
}
