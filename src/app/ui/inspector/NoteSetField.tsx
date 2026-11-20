/**
 * NoteSet editor (§5, §11.3): chord symbol with live parse feedback, degree picker, pitch list,
 * or "current notes".
 */

import { parseChord } from '../../../core/chords';
import type { Key, NoteSet } from '../../../core/types';
import { SelectField, TextField } from './controls';
import {
  chordFeedback,
  degreeCells,
  formatPitchList,
  parsePitchList,
  toggleDegree,
} from './fields';

type Kind = NoteSet['kind'];

const KIND_OPTIONS: readonly (readonly [Kind, string])[] = [
  ['chord', 'Chord symbol'],
  ['degrees', 'Scale degrees'],
  ['pitches', 'Pitches'],
  ['current', 'Current notes'],
];

/** A starting value when switching kinds. */
function defaultOf(kind: Kind): NoteSet {
  switch (kind) {
    case 'chord':
      return { kind, symbol: 'I' };
    case 'degrees':
      return { kind, degrees: [0, 2, 4] };
    case 'pitches':
      return { kind, pitches: [60, 64, 67] };
    default:
      return { kind: 'current' };
  }
}

export function NoteSetField({
  value,
  keyAtMoment,
  onChange,
}: {
  value: NoteSet;
  /** The key in effect at the moment's time (Roman numerals and degrees read it). */
  keyAtMoment: Key;
  onChange: (v: NoteSet, label: string) => void;
}) {
  return (
    <>
      <SelectField
        label="Notes"
        value={value.kind}
        options={KIND_OPTIONS}
        testId="insp-notes-kind"
        onChange={(k) => k !== value.kind && onChange(defaultOf(k), 'Change notes')}
      />
      {value.kind === 'chord' && (
        <TextField
          label="Chord"
          value={value.symbol}
          testId="insp-chord"
          placeholder="Dm9, F#m7b5, ii7"
          parse={(t) => {
            const r = parseChord(t, keyAtMoment);
            return r.ok ? { ok: true } : { ok: false, error: r.error };
          }}
          feedback={(t) => chordFeedback(t, keyAtMoment)}
          onCommit={(t) => onChange({ kind: 'chord', symbol: t.trim() }, 'Change chord')}
        />
      )}
      {value.kind === 'degrees' && (
        <DegreePicker
          degrees={value.degrees}
          keyAtMoment={keyAtMoment}
          onChange={(d) => onChange({ kind: 'degrees', degrees: d }, 'Change degrees')}
        />
      )}
      {value.kind === 'pitches' && (
        <TextField
          label="Pitches"
          value={formatPitchList(value.pitches)}
          testId="insp-pitches"
          placeholder="C4 E4 G4 or 60 64 67"
          parse={(t) =>
            parsePitchList(t)
              ? { ok: true }
              : {
                  ok: false,
                  error: 'Enter note names (C4, F#3) or MIDI numbers, separated by spaces.',
                }
          }
          onCommit={(t) =>
            onChange({ kind: 'pitches', pitches: parsePitchList(t) ?? [] }, 'Change pitches')
          }
        />
      )}
    </>
  );
}

function DegreePicker({
  degrees,
  keyAtMoment,
  onChange,
}: {
  degrees: number[];
  keyAtMoment: Key;
  onChange: (d: number[]) => void;
}) {
  const cells = degreeCells(keyAtMoment, degrees);
  const scaleName =
    typeof keyAtMoment.scale === 'string'
      ? keyAtMoment.scale
      : (keyAtMoment.scale.name ?? 'custom');
  return (
    <fieldset className="insp-degrees" data-testid="insp-degrees">
      <legend>
        Degrees{' '}
        <span className="dim">
          in {keyAtMoment.tonic} {scaleName}
        </span>
      </legend>
      <div className="degree-grid">
        {cells.map((c) => {
          const on = degrees.includes(c.degree);
          return (
            <button
              key={c.degree}
              type="button"
              aria-pressed={on}
              aria-label={`Degree ${c.label} (${c.note})`}
              className={on ? 'on' : undefined}
              onClick={() => {
                const next = toggleDegree(degrees, c.degree);
                if (next.length > 0) onChange(next);
              }}
            >
              <b>{c.label}</b>
              <small>{c.note}</small>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
