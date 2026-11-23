/** The type-specific part of the inspector form: every field of §6.2 for each moment type. */

import { FLAT_NAMES, SCALE_NAMES, SHARP_NAMES } from '../../../core/scales';
import type {
  Key,
  KeyMoment,
  LevelMoment,
  Moment,
  Piece,
  PinMoment,
  PitchClass,
  ScaleName,
  TimbreMoment,
  WalkMoment,
} from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import type { MomentPatch } from '../../editor/ops';
import {
  CheckField,
  Chips,
  NumberField,
  SelectField,
  Slider,
  TextField,
  fieldSetter,
  type Setter,
} from './controls';
import {
  formatIntList,
  formatNum,
  formatPitch,
  parseIntList,
  parsePitch,
  stepChips,
  toggleStep,
} from './fields';
import { NoteFields } from './NoteFields';
import { WalkSteps } from './WalkSteps';
import { ProgressionFields } from './ProgressionFields';
import { ChordBlockFields } from './ChordBlock';
import { TextureFields } from './TextureBlock';
import { MelodyOn, TuneNotes, TuneOptions } from './TuneFields';
import { KeyCarryBanner } from './KeyCarryBanner';
import { offerKeyCarry } from '../../editor/key-carry';
import { isCustom, isModified } from '../../editor/timbre-edit';
import { timbreOptions } from '../../editor/voices';
import { isTimbreName } from '../../../core/timbres';

interface Ctx {
  piece: Piece;
  /** Key in effect at the moment's time. */
  keyAt: Key;
}

/** A setter that writes `{ [field]: value }`. */
function field<V>(id: string, field: string, label: string): Setter<V> {
  return fieldSetter<V>(id, label, (_m, v) => ({ [field]: v }) as MomentPatch);
}

/** Pitches are typed (note names), not slid: 128 values are too fine for a slider. */
const pitchProps = {
  format: formatPitch,
  parse: parsePitch,
  step: 1,
  min: 0,
  max: 127,
  slider: false,
} as const;

export function TypeFields({ m, ctx }: { m: Moment; ctx: Ctx }) {
  switch (m.type) {
    case 'chord':
    case 'unison':
    case 'split':
    case 'merge':
    case 'shift':
    case 'spread':
      return <ChordBlockFields m={m} piece={ctx.piece} keyAt={ctx.keyAt} />;
    case 'walk':
    case 'pulse':
      return <TextureFields m={m} piece={ctx.piece} />;
    case 'note':
      return <NoteFields m={m} keyAt={ctx.keyAt} />;
    case 'pin':
      return <PinFields m={m} ctx={ctx} />;
    case 'key':
      return <KeyFields m={m} />;
    case 'level':
      return <LevelFields m={m} />;
    case 'tune':
      return (
        <>
          <MelodyOn m={m} piece={ctx.piece} />
          <TuneOptions m={m} />
          <TuneNotes m={m} piece={ctx.piece} />
        </>
      );
    case 'progression':
      return (
        <>
          <ChordBlockFields m={m} piece={ctx.piece} keyAt={ctx.keyAt} />
          <details className="insp-advanced" data-testid="insp-prog-more">
            <summary>Progression</summary>
            <ProgressionFields m={m} piece={ctx.piece} />
          </details>
        </>
      );
    case 'timbre':
      return <TimbreFields m={m} piece={ctx.piece} />;
  }
}

/** The walk's step basis (revision 10): scale steps or chord tones. */
const WALK_OVER = [
  ['key', 'Key'],
  ['chord', 'Chord'],
] as const;

/** A walk's fields (the texture inspector's More); `region` false leaves the region out. */
export function WalkFields({
  m,
  piece,
  region: showRegion = true,
}: {
  m: WalkMoment;
  piece: Piece;
  region?: boolean;
}) {
  const region = fieldSetter<number>(m.id, 'Edit walk region', (x, v) => ({ until: x.at + v }));
  const grid = field<number>(m.id, 'grid', 'Edit grid');
  const density = fieldSetter<number>(m.id, 'Edit density', (_x, v) => ({ density: v / 100 }));
  const stepGlide = field<number>(m.id, 'stepGlide', 'Edit step glide');
  const leapLo = fieldSetter<number>(m.id, 'Edit bass leap', (x, v) => ({
    bass: { leap: [v, Math.max(v, (x as WalkMoment).bass?.leap[1] ?? v)] },
  }));
  const leapHi = fieldSetter<number>(m.id, 'Edit bass leap', (x, v) => ({
    bass: { leap: [Math.min(v, (x as WalkMoment).bass?.leap[0] ?? v), v] },
  }));
  const frozen = m.fixed !== undefined;
  return (
    <>
      {frozen && (
        <div className="insp-frozen" data-testid="insp-walk-frozen">
          <span className="badge">Frozen</span>
          <button
            type="button"
            data-testid="insp-unfreeze"
            onClick={() => updateMoment(m.id, { fixed: undefined }, 'Unfreeze walk')}
          >
            Unfreeze
          </button>
        </div>
      )}
      {showRegion && (
        <NumberField
          label="Region"
          unit="s"
          value={m.until - m.at}
          set={region}
          min={0.05}
          step={0.5}
          slider={{ min: 1, max: Math.max(60, Math.ceil((m.until - m.at) / 10) * 10) }}
          testId="insp-walk-region"
        />
      )}
      <NumberField
        label="Grid"
        unit="s"
        value={m.grid}
        set={grid}
        min={0.05}
        max={30}
        step={0.05}
        slider={{ min: 0.05, max: 4 }}
        testId="insp-walk-grid"
      />
      <NumberField
        label="Step glide"
        unit="s"
        value={m.stepGlide}
        set={stepGlide}
        min={0}
        max={10}
        step={0.05}
        slider={{ min: 0, max: 2 }}
        testId="insp-walk-step-glide"
      />
      <fieldset
        className="insp-gen"
        disabled={frozen}
        aria-describedby={frozen ? `${m.id}-frozen-note` : undefined}
      >
        <legend className="sr-only">Walk generator</legend>
        {frozen && (
          <p className="insp-note" id={`${m.id}-frozen-note`}>
            Unfreeze to change
          </p>
        )}
        <NumberField
          label="Density"
          unit="%"
          value={Math.round(m.density * 100)}
          set={density}
          integer
          step={1}
          min={0}
          max={100}
          slider={{ min: 0, max: 100 }}
          testId="insp-walk-density"
        />
        <Chips
          legend="Walk over"
          testId="insp-walk-over"
          options={WALK_OVER}
          pressed={(o) => (m.over ?? 'key') === o}
          onPick={(o) => {
            if ((m.over ?? 'key') === o) return;
            // 'key' is the default: drop the field so the piece reads as before.
            updateMoment(m.id, { over: o === 'chord' ? 'chord' : undefined }, 'Walk over');
          }}
        />
        <Chips
          legend="Allowed steps"
          className="steps"
          testId="insp-walk-steps"
          options={stepChips(m.steps).map((s) => [s, s > 0 ? `+${s}` : `−${-s}`] as const)}
          pressed={(s) => m.steps.includes(s)}
          onPick={(s) => {
            const steps = toggleStep(m.steps, s);
            if (steps) updateMoment(m.id, { steps }, 'Edit steps');
          }}
        />
        <CheckField
          label="Bass leaps"
          checked={!!m.bass}
          onChange={(on) =>
            updateMoment(m.id, { bass: on ? { leap: [5, 12] } : undefined }, 'Toggle bass leaps')
          }
        />
        {m.bass && (
          <>
            <NumberField
              label="Leap min"
              unit="st"
              value={m.bass.leap[0]}
              set={leapLo}
              integer
              step={1}
              min={0}
              max={24}
              slider={{ min: 0, max: 24 }}
            />
            <NumberField
              label="Leap max"
              unit="st"
              value={m.bass.leap[1]}
              set={leapHi}
              integer
              step={1}
              min={0}
              max={24}
              slider={{ min: 0, max: 24 }}
            />
          </>
        )}
      </fieldset>
      <WalkSteps m={m} piece={piece} />
    </>
  );
}

function PinFields({ m, ctx }: { m: PinMoment; ctx: Ctx }) {
  const pitch = field<number>(m.id, 'pitch', 'Edit pitch');
  const options = ctx.piece.voices.map(
    (v) => [v.id, v.name ? `${v.name} (${v.id})` : v.id] as const,
  );
  if (!ctx.piece.voices.some((v) => v.id === m.voice))
    options.unshift([m.voice, `${m.voice} (missing)`]);
  return (
    <>
      <SelectField
        label="Note"
        value={m.voice}
        options={options}
        onChange={(voice) => updateMoment(m.id, { voice }, 'Change pinned note')}
      />
      <NumberField label="Pitch" value={m.pitch} set={pitch} {...pitchProps} />
    </>
  );
}

/** Pitch-class spellings in chromatic order, sharps and flats both (C, C#, Db, D, …). */
const TONICS: readonly PitchClass[] = SHARP_NAMES.flatMap((s, i) =>
  s === FLAT_NAMES[i] ? [s] : [s, FLAT_NAMES[i]],
);

/**
 * Tonic, scale and custom intervals of key moment `m`, with the carry-forward prompt. `write`
 * stores an edit (default: the moment's `key`, then the prompt); the piece key at 0:00 passes
 * `setPieceKey`.
 */
export function KeyFields({
  m,
  write,
}: {
  m: KeyMoment;
  write?: (key: Key, label: string) => boolean;
}) {
  const custom = typeof m.key.scale === 'object' ? m.key.scale : null;
  const setKey =
    write ??
    ((key: Key, label: string): boolean => {
      const ok = updateMoment(m.id, { key }, label);
      if (ok) offerKeyCarry(m.id, m.key);
      return ok;
    });
  return (
    <>
      <SelectField
        label="Tonic"
        value={m.key.tonic}
        options={TONICS.map((t) => [t, t] as const)}
        onChange={(tonic) => setKey({ ...m.key, tonic }, 'Change tonic')}
        testId="insp-tonic"
      />
      <SelectField<ScaleName | 'custom'>
        label="Scale"
        value={custom ? 'custom' : (m.key.scale as ScaleName)}
        options={[
          ...SCALE_NAMES.map((s) => [s, s.replace('-', ' ')] as const),
          ['custom', 'Custom…'] as const,
        ]}
        onChange={(s) =>
          setKey(
            {
              ...m.key,
              scale: s === 'custom' ? { kind: 'custom', intervals: [0, 2, 4, 5, 7, 9, 11] } : s,
            },
            'Change scale',
          )
        }
      />
      {custom && (
        <TextField
          label="Intervals"
          value={formatIntList(custom.intervals)}
          placeholder="0 2 3 5 7 9 10"
          parse={(t) => {
            const xs = parseIntList(t);
            return xs && xs.every((x) => x >= 0 && x < 12)
              ? { ok: true }
              : { ok: false, error: 'Enter semitones from the tonic, 0 to 11.' };
          }}
          onCommit={(t) => {
            const xs = [...new Set([0, ...(parseIntList(t) ?? [])])].sort((a, b) => a - b);
            setKey({ ...m.key, scale: { ...custom, intervals: xs } }, 'Edit scale');
          }}
        />
      )}
      <KeyCarryBanner keyId={m.id} />
    </>
  );
}

function LevelFields({ m }: { m: LevelMoment }) {
  const gain = field<number>(m.id, 'gain', 'Edit level');
  const over = field<number>(m.id, 'over', 'Edit ramp');
  return (
    <>
      <Slider
        label="Level"
        value={m.gain}
        set={gain}
        min={0}
        max={2}
        step={0.01}
        format={(v) => `${formatNum(v, 2)}×`}
        testId="insp-level"
      />
      <NumberField
        label="Ramp"
        unit="s"
        value={m.over}
        set={over}
        min={0}
        max={120}
        step={0.1}
        slider={{ min: 0, max: 20 }}
        testId="insp-level-ramp"
      />
    </>
  );
}

/** How a preset is listed: built-in, edited built-in, the piece's own, or missing. */
function presetText(piece: Piece, name: string): string {
  if (!isTimbreName(name, piece.timbres)) return `${name} (missing)`;
  return isModified(piece, name)
    ? `${name} (edited)`
    : isCustom(piece, name)
      ? `${name} (piece)`
      : name;
}

/** A timbre change (M6): the preset (the piece's timbres, then built-ins) and the fade. */
function TimbreFields({ m, piece }: { m: TimbreMoment; piece: Piece }) {
  const fade = field<number>(m.id, 'fade', 'Edit fade');
  return (
    <>
      <SelectField
        label="Timbre"
        value={m.preset}
        options={timbreOptions(piece, m.preset).map((t) => [t, presetText(piece, t)] as const)}
        onChange={(preset) => updateMoment(m.id, { preset }, 'Change timbre')}
        testId="insp-timbre-preset"
      />
      <NumberField
        label="Fade"
        unit="s"
        value={m.fade}
        set={fade}
        min={0}
        max={120}
        step={0.1}
        slider={{ min: 0, max: 10 }}
        testId="insp-timbre-fade"
      />
    </>
  );
}
