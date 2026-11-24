import { describe, expect, it } from 'vitest';
import { Kit } from '../../../scripts/compositions/kit';

describe('Kit.paste', () => {
  it('keeps a moment on the first bar of the range whatever the rounding', () => {
    for (let bpm = 60; bpm <= 140; bpm++) {
      for (const meter of [3, 4, 5, 7]) {
        for (const from of [1, 2, 3, 5]) {
          const k = new Kit('t', 'tt', 1, { tonic: 'C', scale: 'major' }, bpm, meter);
          const first = k.m('level', k.T(from), { gain: 1, over: 1 });
          k.m('level', k.T(from + 1), { gain: 1, over: 1 });
          k.paste(from, from + 1, from + 4);
          expect(k.moments, `bpm ${bpm} meter ${meter} bar ${from}`).toHaveLength(3);
          expect(k.moments[2]?.at).toBeCloseTo((first.at as number) + k.T(4), 2);
        }
      }
    }
  });
});
