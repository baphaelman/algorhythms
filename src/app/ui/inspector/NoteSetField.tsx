/**
 * NoteSet editor (§5, §11.3): the chord picker, a chord symbol with live parse feedback, and under
 * "Other notes" the kind selector with the degree picker, pitch list or "current notes".
 */

import { parseChord } from '../../../core/chords';
import type { Key, MomentId, NoteSet, Voicing } from '../../../core/types';
import { ChordPicker } from './ChordPicker';
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
  momentId,
  voicing,
  onChange,
  onVoicing,
}: {
  value: NoteSet;
  /** The key in effect at the moment's time (Roman numerals and degrees read it). */
  keyAtMoment: Key;
  momentId: MomentId;
  voicing: Voicing;
  onChange: (v: NoteSet, label: string) => void;
  onVoicing: (v: Voicing) => void;
}) {
  const chord = value.kind === 'chord';
  return (
    <>
      <ChordPicker
        value={value}
        keyAtMoment={keyAtMoment}
        momentId={momentId}
        voicing={voicing}
        onChange={onChange}
        onVoicing={onVoicing}
      />
      {value.kind === 'chord' && (
        <TextField
          label="Symbol"
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
      {/* Remounts when the kind changes: open for degrees, pitches and current; closed for chords. */}
      <details key={value.kind} className="insp-other" open={!chord}>
        <summary>Other notes</summary>
        <SelectField
          label="Notes"
          value={value.kind}
          options={KIND_OPTIONS}
          testId="insp-notes-kind"
          onChange={(k) => k !== value.kind && onChange(defaultOf(k), 'Change notes')}
        />
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
      </details>
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
