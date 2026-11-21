/** Walk step editing helpers (PLAN.md §6.2 Frozen walks, §11.3 Walk). */
import { describe, expect, it } from 'vitest';
import {
  movedFixed,
  sameStep,
  scaleNeighbour,
  stepsOf,
  walkAt,
  withNote,
} from '../../../src/app/editor/walk-steps';
import { compile } from '../../../src/core/compiler/compile';
import { freezeWalk } from '../../../src/core/moments/walk';
import type { Key, Piece, WalkMoment } from '../../../src/core/types';
import { piece, type MomentInput } from '../core/compiler-fixtures';

const C_MAJOR: Key = { tonic: 'C', scale: 'major' };
const A_MINOR: Key = { tonic: 'A', scale: 'minor' };

const base = (moments: MomentInput[]): Piece =>
  piece({ start: [50, 57, 62, 69], glide: { length: 2, jitter: 0, stagger: 0 }, moments });

const walk = {
  id: 'w',
  type: 'walk',
  at: 1,
  until: 15,
  grid: 0.5,
  density: 0.7,
  steps: [-2, -1, 1, 2],
  stepGlide: 0.3,
} as MomentInput;

describe('scaleNeighbour', () => {
  it('moves a scale tone one scale step', () => {
    expect(scaleNeighbour(60, 1, C_MAJOR)).toBe(62);
    expect(scaleNeighbour(64, 1, C_MAJOR)).toBe(65);
    expect(scaleNeighbour(60, -1, C_MAJOR)).toBe(59);
    expect(scaleNeighbour(69, -1, A_MINOR)).toBe(67);
  });
  it('moves an off-scale pitch to the nearest scale tone in that direction', () => {
    expect(scaleNeighbour(61, 1, C_MAJOR)).toBe(62);
    expect(scaleNeighbour(61, -1, C_MAJOR)).toBe(60);
    expect(scaleNeighbour(60.4, 1, C_MAJOR)).toBe(62);
    expect(scaleNeighbour(60.4, -1, C_MAJOR)).toBe(60);
  });
});

describe('withNote', () => {
  const fixed = [
    { tick: 0, voice: 'a', pitch: 50 },
    { tick: 2, voice: 'a', pitch: 52 },
  ];
  it('replaces the note at (tick, voice)', () => {
    expect(withNote(fixed, { tick: 2, voice: 'a', pitch: 53 })).toEqual([
      fixed[0],
      { tick: 2, voice: 'a', pitch: 53 },
    ]);
    expect(fixed[1].pitch).toBe(52);
  });
  it('inserts a missing note in tick order', () => {
    expect(withNote(fixed, { tick: 1, voice: 'b', pitch: 60 }).map((n) => n.tick)).toEqual([
      0, 1, 2,
    ]);
  });
});

describe('movedFixed', () => {
  const p = base([walk]);
  const s = compile(p);
  const w = p.moments[1] as WalkMoment; // after the opening
  const steps = stepsOf(s, 'w');

  it('freezes an unfrozen walk and moves only that note', () => {
    expect(steps.length).toBeGreaterThan(5);
    const st = steps[3];
    const ref = { momentId: 'w', tick: st.tick, voice: st.voice };
    const out = movedFixed(w, s, ref, 1)!;
    const frozen = freezeWalk(s, 'w');
    expect(out).toHaveLength(frozen.length);
    out.forEach((n, i) => {
      const same = n.tick === st.tick && n.voice === st.voice;
      expect(n.pitch).toBe(same ? scaleNeighbour(st.to, 1, p.key) : frozen[i].pitch);
    });
    // Compiled, the other steps keep their pitches.
    const after = stepsOf(compile({ ...p, moments: [{ ...w, fixed: out }] }), 'w');
    for (const a of after) {
      if (a.tick === st.tick && a.voice === st.voice) continue;
      const b = steps.find((x) => x.tick === a.tick && x.voice === a.voice);
      if (b && a.t < st.t) expect(a.to).toBe(b.to);
    }
  });

  it('moves the stored note of a frozen walk', () => {
    const fixed = [{ tick: 4, voice: p.voices[3].id, pitch: 72 }];
    const ref = { momentId: 'w', tick: 4, voice: p.voices[3].id };
    expect(movedFixed({ ...w, fixed }, s, ref, -1)).toEqual([{ ...fixed[0], pitch: 71 }]);
  });

  it('returns null for an unknown step or a pitch out of MIDI range', () => {
    expect(movedFixed(w, s, { momentId: 'w', tick: 9999, voice: 'nope' }, 1)).toBeNull();
    const fixed = [{ tick: 0, voice: p.voices[3].id, pitch: 127 }];
    expect(
      movedFixed({ ...w, fixed }, s, { momentId: 'w', tick: 0, voice: fixed[0].voice }, 1),
    ).toBeNull();
  });

  it('sameStep compares moment, tick and voice', () => {
    const a = { momentId: 'w', tick: 1, voice: 'v' };
    expect(sameStep(a, { ...a })).toBe(true);
    expect(sameStep(a, { ...a, tick: 2 })).toBe(false);
    expect(sameStep(a, null)).toBe(false);
  });
});

describe('walkAt with a { part } target', () => {
  it('drives only voices whose part matches', () => {
    const p = base([{ ...walk, target: { part: 'lead' } } as MomentInput]);
    p.voices[0] = { ...p.voices[0], part: 'lead' };
    p.voices[1] = { ...p.voices[1], part: 'pad' };
    const s = compile(p);
    expect(walkAt(p, s, 0, 5)?.id).toBe('w');
    expect(walkAt(p, s, 1, 5)).toBeNull();
    expect(walkAt(p, s, 2, 5)).toBeNull(); // default part ''
  });
});
