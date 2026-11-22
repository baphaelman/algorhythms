/**
 * Progression owner notes (2026-11-22): every chord, the first on an Empty piece included, has
 * the same note count and voicing rule; the default spacing is Next's (glide, then a bar or 2 s);
 * the inspector list's append, change, retime, remove and reorder helpers.
 */
import { describe, expect, it } from 'vitest';
import { defaultMoment, withChordFill } from '../../../src/app/editor/new-moment';
import {
  appendProgressionChord,
  freezeProgression,
  moveProgressionChord,
  progressionSpacing,
  removeProgressionChord,
  retimeProgressionChord,
  setProgressionChord,
} from '../../../src/app/editor/progression';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { progressionChords, progressionVoicing } from '../../../src/core/moments/progression';
import { pitchClasses } from '../../../src/core/voicing';
import type { CompiledScore, Piece, ProgressionMoment } from '../../../src/core/types';

const rnd = (() => {
  let i = 0;
  return () => 0x1234567 + 7919 * i++;
})();

/** Each voice's destination at `t`, low to high. */
function notesAt(s: CompiledScore, t: number): number[] {
  const out: number[] = [];
  for (const v of s.voices) {
    const g = v.segments.find((x) => x.t0 <= t && t < x.t1);
    if (g) out.push(g.curve ? g.curve.p1 : g.p1);
  }
  return out.sort((a, b) => a - b);
}

/** New → Empty, then a palette progression at 0:00. */
function emptyWithProgression(seed: number, view: Piece['view'] = newPiece({ seed }).view) {
  const p0 = { ...newPiece({ seed }), view };
  const m = defaultMoment('progression', 0, 'pg', p0, compile(p0));
  return { p: { ...p0, moments: [m] }, m };
}

describe('first chord on an Empty piece', () => {
  it('every chord has the same note count and a close voicing around the middle', () => {
    for (const seed of [1, 1234, 99, 0xbeef]) {
      const { p, m } = emptyWithProgression(seed);
      const s = compile(p);
      const ends = m.chords.map((_, k) => m.chords.slice(0, k + 1).reduce((a, c) => a + c.len, 0));
      const chords = ends.map((t) => notesAt(s, t - 0.01));
      for (const [k, ps] of chords.entries()) {
        expect(ps, `chord ${k + 1}`).toHaveLength(3);
        // Close: the chord's three pitch classes inside an octave.
        expect(ps[2] - ps[0], `chord ${k + 1}`).toBeLessThanOrEqual(12);
        const want = pitchClasses({ kind: 'chord', symbol: m.chords[k].notes }, p.key, []);
        expect(want.ok && new Set(ps.map((x) => x % 12))).toEqual(want.ok && new Set(want.pcs));
      }
      // All near the middle of the voices' range (38..84), like the first.
      for (const ps of chords) for (const x of ps) expect(Math.abs(x - 61)).toBeLessThanOrEqual(9);
      // Each change arrives before the next chord starts: changes don't chain.
      for (const v of s.voices)
        for (const g of v.segments)
          if (g.p0 !== g.p1)
            expect(ends.some((t) => g.t0 >= t - m.chords[0].len && g.t1 <= t)).toBe(true);
    }
  });

  it('`even` without a register voices close (as from silence); with one, as set', () => {
    expect(progressionVoicing({ voicing: 'even' })).toBe('close');
    expect(progressionVoicing({ voicing: 'even', register: [50, 70] })).toBe('even');
    expect(progressionVoicing({ voicing: 'nearest' })).toBe('nearest');
    const { p, m } = emptyWithProgression(7);
    expect(progressionChords(m, p.seed).every((c) => c.voicing === 'close')).toBe(true);
    // Freeze writes the voicing the chords used, so the frozen piece sounds the same.
    const f = freezeProgression(p, 'pg', rnd);
    expect(f.moments.every((x) => x.type === 'chord' && x.voicing === 'close')).toBe(true);
    const strip = (s: CompiledScore) =>
      s.voices.map((v) => v.segments.map(({ momentId: _, ...r }) => r));
    // (An automatic end differs: a progression's own end counts as activity; fix the end.)
    const end = { at: 30, fade: 2 };
    expect(strip(compile({ ...f, end }))).toEqual(strip(compile({ ...p, end })));
  });

  it('a progression from silence with a larger later chord establishes its full count', () => {
    const p0 = newPiece({ seed: 5 });
    const m: ProgressionMoment = {
      id: 'pg',
      type: 'progression',
      at: 0,
      chords: [
        { notes: 'I', len: 6 },
        { notes: 'V7', len: 6 },
      ],
      voicing: 'even',
      assign: 'ordered',
    };
    const filled = withChordFill(m, p0, compile(p0), 0);
    expect(filled.count).toBe(4);
    const s = compile({ ...p0, moments: [filled] });
    expect(notesAt(s, 5.9)).toHaveLength(4);
    expect(notesAt(s, 11.9)).toHaveLength(4);
    // Triads only: nothing added.
    const triads = { ...m, chords: [m.chords[0], { notes: 'IV', len: 6 }] };
    expect(withChordFill(triads, p0, compile(p0), 0).count).toBeUndefined();
  });
});

describe('default spacing', () => {
  const p = newPiece({ seed: 1 });

  it('without a tempo: glide length + stagger, then 2 s', () => {
    expect(progressionSpacing(p)).toBeCloseTo(3 + 0.8 + 2, 9);
    // The moment's own glide counts.
    expect(progressionSpacing(p, { glide: { length: 1, stagger: 0 } })).toBeCloseTo(3, 9);
    expect(emptyWithProgression(3).m.chords.map((c) => c.len)).toEqual([5.8, 5.8, 5.8, 5.8]);
  });

  it('with a tempo: glide, then a bar, rounded up to whole beats', () => {
    const view = { ...p.view, gridBpm: 120, meter: 4 };
    // 3.8 s + a bar (2 s) = 5.8 s → 12 beats (6 s).
    expect(progressionSpacing({ ...p, view })).toBe(6);
    // 3/4 at 90: 3.8 + 2 = 5.8 s → 8.7 beats → 9 beats (6 s).
    expect(progressionSpacing({ ...p, view: { ...view, gridBpm: 90, meter: 3 } })).toBe(6);
    // Already whole: not rounded further.
    const g = { ...p.defaults, glide: { ...p.defaults.glide, length: 2, stagger: 0 } };
    expect(progressionSpacing({ defaults: g, view })).toBe(4);
    expect(emptyWithProgression(3, view).m.chords.every((c) => c.len === 6)).toBe(true);
  });
});

describe('list edits', () => {
  const chords = [
    { notes: 'I', len: 2 },
    { notes: 'vi', len: 3 },
    { notes: 'IV', len: 4 },
  ];

  it('append, change and retime', () => {
    expect(appendProgressionChord(chords, 'ii', 5.8)).toEqual([
      ...chords,
      { notes: 'ii', len: 5.8 },
    ]);
    expect(setProgressionChord(chords, 1, 'iii')).toEqual([
      chords[0],
      { notes: 'iii', len: 3 },
      chords[2],
    ]);
    expect(setProgressionChord(chords, 1, 'vi')).toBeNull();
    expect(setProgressionChord(chords, 5, 'V')).toBeNull();
    expect(retimeProgressionChord(chords, 2, 1.5)).toEqual([
      chords[0],
      chords[1],
      { notes: 'IV', len: 1.5 },
    ]);
    expect(retimeProgressionChord(chords, 0, 0)?.[0].len).toBe(0.05);
    expect(retimeProgressionChord(chords, 0, 2)).toBeNull();
    expect(retimeProgressionChord(chords, 0, NaN)).toBeNull();
  });

  it('remove and reorder', () => {
    expect(removeProgressionChord(chords, 1)).toEqual([chords[0], chords[2]]);
    expect(removeProgressionChord(chords, 3)).toBeNull();
    expect(moveProgressionChord(chords, 0, 1)).toEqual([chords[1], chords[0], chords[2]]);
    expect(moveProgressionChord(chords, 2, -1)).toEqual([chords[0], chords[2], chords[1]]);
    expect(moveProgressionChord(chords, 0, -1)).toBeNull();
    expect(moveProgressionChord(chords, 2, 1)).toBeNull();
    // Inputs are untouched.
    expect(chords.map((c) => c.notes)).toEqual(['I', 'vi', 'IV']);
  });
});
