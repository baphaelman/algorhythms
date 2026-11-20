/** The type-specific part of the inspector form: every field of §6.2 for each moment type. */

import { FLAT_NAMES, SCALE_NAMES, SHARP_NAMES } from '../../../core/scales';
import type {
  ChordMoment,
  Key,
  KeyMoment,
  LevelMoment,
  MergeMoment,
  MergeWhich,
  Moment,
  Piece,
  PinMoment,
  PitchClass,
  ScaleName,
  ShiftMoment,
  SplitMoment,
  SpreadMoment,
  UnisonMoment,
  WalkMoment,
} from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import type { MomentPatch } from '../../editor/ops';
import {
  CheckField,
  NumberField,
  SelectField,
  Slider,
  TextField,
  fieldSetter,
  type Setter,
} from './controls';
import { formatIntList, formatNum, formatPitch, parseIntList, parsePitch } from './fields';
import { NoteSetField } from './NoteSetField';

interface Ctx {
  piece: Piece;
  /** Key in effect at the moment's time. */
  keyAt: Key;
}

/** A setter that writes `{ [field]: value }`. */
function field<V>(id: string, field: string, label: string): Setter<V> {
  return fieldSetter<V>(id, label, (_m, v) => ({ [field]: v }) as MomentPatch);
}

const pitchProps = { format: formatPitch, parse: parsePitch, step: 1, min: 0, max: 127 } as const;

export function TypeFields({ m, ctx }: { m: Moment; ctx: Ctx }) {
  switch (m.type) {
    case 'chord':
      return <ChordFields m={m} ctx={ctx} />;
    case 'unison':
      return <UnisonFields m={m} />;
    case 'split':
      return <SplitFields m={m} ctx={ctx} />;
    case 'merge':
      return <MergeFields m={m} ctx={ctx} />;
    case 'shift':
      return <ShiftFields m={m} />;
    case 'spread':
      return <SpreadFields m={m} />;
    case 'walk':
      return <WalkFields m={m} />;
    case 'pin':
      return <PinFields m={m} ctx={ctx} />;
    case 'key':
      return <KeyFields m={m} />;
    case 'level':
      return <LevelFields m={m} />;
  }
}

function ChordFields({ m, ctx }: { m: ChordMoment; ctx: Ctx }) {
  const low = fieldSetter<number>(m.id, 'Edit register', (x, v) => ({
    register: [v, (x as ChordMoment).register?.[1] ?? Math.max(v, 84)],
  }));
  const high = fieldSetter<number>(m.id, 'Edit register', (x, v) => ({
    register: [(x as ChordMoment).register?.[0] ?? Math.min(v, 48), v],
  }));
  return (
    <>
      <NoteSetField
        value={m.notes}
        keyAtMoment={ctx.keyAt}
        momentId={m.id}
        voicing={m.voicing}
        onChange={(notes, l) => updateMoment(m.id, { notes }, l)}
        onVoicing={(voicing) => updateMoment(m.id, { voicing }, 'Change voicing')}
      />
      <SelectField
        label="Assign"
        value={m.assign}
        options={[
          ['ordered', 'Ordered (no crossing)'],
          ['free', 'Free'],
        ]}
        onChange={(assign) => updateMoment(m.id, { assign }, 'Change assignment')}
      />
      <CheckField
        label="Automatic register (voice ranges)"
        checked={!m.register}
        onChange={(auto) =>
          updateMoment(m.id, { register: auto ? undefined : [48, 84] }, 'Change register')
        }
      />
      {m.register && (
        <>
          <NumberField
            label="Register low"
            value={m.register[0]}
            set={low}
            {...pitchProps}
            check={(v) => (v > m.register![1] ? 'Low must not exceed high.' : null)}
          />
          <NumberField
            label="Register high"
            value={m.register[1]}
            set={high}
            {...pitchProps}
            check={(v) => (v < m.register![0] ? 'High must not be below low.' : null)}
          />
        </>
      )}
    </>
  );
}

function UnisonFields({ m }: { m: UnisonMoment }) {
  const pitch = field<number>(m.id, 'pitch', 'Edit pitch');
  const mode = typeof m.pitch === 'number' ? 'pitch' : m.pitch;
  return (
    <>
      <SelectField
        label="Pitch"
        value={mode}
        options={[
          ['center', 'Centre of the voices'],
          ['tonic', 'Tonic of the key'],
          ['pitch', 'A fixed pitch'],
        ]}
        onChange={(v) =>
          updateMoment(m.id, { pitch: v === 'pitch' ? 60 : v }, 'Change unison pitch')
        }
      />
      {typeof m.pitch === 'number' && (
        <NumberField label="Note" value={m.pitch} set={pitch} {...pitchProps} />
      )}
      <CheckField
        label="Nearest octaves"
        checked={m.octaves}
        onChange={(octaves) => updateMoment(m.id, { octaves }, 'Toggle octaves')}
      />
    </>
  );
}

function SplitFields({ m, ctx }: { m: SplitMoment; ctx: Ctx }) {
  const count = field<number>(m.id, 'count', 'Edit count');
  return (
    <>
      <NumberField
        label="Voices after"
        value={m.count}
        set={count}
        integer
        step={1}
        min={1}
        max={ctx.piece.voices.length}
      />
      <NoteSetField
        value={m.notes ?? { kind: 'current' }}
        keyAtMoment={ctx.keyAt}
        momentId={m.id}
        voicing={m.voicing}
        onChange={(notes, l) =>
          updateMoment(m.id, { notes: notes.kind === 'current' ? undefined : notes }, l)
        }
        onVoicing={(voicing) => updateMoment(m.id, { voicing }, 'Change voicing')}
      />
    </>
  );
}

const WHICH: readonly (readonly [MergeWhich, string])[] = [
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['inner', 'Inner'],
  ['outer', 'Outer'],
  ['random', 'Random'],
];

function MergeFields({ m, ctx }: { m: MergeMoment; ctx: Ctx }) {
  const count = field<number>(m.id, 'count', 'Edit count');
  const fade = field<number>(m.id, 'fade', 'Edit fade');
  return (
    <>
      <NumberField
        label="Voices after"
        value={m.count}
        set={count}
        integer
        step={1}
        min={1}
        max={ctx.piece.voices.length}
      />
      <SelectField
        label="Which die"
        value={m.which}
        options={WHICH}
        onChange={(which) => updateMoment(m.id, { which }, 'Change merge')}
      />
      <NumberField label="Fade" unit="s" value={m.fade} set={fade} min={0} max={60} step={0.1} />
    </>
  );
}

function ShiftFields({ m }: { m: ShiftMoment }) {
  const by = field<number>(m.id, 'by', 'Edit shift');
  return (
    <>
      <NumberField label="By" value={m.by} set={by} step={1} min={-48} max={48} />
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

function SpreadFields({ m }: { m: SpreadMoment }) {
  const factor = field<number>(m.id, 'factor', 'Edit spread');
  const around = field<number>(m.id, 'around', 'Edit centre');
  const mode = typeof m.around === 'number' ? 'pitch' : m.around;
  return (
    <>
      <NumberField
        label="Factor"
        unit="×"
        value={m.factor}
        set={factor}
        min={0}
        max={8}
        step={0.05}
      />
      <SelectField
        label="Around"
        value={mode}
        options={[
          ['mean', 'Mean pitch'],
          ['median', 'Median pitch'],
          ['pitch', 'A fixed pitch'],
        ]}
        onChange={(v) => updateMoment(m.id, { around: v === 'pitch' ? 60 : v }, 'Change centre')}
      />
      {typeof m.around === 'number' && (
        <NumberField label="Centre" value={m.around} set={around} {...pitchProps} />
      )}
      <SelectField
        label="Snap"
        value={m.snap}
        options={[
          ['scale', 'To the scale'],
          ['chromatic', 'To semitones'],
          ['none', 'None'],
        ]}
        onChange={(snap) => updateMoment(m.id, { snap }, 'Change snap')}
      />
    </>
  );
}

function WalkFields({ m }: { m: WalkMoment }) {
  const until = field<number>(m.id, 'until', 'Edit walk end');
  const grid = field<number>(m.id, 'grid', 'Edit grid');
  const density = field<number>(m.id, 'density', 'Edit density');
  const stepGlide = field<number>(m.id, 'stepGlide', 'Edit step glide');
  const leapLo = fieldSetter<number>(m.id, 'Edit bass leap', (x, v) => ({
    bass: { leap: [v, Math.max(v, (x as WalkMoment).bass?.leap[1] ?? v)] },
  }));
  const leapHi = fieldSetter<number>(m.id, 'Edit bass leap', (x, v) => ({
    bass: { leap: [Math.min(v, (x as WalkMoment).bass?.leap[0] ?? v), v] },
  }));
  return (
    <>
      <NumberField
        label="Until"
        unit="s"
        value={m.until}
        set={until}
        min={0}
        step={0.5}
        check={(v) => (v <= m.at ? 'The walk must end after it starts.' : null)}
      />
      <NumberField
        label="Grid"
        unit="s"
        value={m.grid}
        set={grid}
        min={0.05}
        max={30}
        step={0.05}
      />
      <Slider label="Density" value={m.density} set={density} min={0} max={1} step={0.01} />
      <TextField
        label="Steps"
        value={formatIntList(m.steps)}
        placeholder="-2 -1 1 2"
        parse={(t) =>
          parseIntList(t)
            ? { ok: true }
            : { ok: false, error: 'Enter whole scale steps, e.g. -2 -1 1 2.' }
        }
        onCommit={(t) => updateMoment(m.id, { steps: parseIntList(t) ?? m.steps }, 'Edit steps')}
      />
      <NumberField
        label="Step glide"
        unit="s"
        value={m.stepGlide}
        set={stepGlide}
        min={0}
        max={10}
        step={0.05}
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
          />
        </>
      )}
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
        label="Voice"
        value={m.voice}
        options={options}
        onChange={(voice) => updateMoment(m.id, { voice }, 'Change pinned voice')}
      />
      <NumberField label="Pitch" value={m.pitch} set={pitch} {...pitchProps} />
    </>
  );
}

/** Pitch-class spellings in chromatic order, sharps and flats both (C, C#, Db, D, …). */
const TONICS: readonly PitchClass[] = SHARP_NAMES.flatMap((s, i) =>
  s === FLAT_NAMES[i] ? [s] : [s, FLAT_NAMES[i]],
);

function KeyFields({ m }: { m: KeyMoment }) {
  const custom = typeof m.key.scale === 'object' ? m.key.scale : null;
  const setKey = (key: Key, label: string): boolean => updateMoment(m.id, { key }, label);
  return (
    <>
      <SelectField
        label="Tonic"
        value={m.key.tonic}
        options={TONICS.map((t) => [t, t] as const)}
        onChange={(tonic) => setKey({ ...m.key, tonic }, 'Change tonic')}
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
      />
      <NumberField label="Over" unit="s" value={m.over} set={over} min={0} max={120} step={0.1} />
    </>
  );
}
