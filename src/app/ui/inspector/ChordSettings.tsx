/** Chord settings shared by the chord and progression inspectors: assign and register. */

import type { ChordMoment, ProgressionMoment } from '../../../core/types';
import { updateMoment } from '../../editor/actions';
import { CheckField, NumberField, SelectField, fieldSetter } from './controls';
import { formatPitch, parsePitch } from './fields';

type WithRegister = ChordMoment | ProgressionMoment;

/** Pitches are typed (note names), not slid: 128 values are too fine for a slider. */
const pitchProps = {
  format: formatPitch,
  parse: parsePitch,
  step: 1,
  min: 0,
  max: 127,
  slider: false,
} as const;

export function AssignField({ m }: { m: WithRegister }) {
  return (
    <SelectField
      label="Assign"
      value={m.assign}
      options={[
        ['ordered', 'Ordered (no crossing)'],
        ['free', 'Free'],
      ]}
      onChange={(assign) => updateMoment(m.id, { assign }, 'Change assignment')}
    />
  );
}

export function RegisterFields({ m }: { m: WithRegister }) {
  const low = fieldSetter<number>(m.id, 'Edit register', (x, v) => ({
    register: [v, (x as WithRegister).register?.[1] ?? Math.max(v, 84)],
  }));
  const high = fieldSetter<number>(m.id, 'Edit register', (x, v) => ({
    register: [(x as WithRegister).register?.[0] ?? Math.min(v, 48), v],
  }));
  return (
    <>
      <CheckField
        label="Automatic register (note ranges)"
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
