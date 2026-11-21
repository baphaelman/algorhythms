/**
 * Octaves before unisons (PLAN.md §11.3 rev 7, M4.5-24): a split or chord `count` birth with
 * more voices than distinct notes gives the extra voices free octaves inside the range before
 * any exact unison.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, Piece } from '../../../src/core/types';
import { fillOctaves, voiceNotes } from '../../../src/core/voicing';
import { chordAt, piece, type MomentInput } from './compiler-fixtures';
import { lineArtifacts } from './line-artifacts';

const GLIDE = { length: 3, jitter: 0.3, stagger: 1.5, ease: 'smootherstep' as const };
const C7 = [60, 64, 67, 70];
const pc = (p: number) => ((p % 12) + 12) % 12;
const distinct = (ps: number[]) => new Set(ps.map((p) => Math.round(p * 1000))).size;

function split(count: number, notes: number[] | null = C7): MomentInput {
  return {
    id: 's',
    type: 'split',
    at: 1,
    count,
    voicing: 'even',
    ...(notes ? { notes: { kind: 'pitches' as const, pitches: notes } } : {}),
  };
}

function run(start: number[], m: MomentInput, range?: [number, number]): CompiledScore {
  return compile(
    piece({ start, glide: GLIDE, end: { at: 20, fade: 1 }, moments: [m], ...(range && { range }) }),
  );
}

describe('fillOctaves', () => {
  it('takes the nearest free octave of the notes the old doubling chose', () => {
    // One extra: the middle note (64) doubles, an octave down (ties low).
    expect(fillOctaves([60, 64, 67], 4, 36, 96, -Infinity, [])).toEqual([52, 60, 64, 67]);
    // More extras than notes: cyclic, nearest octaves first, then the next ones out.
    expect(fillOctaves([60, 67], 6, 36, 96, -Infinity, [])).toEqual([48, 55, 60, 67, 72, 79]);
  });

  it('skips occupied octaves and pitches still sounding elsewhere', () => {
    expect(fillOctaves([48, 60], 3, 36, 84, -Infinity, [])).toEqual([36, 48, 60]);
    expect(fillOctaves([48, 60], 3, 36, 84, -Infinity, [36])).toEqual([48, 60, 72]);
  });

  it('stays in range and above the floor; stops when no octave is free', () => {
    expect(fillOctaves([60, 64], 5, 58, 70, -Infinity, [])).toEqual([60, 64]);
    expect(fillOctaves([60, 64], 5, 48, 70, 59, [])).toEqual([60, 64]);
    expect(fillOctaves([60, 64], 5, 48, 76, -Infinity, [])).toEqual([48, 52, 60, 64, 72]);
  });
});

describe('voiceNotes with octaves', () => {
  const base = {
    mode: 'even' as const,
    register: [36, 96] as const,
    key: { tonic: 'C', scale: 'major' } as const,
    current: [],
    voices: [],
  };
  it('pitches: fills to k distinct targets; off without the flag', () => {
    const notes = { kind: 'pitches' as const, pitches: C7 };
    const on = voiceNotes({ ...base, notes, k: 10, octaves: true });
    const off = voiceNotes({ ...base, notes, k: 10 });
    expect(on.ok && on.targets).toHaveLength(10);
    expect(on.ok && distinct(on.targets)).toBe(10);
    expect(off.ok && off.targets).toEqual(C7);
  });

  it('a slash bass stays the lowest note', () => {
    const r = voiceNotes({
      ...base,
      register: [43, 72],
      notes: { kind: 'chord', symbol: 'C/G' },
      k: 12,
      octaves: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targets[0]).toBe(43);
  });
});

describe('split', () => {
  it('to 10 over a 4-note chord: 10 distinct pitches, each an octave of a chord note', () => {
    const s = run(C7, split(10));
    const c = chordAt(s, 10);
    expect(c).toHaveLength(10);
    expect(distinct(c)).toBe(10);
    for (const p of c) expect([0, 4, 7, 10]).toContain(pc(p));
    expect(lineArtifacts(s)).toEqual([]);
  });

  it('a narrow range fills what octaves it can, then doubles', () => {
    // [58, 72]: only 72 (60 + 12) and 58 (70 − 12) are free octaves.
    const s = run(C7, split(10), [58, 72]);
    const c = chordAt(s, 10);
    expect(c).toHaveLength(10);
    expect(distinct(c)).toBe(6);
    // Narrower than an octave: no octave at all, unisons as before.
    const s2 = run(C7, split(10), [59, 70]);
    expect(distinct(chordAt(s2, 10))).toBe(4);
  });

  it('default `current` notes: unchanged (every octave is already a candidate)', () => {
    const c = chordAt(run(C7, split(10, null)), 10);
    expect(distinct(c)).toBe(10);
  });

  it('from one voice with one pitch: the newborns take octaves of it', () => {
    const s = run([57], split(4, [57]));
    expect(chordAt(s, 10)).toEqual([45, 57, 69, 81]);
    expect(lineArtifacts(s)).toEqual([]);
  });

  it("the owner's case: lanterns' 8-note split raised to 10 gives 10 lines", () => {
    const r = parsePiece(
      readFileSync(
        join(import.meta.dirname, '../../../examples/lanterns-over-salt-flats.algorhythms.json'),
        'utf8',
      ),
    );
    if (!r.ok) throw new Error('parse');
    const p: Piece = r.piece;
    const i = p.moments.findIndex((m) => m.type === 'split' && m.count === 8);
    const m = p.moments[i];
    if (m.type !== 'split') throw new Error('split');
    m.count = 10;
    const s = compile(p);
    const t = p.moments[i + 1].at - 0.01;
    expect(distinct(chordAt(s, t))).toBe(10);
    expect(lineArtifacts(s, { from: m.at, to: t })).toEqual([]);
  });
});

describe('chord count births', () => {
  it('extra voices take octaves; a narrow register doubles', () => {
    const chord = (count: number, register?: [number, number]): MomentInput => ({
      id: 'c',
      type: 'chord',
      at: 1,
      notes: { kind: 'pitches', pitches: [62, 65, 69] },
      voicing: 'even',
      assign: 'ordered',
      count,
      ...(register && { register }),
    });
    const s = run(C7, chord(8));
    const c = chordAt(s, 10);
    expect(c).toHaveLength(8);
    expect(distinct(c)).toBe(8);
    for (const p of c) expect([2, 5, 9]).toContain(pc(p));
    expect(lineArtifacts(s)).toEqual([]);
    // The octaves stay inside an explicit register.
    const n = chordAt(run(C7, chord(8, [60, 72])), 10);
    expect(Math.min(...n)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...n)).toBeLessThanOrEqual(72);
    expect(distinct(n)).toBe(3);
  });

  it('a plain chord (no count) still doubles', () => {
    const s = run(C7, {
      id: 'c',
      type: 'chord',
      at: 1,
      notes: { kind: 'pitches', pitches: [62, 69] },
      voicing: 'even',
      assign: 'ordered',
    });
    expect(distinct(chordAt(s, 10))).toBe(2);
  });
});

it('incremental compile matches the full compile', () => {
  const p = piece({ start: C7, glide: GLIDE, end: { at: 30, fade: 1 }, moments: [split(6)] });
  const inc = createIncrementalCompiler();
  inc.compile(p);
  for (const count of [8, 10, 12, 5]) {
    const q = structuredClone(p);
    const m = q.moments[0];
    if (m.type === 'split') m.count = count;
    expect(inc.compile(q)).toEqual(compile(q));
  }
});
