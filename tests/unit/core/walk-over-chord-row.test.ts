/**
 * PLAN §15 M13 (first bullet): `over: 'chord'` reads the chords that sound on the Chords row
 * (§6.4), not the last chord of any part: a chord block lasts until the next chord with its target
 * or one targeting all, and a chord of two or more notes also ends earlier ones of any target,
 * while a one-line chord (a bass) only adds its note. A held walk note re-snaps at each change.
 */
import { describe, expect, it } from 'vitest';
import { ChordTrack } from '../../../src/core/compiler/chord-track';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { pitchAt } from '../../../src/core/query';
import type {
  ChordMoment,
  CompiledScore,
  NoteSet,
  Piece,
  WalkMoment,
} from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 0.2, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const pc = (p: number): number => ((Math.round(p) % 12) + 12) % 12;
const PAD = { part: 'pad' };
const BASS = { part: 'bass' };
const FLOCK = { part: 'flock' };

const chord = (at: number, notes: NoteSet, fields: Partial<ChordMoment> = {}): MomentInput =>
  ({ type: 'chord', at, notes, voicing: 'even', assign: 'ordered', ...fields }) as MomentInput;
const pitches = (...p: number[]): NoteSet => ({ kind: 'pitches', pitches: p });

function walk(fields: Partial<WalkMoment> = {}): MomentInput {
  return {
    type: 'walk',
    at: 0.5,
    until: 23.5,
    grid: 0.5,
    density: 0.6,
    steps: [-2, -1, 1, 2],
    stepGlide: 0.3,
    over: 'chord',
    target: PAD,
    ...fields,
  } as MomentInput;
}

/** v1 is the bass part, v2..v5 the pad, v6..v7 the flock; nothing sounds before the chords. */
function parted(moments: MomentInput[]): Piece {
  const p = piece({ pool: 7, start: [], glide: GLIDE, end: { at: 24, fade: 1 }, moments });
  p.voices.forEach((v, i) => (v.part = i === 0 ? 'bass' : i < 5 ? 'pad' : 'flock'));
  return p;
}

// D, G, A, D: pad chords and a one-line bass, both at each change.
const D = [2, 6, 9];
const G = [2, 7, 11];
const A = [1, 4, 9];
const changes: [number, number[], NoteSet, NoteSet][] = [
  [0.1, D, pitches(57, 62, 66, 69), pitches(38)],
  [6, G, pitches(55, 59, 62, 67), pitches(43)],
  [12, A, pitches(57, 61, 64, 69), pitches(45)],
  [18, D, pitches(57, 62, 66, 69), pitches(38)],
];
const harmonyAt = (t: number): number[] => {
  let h = changes[0][1];
  for (const c of changes) if (c[0] <= t) h = c[1];
  return h;
};
/** The flock is placed once (on D) and only walks; the pad and bass change chords. */
const song = (w: Partial<WalkMoment> = {}): Piece =>
  parted([
    chord(0.1, pitches(74, 78), { target: FLOCK }),
    ...changes.flatMap(([at, , pad, bass]) => [
      chord(at, pad, { target: PAD }),
      chord(at, bass, { target: BASS }),
    ]),
    walk(w),
  ]);
const walkers = (s: CompiledScore, target: typeof PAD) =>
  s.voices.slice(target === PAD ? 1 : 5, target === PAD ? 5 : 7);

describe('walk over the Chords row', () => {
  it.each([
    ['pad', PAD],
    ['flock', FLOCK],
  ])(
    'a one-line bass chord does not collapse the walk onto one pitch class (%s walks)',
    (_, target) => {
      const p = song({ target });
      const s = compile(p);
      const steps = s.walkSteps.filter((st) => st.from !== st.to);
      expect(steps.length).toBeGreaterThan(20);
      for (const st of steps) expect(harmonyAt(st.t), `t=${st.t} ${st.to}`).toContain(pc(st.to));
      for (const [at] of changes) {
        const under = steps.filter((st) => st.t >= at && st.t < at + 6);
        expect(new Set(under.map((st) => pc(st.to))).size, `at ${at}`).toBeGreaterThan(1);
      }
    },
  );

  it('a held note re-snaps to the chord at each change (no G held into D)', () => {
    for (const density of [0.15, 0.4]) {
      const s = compile(song({ density, target: FLOCK }));
      for (const [at] of changes.slice(1)) {
        // After the first tick at or after the change and its glide, every pad line is on the chord.
        const t = Math.ceil((at - 0.5) / 0.5) * 0.5 + 0.5 + 0.3 + 0.01;
        for (const v of walkers(s, FLOCK)) {
          const x = pitchAt(v, t);
          if (x === null) continue;
          expect(harmonyAt(at), `${v.id} at ${t}: ${x} (density ${density})`).toContain(pc(x));
        }
      }
    }
  });

  it.each([
    ['pad', PAD],
    ['flock', FLOCK],
  ])('every resting walker pitch away from the changes is a chord tone (%s walks)', (_, target) => {
    const s = compile(song({ density: 0.3, target }));
    for (let t = 1; t < 23.5; t += 0.05) {
      const near = changes.some(([at]) => t >= at - 0.01 && t < at + 1.2);
      if (near) continue;
      for (const v of walkers(s, target)) {
        const g = v.segments.find((seg) => seg.t0 <= t && t < seg.t1);
        if (!g || g.p0 !== g.p1) continue; // silent or mid-glide
        const x = g.p1;
        expect(harmonyAt(t), `${v.id} at ${t.toFixed(2)}: ${x}`).toContain(pc(x));
      }
    }
  });

  it('incremental equals full under part chords', () => {
    const p = song();
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    let q = structuredClone(p);
    (q.moments[4] as ChordMoment).notes = pitches(40); // bass at 6: E under G
    expect(inc.compile(q)).toEqual(compile(q));
    q = structuredClone(q);
    (q.moments[5] as ChordMoment).notes = pitches(57, 60, 64); // pad at 12: Am
    expect(inc.compile(q)).toEqual(compile(q));
  });
});

describe('chord track: blocks of the Chords row', () => {
  const ALL = '"all"';
  it('unions the blocks that sound; same target or all ends a block', () => {
    const t = new ChordTrack();
    t.add(0, 0, [0], ALL, true);
    t.add(1, 1, [7], 'bass', true);
    t.add(2, 2, [5, 9, 0], 'pad');
    t.add(2, 3, [5], 'bass', true);
    t.add(4, 4, [4], 'bass', true);
    t.add(6, 5, [2, 5, 9], ALL);
    t.add(6, 6, [2], 'bass', true);
    expect(t.pcsAt(-1)).toBeNull();
    expect(t.pcsAt(1)).toEqual([0, 7]); // a part's line does not end an all block
    expect(t.pcsAt(2)).toEqual([0, 5, 9]); // nor does a part's chord end an all line
    expect(t.pcsAt(4)).toEqual([0, 4, 5, 9]);
    expect(t.pcsAt(6)).toEqual([2, 5, 9]); // all ends earlier blocks; a same-time block stays
  });
  it('a chord ends earlier chords of any target; lines only add their note', () => {
    const t = new ChordTrack();
    t.add(0, 0, [2, 7, 11], 'flock');
    t.add(0, 1, [7], 'bass', true);
    t.add(6, 2, [2, 6, 9], 'pad');
    expect(t.pcsAt(0)).toEqual([2, 7, 11]);
    expect(t.pcsAt(6)).toEqual([2, 6, 7, 9]); // the flock's G chord ends; the bass G sounds on
    t.add(6, 3, [1, 4, 9], 'air');
    expect(t.pcsAt(6)).toEqual([1, 2, 4, 6, 7, 9]); // chords starting together both sound
  });
  it('ties on one target: the larger order wins', () => {
    const t = new ChordTrack();
    t.add(4, 3, [5], 'x');
    t.add(4, 1, [2], 'x');
    expect(t.pcsAt(4)).toEqual([5]);
  });
});
