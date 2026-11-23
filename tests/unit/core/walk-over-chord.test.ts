/**
 * PLAN §6.2 walk, revision 10: `over: 'chord'` steps through the tones of the chords sounding at
 * each tick (the Chords row, M13 fix; see walk-over-chord-row.test.ts), uses the key before any chord, lands the bass leap on a chord
 * tone, keeps order, and the incremental compile follows edits to earlier chords.
 */
import { describe, expect, it } from 'vitest';
import { ChordTrack, noteSetPcs } from '../../../src/core/compiler/chord-track';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { nearestChordTone, stepByChord } from '../../../src/core/moments/walk';
import { pitchAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import { scalePcs } from '../../../src/core/scales';
import type {
  ChordMoment,
  CompiledScore,
  Moment,
  NoteSet,
  Piece,
  WalkMoment,
} from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const pc = (p: number): number => ((Math.round(p) % 12) + 12) % 12;

function walk(fields: Partial<WalkMoment> = {}): MomentInput {
  return {
    type: 'walk',
    at: 0.5,
    until: 20,
    grid: 0.5,
    density: 0.7,
    steps: [-2, -1, 1, 2],
    stepGlide: 0.3,
    over: 'chord',
    ...fields,
  } as MomentInput;
}

const chord = (at: number, notes: NoteSet, fields: Partial<ChordMoment> = {}): MomentInput =>
  ({ type: 'chord', at, notes, voicing: 'even', assign: 'ordered', ...fields }) as MomentInput;

const make = (moments: MomentInput[], start = [48, 55, 60, 64]): Piece =>
  piece({ pool: 6, start, glide: GLIDE, end: { at: 24, fade: 1 }, moments });

const walkId = (p: Piece): string => p.moments.find((m) => m.type === 'walk')!.id;
const stepsOf = (s: CompiledScore, id: string) =>
  s.walkSteps.filter((w) => w.momentId === id && w.from !== w.to);

/**
 * The pcs of the chord blocks sounding at t on the Chords row (M13 fix): a block ends at a later
 * chord with its target or targeting all, and a chord of 2+ notes ends earlier ones of any target;
 * a line (one note) only adds its note.
 */
function chordAtT(p: Piece, t: number): Set<number> | null {
  const sounding = new Map<string, { at: number; pcs: number[] }>();
  for (const m of p.moments) {
    if (m.type !== 'chord' || m.at > t) continue;
    const pcs = noteSetPcs(m.notes, p.key) ?? [];
    const chain = JSON.stringify(m.target ?? 'all');
    for (const [k, b] of sounding)
      if (b.at < m.at && (chain === '"all"' || (pcs.length > 1 && b.pcs.length > 1)))
        sounding.delete(k);
    sounding.set(chain, { at: m.at, pcs });
  }
  if (sounding.size === 0) return null;
  return new Set([...sounding.values()].flatMap((b) => b.pcs));
}

describe('stepByChord / nearestChordTone', () => {
  const C = [0, 4, 7];
  it('counts chord tones; off a chord tone the first step is the nearest one that way', () => {
    expect(stepByChord(60, 1, C)).toBe(64);
    expect(stepByChord(60, 2, C)).toBe(67);
    expect(stepByChord(60, -1, C)).toBe(55);
    expect(stepByChord(60, -3, C)).toBe(48);
    expect(stepByChord(62, 1, C)).toBe(64);
    expect(stepByChord(62, -1, C)).toBe(60);
    expect(stepByChord(62, 2, C)).toBe(67);
    expect(stepByChord(61.5, -1, C)).toBe(60);
    expect(stepByChord(62, 0, C)).toBe(60); // ties down
    expect(stepByChord(62, 1, [])).toBe(62);
  });
  it('nearest tone in range, passing the test, ties down', () => {
    expect(nearestChordTone(62, C, [0, 127], () => true)).toBe(60);
    expect(nearestChordTone(63, C, [0, 127], () => true)).toBe(64);
    expect(nearestChordTone(62, C, [61, 127], () => true)).toBe(64);
    expect(nearestChordTone(62, C, [0, 127], (q) => q > 64)).toBe(67);
    expect(Number.isNaN(nearestChordTone(62, C, [65, 66], () => true))).toBe(true);
  });
});

describe('chord track', () => {
  it('reads pitches, symbols, numerals and degrees; skips current', () => {
    const key = { tonic: 'G' as const, scale: 'major' as const };
    expect(noteSetPcs({ kind: 'pitches', pitches: [48, 52, 55, 64] }, key)).toEqual([0, 4, 7]);
    expect(noteSetPcs({ kind: 'chord', symbol: 'Am7' }, key)).toEqual([0, 4, 7, 9]);
    expect(noteSetPcs({ kind: 'chord', symbol: 'V' }, key)).toEqual([2, 6, 9]); // D in G
    expect(noteSetPcs({ kind: 'degrees', degrees: [0, 2, 4] }, key)).toEqual([2, 7, 11]);
    expect(noteSetPcs({ kind: 'current' }, key)).toBeNull();
    expect(noteSetPcs({ kind: 'chord', symbol: 'Qx9' }, key)).toBeNull();
  });
  it('the latest at or before t; ties by order', () => {
    const t = new ChordTrack();
    t.add(4, 3, [5]);
    t.add(0, 0, [0]);
    t.add(4, 1, [2]);
    expect(t.pcsAt(-1)).toBeNull();
    expect(t.pcsAt(3.9)).toEqual([0]);
    expect(t.pcsAt(4)).toEqual([5]);
  });
});

describe('walk over chord', () => {
  it('steps land on the tones of the chord in effect, under changing chords and targets', () => {
    const p = make([
      walk({ target: { voices: ['v2', 'v3', 'v4'] } }),
      chord(5, { kind: 'chord', symbol: 'F' }, { target: { voices: ['v1'] } }),
      chord(10, { kind: 'chord', symbol: 'ii' }, { target: 'all' }),
      chord(15, { kind: 'degrees', degrees: [4, 6, 8] }),
    ]);
    const s = compile(p);
    const steps = stepsOf(s, walkId(p));
    expect(steps.length).toBeGreaterThan(20);
    const phases = new Set<number>();
    for (const st of steps) {
      const pcs = chordAtT(p, st.t)!;
      expect(pcs.has(pc(st.to)), `t=${st.t} ${st.to}`).toBe(true);
      phases.add(p.moments.filter((m) => m.type === 'chord' && m.at <= st.t).length);
    }
    expect(phases.size).toBe(4); // steps under all four chords
  });

  it('a numeral reads the key at its chord’s time', () => {
    const p = make([
      { type: 'key', at: 2, key: { tonic: 'D', scale: 'major' } } as MomentInput,
      chord(3, { kind: 'chord', symbol: 'I' }),
      walk({ at: 4.5 }),
    ]);
    const s = compile(p);
    const steps = stepsOf(s, walkId(p));
    expect(steps.length).toBeGreaterThan(10);
    for (const st of steps) expect([2, 6, 9]).toContain(pc(st.to));
  });

  it('before any chord the walk uses the key', () => {
    const opening: MomentInput[] = [
      { type: 'unison', at: 0, pitch: 60, octaves: false, target: 'all' } as MomentInput,
      {
        type: 'split',
        at: 0.1,
        count: 4,
        notes: { kind: 'pitches', pitches: [48, 55, 60, 67] },
        voicing: 'even',
      } as MomentInput,
    ];
    const later = chord(8, { kind: 'chord', symbol: 'Am' });
    const base = piece({ pool: 6, start: [], glide: GLIDE, end: { at: 24, fade: 1 }, moments: [] });
    const build = (over: 'key' | 'chord'): Piece => ({
      ...base,
      key: { tonic: 'C', scale: 'major' },
      moments: [...opening, walk({ at: 2, over }), later].map(
        (m, i) => ({ ...m, id: `m${i}` }) as Moment,
      ),
    });
    const byKey = compile(build('key'));
    const byChord = compile(build('chord'));
    const before = (s: CompiledScore) => stepsOf(s, 'm2').filter((st) => st.t < 8);
    expect(before(byChord).length).toBeGreaterThan(5);
    expect(before(byChord)).toEqual(before(byKey));
    const scale = new Set(scalePcs({ tonic: 'C', scale: 'major' }));
    for (const st of before(byChord)) expect(scale.has(pc(st.to))).toBe(true);
    const after = stepsOf(byChord, 'm2').filter((st) => st.t >= 8);
    expect(after.length).toBeGreaterThan(5);
    for (const st of after) expect([9, 0, 4]).toContain(pc(st.to));
  });

  it('the bass leaps onto the nearest chord tone', () => {
    const p = make(
      [chord(0.2, { kind: 'chord', symbol: 'Dm7' }), walk({ bass: { leap: [5, 12] } })],
      [38, 57, 62, 65],
    );
    const s = compile(p);
    const bass = stepsOf(s, walkId(p)).filter((st) => st.voice === 'v1');
    expect(bass.length).toBeGreaterThan(3);
    for (const st of bass) expect([2, 5, 9, 0]).toContain(pc(st.to));
  });

  it('keeps pitch order (no crossing or touching) and ranges', () => {
    const p = make([
      walk({ density: 1, steps: [-3, -1, 1, 3], bass: { leap: [3, 9] } }),
      chord(6, { kind: 'chord', symbol: 'Cmaj7' }),
      chord(12, { kind: 'chord', symbol: 'G7' }),
    ]);
    for (const v of p.voices) v.range = [40, 76];
    const s = compile(p);
    expect(stepsOf(s, walkId(p)).length).toBeGreaterThan(20);
    for (let t = 0; t < 23; t += 0.01) {
      const ps = s.voices.map((v) => pitchAt(v, t)).filter((x): x is number => x !== null);
      for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
      for (const x of ps) expect(x >= 40 - 1e-9 && x <= 76 + 1e-9).toBe(true);
    }
  });

  it('is seeded: the same piece walks the same way; another seed differs', () => {
    const p = make([walk()]);
    expect(compile(structuredClone(p)).walkSteps).toEqual(compile(p).walkSteps);
    const q = structuredClone(p);
    (q.moments.find((m) => m.type === 'walk') as WalkMoment).seed = 99;
    expect(compile(q).walkSteps).not.toEqual(compile(p).walkSteps);
  });

  it('absent over and over: key are the same walk; a frozen walk ignores over', () => {
    const k = make([walk({ over: undefined })]);
    delete (k.moments.find((m) => m.type === 'walk') as WalkMoment).over;
    const explicit = make([walk({ over: 'key' })]);
    expect(compile(explicit)).toEqual(compile(k));
    const fixed = [{ tick: 1, voice: 'v2', pitch: 57 }];
    const fk = compile(make([walk({ over: 'key', fixed })]));
    const fc = compile(make([walk({ over: 'chord', fixed })]));
    expect(fc.voices).toEqual(fk.voices);
    expect(fc.walkSteps).toEqual(fk.walkSteps);
  });

  it('incremental equals full when an earlier chord is edited', () => {
    const p = make([
      chord(0.25, { kind: 'chord', symbol: 'C' }, { target: { voices: ['v1'] } }),
      walk({ until: 22 }),
      chord(6, { kind: 'chord', symbol: 'Am' }),
      chord(11, { kind: 'chord', symbol: 'F' }, { target: { voices: ['v1'] } }),
    ]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const at = (q: Piece, i: number) => q.moments[i] as ChordMoment;
    const edits: ((q: Piece) => void)[] = [
      (q) => (at(q, 4).notes = { kind: 'chord', symbol: 'Dm7' }),
      (q) => (at(q, 3).notes = { kind: 'degrees', degrees: [1, 3, 5] }),
      (q) => (at(q, 1).notes = { kind: 'chord', symbol: 'E' }),
      (q) => (at(q, 4).at = 3),
      (q) => (at(q, 3).muted = true),
      (q) => ((q.moments[2] as WalkMoment).over = 'key'),
      (q) => ((q.moments[2] as WalkMoment).over = 'chord'),
    ];
    let q = p;
    for (const e of edits) {
      q = structuredClone(q);
      e(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
  });

  it('schema: over is optional (no default), key or chord', () => {
    const base = make([walk()]);
    const parsed = parsePiece(JSON.parse(JSON.stringify(base)));
    expect(parsed.ok).toBe(true);
    const plain = structuredClone(base);
    delete (plain.moments.find((m) => m.type === 'walk') as WalkMoment).over;
    const r = parsePiece(JSON.parse(JSON.stringify(plain)));
    expect(r.ok && 'over' in r.piece.moments.find((m) => m.type === 'walk')!).toBe(false);
    const bad = structuredClone(base);
    (bad.moments.find((m) => m.type === 'walk') as unknown as { over: string }).over = 'scale';
    expect(parsePiece(JSON.parse(JSON.stringify(bad))).ok).toBe(false);
  });
});
