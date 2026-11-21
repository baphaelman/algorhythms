/** MIDI note-on velocity follows √weight (revision 8, integrator call M4.5-29). */

import { describe, expect, it } from 'vitest';
import type { CompiledScore, WeightChange } from '../../../src/core/types';
import { exportMidi, weightVelocity, type MidiExportOptions } from '../../../src/midi/export';
import { hold, score, voice } from './fixtures';
import { parseSmf } from './smf-parser';

/** Two voices holding C4 and G4 for 4 s, with weight timelines. */
function weighted(a?: WeightChange[], b?: WeightChange[]): CompiledScore {
  const va = voice(0, [{ born: 0, died: 4, fadeIn: 0 }], [hold(0, 4, 60)]);
  const vb = voice(1, [{ born: 0, died: 4, fadeIn: 0 }], [hold(0, 4, 67)]);
  if (a) va.weight = a;
  if (b) vb.weight = b;
  return score([va, vb], 4);
}

/** Note-on velocities per track (tracks after the tempo track). */
function velocities(s: CompiledScore, opts: MidiExportOptions = {}): number[][] {
  const smf = parseSmf(exportMidi(s, opts).files[0].data);
  return smf.tracks.slice(1).map((t) => t.filter((e) => e.type === 'noteOn').map((e) => e.b));
}

describe('MIDI velocity by weight', () => {
  it('is the base velocity without weights', () => {
    expect(velocities(weighted())).toEqual([[100], [100]]);
    expect(velocities(weighted(), { velocity: 64 })).toEqual([[64], [64]]);
  });

  it('scales by √weight when the heaviest fits under 127', () => {
    // 80·√2 = 113.
    const v = velocities(weighted([{ t: 0, w: 2, over: 0 }]), { velocity: 80 });
    expect(v).toEqual([[113], [80]]);
    // Weights below 1 are quieter.
    expect(velocities(weighted([{ t: 0, w: 0.25, over: 0 }]))).toEqual([[50], [100]]);
  });

  it('scales every note down together when the heaviest would pass 127', () => {
    // 100·√8 = 283 > 127: weight 8 → 127, weight 1 → 127/√8 = 45.
    const v = velocities(weighted([{ t: 0, w: 8, over: 0 }]));
    expect(v).toEqual([[127], [45]]);
    // A weight reached only later still sets the scale.
    const late = velocities(weighted(undefined, [{ t: 3, w: 4, over: 0.1 }]));
    expect(late).toEqual([[64], [64]]);
  });

  it('reads the weight a note settles on, in every mode', () => {
    // A re-strike at the arrival of a glide that ends in a merge (weight 1 → 3 over 0.1 s).
    const v = voice(
      0,
      [{ born: 0, died: 4, fadeIn: 0 }],
      [hold(0, 1, 60), { t0: 1, t1: 2, p0: 60, p1: 64, ease: 'linear' }, hold(2, 4, 64)],
    );
    v.weight = [{ t: 2, w: 3, over: 0.1 }];
    const s = score([v], 4);
    const per = velocities(s, { restrikeOnArrival: true, velocity: 60 });
    expect(per).toEqual([[60, Math.round(60 * Math.sqrt(3))]]);
    const notes = velocities(s, { mode: 'notesOnly', velocity: 60 });
    expect(notes).toEqual([[60, Math.round(60 * Math.sqrt(3))]]);
    const mpe = parseSmf(exportMidi(s, { mode: 'mpe', velocity: 60 }).files[0].data);
    expect(mpe.tracks[1].filter((e) => e.type === 'noteOn').map((e) => e.b)).toEqual([60]);
  });

  it('never goes below 1 or above 127', () => {
    const s = weighted([{ t: 0, w: 64, over: 0 }], [{ t: 0, w: 0.001, over: 0 }]);
    const f = weightVelocity(s, 127);
    expect(f(s.voices[0], 1)).toBe(127);
    expect(f(s.voices[1], 1)).toBe(1);
  });
});
