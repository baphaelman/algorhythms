/**
 * HUD chord names in tune-driven passages (composing.md §3 #11, compiler/tune-harmony.ts).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { MIN_NAME_HOLD, nameWindow } from '../../../src/core/compiler/tune-harmony';
import { chordAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const ROOT = join(import.meta.dirname, '../../..');
const load = (f: string): Piece => {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, f), 'utf8')));
  if (!r.ok) throw new Error(f);
  return r.piece;
};
const label = (s: CompiledScore, t: number): string | null => chordAt(s, t)?.label ?? null;
const tune = (part: string, notes: [number, number][], at = 0): MomentInput => ({
  type: 'tune',
  at,
  target: { part },
  notes: notes.map(([pitch, len]) => ({ pitch, len })),
});

/** Three one-line parts on C E G at 0 (the opening chord). */
function trio(moments: MomentInput[]): Piece {
  const p = piece({
    pool: 3,
    start: [48, 64, 67],
    key: { tonic: 'C', scale: 'major' },
    end: { at: 9, fade: 0.5 },
    glide: { length: 0.05, stagger: 0, jitter: 0 },
    moments,
  });
  p.voices.forEach((v, i) => (v.part = ['Bass', 'Mid', 'Top'][i]));
  return p;
}

const TUNES: MomentInput[] = [
  tune('Bass', [
    [48, 2],
    [41, 2],
    [43, 2],
    [48, 2],
  ]),
  tune('Mid', [
    [64, 2],
    [57, 2],
    [59, 2],
    [64, 2],
  ]),
  // A passing A4 in the first beat, and a fast G–A trill in the second.
  tune('Top', [
    [67, 0.75],
    [69, 0.25],
    [67, 0.25],
    [69, 0.25],
    [67, 0.25],
    [69, 0.25],
    [72, 2],
    [74, 2],
    [67, 2],
  ]),
];

describe('HUD chord in tune-driven pieces', () => {
  it('names what the tunes sound when no chord drives the lines', () => {
    const s = compile(trio(TUNES));
    expect(label(s, 0.5)).toBe('C');
    expect(label(s, 2.5)).toBe('F');
    expect(label(s, 4.5)).toBe('G');
    expect(label(s, 6.5)).toBe('C');
    const tunes = (s.harmony ?? []).filter((h) => h.from === 'tunes');
    expect(tunes.length).toBeGreaterThan(0);
    expect(tunes.every((h) => h.momentId !== undefined)).toBe(true);
  });

  it('does not flicker on passing notes, and keeps a name at least 0.4 s', () => {
    const s = compile(trio(TUNES));
    const h = s.harmony ?? [];
    // The passing A4 and the trill never rename the C chord.
    expect(h.filter((e) => e.t < 2).map((e) => e.label)).toEqual(['C']);
    for (let j = 1; j < h.length; j++) {
      if (h[j].from === 'tunes') expect(h[j].t - h[j - 1].t).toBeGreaterThanOrEqual(MIN_NAME_HOLD);
    }
    expect(nameWindow(undefined)).toBe(1);
    expect(nameWindow(88)).toBeCloseTo(60 / 88, 12);
    expect(nameWindow(200)).toBeCloseTo(0.6, 12); // two beats: one is under 0.4 s
  });

  it('a melody tune over chord-driven lines does not rename the chord (R9-4)', () => {
    const p = trio([
      {
        type: 'chord',
        at: 2,
        target: { parts: ['Bass', 'Mid'] },
        notes: { kind: 'chord', symbol: 'F' },
        voicing: 'close',
        assign: 'ordered',
      },
      tune('Top', [
        [67, 1],
        [69, 0.5],
        [71, 0.5],
        [72, 1],
        [74, 1],
        [76, 2],
      ]),
    ]);
    const s = compile(p);
    expect((s.harmony ?? []).some((h) => h.from !== undefined)).toBe(false);
    expect(label(s, 1.5)).toBe(label(s, 0.1));
    expect(label(s, 5)).toBe('F');
  });

  it('chord-driven examples and Porch Light keep their compiled timeline', () => {
    const files = readdirSync(join(ROOT, 'examples'))
      .filter((f) => f.endsWith('.algorhythms.json'))
      .map((f) => `examples/${f}`);
    for (const f of [...files, 'examples/songs/porch-light.algorhythms.json']) {
      const h = compile(load(f)).harmony ?? [];
      expect(h.length, f).toBeGreaterThan(0);
      expect(
        h.filter((e) => e.from !== undefined),
        f,
      ).toEqual([]);
    }
  });

  it('Little Round names its round F, Dm, B♭, C, and resumes incrementally the same', () => {
    const p = load('examples/songs/little-round.algorhythms.json');
    const s = compile(p);
    expect([27.5, 29, 30.8, 31.6].map((t) => label(s, t))).toEqual(['F', 'Dm', 'B♭', 'C']);
    expect(new Set((s.harmony ?? []).map((h) => h.label)).size).toBeGreaterThan(8);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toStrictEqual(s);
    const m = p.moments[Math.floor(p.moments.length / 2)];
    const moved: Piece = {
      ...p,
      moments: p.moments.map((x) => (x.id === m.id ? { ...x, at: x.at + 0.5 } : x)),
    };
    expect(inc.compile(moved)).toStrictEqual(compile(moved));
    expect(inc.stats.mode).toBe('resume');
  });
});
