/**
 * Tune "Melody on" (owner, 2026-11-21): the menu of sounding notes (high to low, spelled, with
 * parts), Highest/Lowest of the target, the current choice, the fields a pick writes, and the
 * palette default (`line: 'high'` with more than one line).
 */

import { describe, expect, it } from 'vitest';
import { patchMoment } from '../../../src/app/editor/ops';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import { melodyOptions, melodyPatch, tuneDots } from '../../../src/app/editor/tune';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { Moment, Piece, TuneMoment } from '../../../src/core/types';
import { withStart } from '../core/compiler-fixtures';

const tune = (extra: Partial<TuneMoment> = {}): TuneMoment => ({
  id: 'tun',
  type: 'tune',
  at: 4,
  notes: [
    { pitch: 62, len: 1 },
    { pitch: 65, len: 1 },
  ],
  ...extra,
});

/** A3, C4, E4 (v1–v3) from 0 in C major; `parts`: v1–v3 "Chords", the rest "Melody". */
function make(m: TuneMoment, parts = false): Piece {
  const p = newPiece({ seed: 3 });
  const q: Piece = { ...p, key: { tonic: 'C', scale: 'major' }, end: { at: 20, fade: 1 } };
  if (parts) q.voices = q.voices.map((v, i) => ({ ...v, part: i < 3 ? 'Chords' : 'Melody' }));
  q.moments = withStart(q, [57, 60, 64], [m]);
  return q;
}

const tuneOf = (p: Piece): TuneMoment => p.moments.find((m) => m.id === 'tun') as TuneMoment;
const menu = (p: Piece) => melodyOptions(p, compile(p), tuneOf(p));
/** The voice index playing the tune's first note. */
const lineOf = (p: Piece): number | undefined => tuneDots(compile(p), tuneOf(p))[0]?.voice;

describe('tune: Melody on', () => {
  it('lists the sounding notes high to low between Highest and Lowest; absent line = Lowest', () => {
    const p = make(tune());
    const { options, current } = menu(p);
    expect(options.map((o) => o.label)).toEqual(['Highest note', 'E4', 'C4', 'A3', 'Lowest note']);
    expect(current).toBe('line:low');
    // The tune's own line is listed where it was before the tune moved it.
    expect(options.find((o) => o.label === 'A3')?.value).toBe(`voice:${p.voices[0].id}`);
  });

  it('with parts: part names, "Highest/Lowest of <part>"', () => {
    const p = make(tune({ target: { part: 'Chords' } }), true);
    const { options, current } = menu(p);
    expect(options.map((o) => o.label)).toEqual([
      'Highest of Chords',
      'E4 · Chords',
      'C4 · Chords',
      'A3 · Chords',
      'Lowest of Chords',
    ]);
    expect(current).toBe('line:low');
    const high = make(tune({ target: { part: 'Chords' }, line: 'high' }), true);
    expect(menu(high).current).toBe('line:high');
  });

  it('a note writes a voice target and drops line; Highest/Lowest keep the part', () => {
    const p = make(tune({ target: { part: 'Chords' }, line: 'high' }), true);
    const m = tuneOf(p);
    const c4 = menu(p).options.find((o) => o.label.startsWith('C4'))!;
    const patch = melodyPatch(p, m, c4.choice);
    expect(patch).toEqual({ target: { voices: [p.voices[1].id] }, line: undefined });
    const q = patchMoment(p, 'tun', patch);
    expect(tuneOf(q)).not.toHaveProperty('line');
    expect(tuneOf(q).target).toEqual({ voices: [p.voices[1].id] });
    expect(menu(q).current).toBe(c4.value);
    expect(lineOf(q)).toBe(1);

    // Back to the highest of the voice's part.
    const back = patchMoment(q, 'tun', melodyPatch(q, tuneOf(q), { kind: 'line', line: 'high' }));
    expect(tuneOf(back)).toMatchObject({ target: { part: 'Chords' }, line: 'high' });
    expect(lineOf(back)).toBe(2);
    const low = patchMoment(
      back,
      'tun',
      melodyPatch(back, tuneOf(back), { kind: 'line', line: 'low' }),
    );
    expect(tuneOf(low)).not.toHaveProperty('line');
    expect(tuneOf(low).target).toEqual({ part: 'Chords' });
    expect(lineOf(low)).toBe(0);
  });

  it('without parts a picked note goes back to all notes; a silent picked voice is listed', () => {
    const p = make(tune({ target: { voices: ['v3'] } }));
    expect(melodyPatch(p, tuneOf(p), { kind: 'line', line: 'high' })).toEqual({
      target: undefined,
      line: 'high',
    });
    const silent = make(tune({ target: { voices: [p.voices[5].id] } }));
    const { options, current } = menu(silent);
    expect(current).toBe(`voice:${p.voices[5].id}`);
    expect(options.find((o) => o.value === current)?.label).toMatch(/not sounding/);
  });

  it('a rank target: "of the target"', () => {
    const p = make(tune({ target: { rank: [0, 1] } }));
    expect(menu(p).options[0].label).toBe('Highest of the target');
  });
});

describe('tune: palette default', () => {
  it("more than one line: line 'high', notes from the top line; one line: no line", () => {
    const withTune = make(tune());
    const p: Piece = { ...withTune, moments: withTune.moments.filter((x) => x.id !== 'tun') };
    const m = defaultMoment('tune', 8, 'zzzzzz', p, compile(p));
    expect(m.line).toBe('high');
    // A random melody from the top line's note (within a 3rd of E4).
    expect(Math.abs(m.notes[0].pitch - 64)).toBeLessThanOrEqual(4);
    const q: Piece = { ...p, moments: [...p.moments, m as Moment] };
    expect(tuneDots(compile(q), m)[0].voice).toBe(2);

    const one = newPiece({ seed: 3 });
    one.moments = withStart(one, [60], []);
    const m1 = defaultMoment('tune', 2, 'zzzzzz', one, compile(one));
    expect(m1).not.toHaveProperty('line');
    expect(Math.abs(m1.notes[0].pitch - 60)).toBeLessThanOrEqual(4);
  });
});
