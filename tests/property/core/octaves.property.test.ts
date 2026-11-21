/**
 * Octaves before unisons (PLAN.md §11.3 rev 7, M4.5-24): a split with more voices than distinct
 * notes sounds as many distinct pitches as the range allows: min(voices, the notes' octaves in
 * range), every one an octave of a given note.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { voiceNotes } from '../../../src/core/voicing';
import { chordAt, piece } from '../../unit/core/compiler-fixtures';
import { lineArtifacts } from '../../unit/core/line-artifacts';

const RUNS = Number(process.env.PROP_RUNS ?? 200);
const SEED = process.env.PROP_SEED === 'random' ? undefined : Number(process.env.PROP_SEED ?? 2611);
const POOL = 16;

/** A register, and 1..6 distinct pitches inside it. */
const caseArb = fc
  .record({ lo: fc.integer({ min: 30, max: 70 }), width: fc.integer({ min: 4, max: 48 }) })
  .chain(({ lo, width }) =>
    fc.record({
      lo: fc.constant(lo),
      hi: fc.constant(lo + width),
      notes: fc.uniqueArray(fc.integer({ min: lo, max: lo + width }), {
        minLength: 1,
        maxLength: 6,
      }),
      k: fc.integer({ min: 1, max: POOL }),
    }),
  );

/** Every pitch in [lo, hi] that is an octave of (or equal to) one of `notes`. */
function octaveClosure(notes: number[], lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const x of notes) for (let p = x - 12 * 12; p <= hi; p += 12) if (p >= lo) out.add(p);
  return out;
}

const isOctaveOf = (notes: number[], p: number) =>
  notes.some((x) => (((p - x) % 12) + 12) % 12 === 0);

describe('octaves before unisons', () => {
  it('voiceNotes: distinct targets = min(k, octaves in range); notes kept', () => {
    fc.assert(
      fc.property(caseArb, ({ lo, hi, notes, k }) => {
        const r = voiceNotes({
          notes: { kind: 'pitches', pitches: notes },
          k,
          mode: 'even',
          register: [lo, hi],
          key: { tonic: 'C', scale: 'major' },
          current: [],
          voices: [],
          octaves: true,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const room = octaveClosure(notes, lo, hi).size;
        expect(new Set(r.targets).size).toBe(r.targets.length);
        expect(r.targets.length).toBe(notes.length >= k ? k : Math.min(k, room));
        for (const p of r.targets) {
          expect(p).toBeGreaterThanOrEqual(lo);
          expect(p).toBeLessThanOrEqual(hi);
          expect(isOctaveOf(notes, p)).toBe(true);
        }
        if (notes.length <= k) for (const x of notes) expect(r.targets).toContain(x);
      }),
      { numRuns: RUNS * 5, seed: SEED },
    );
  });

  it('compiled split: as many distinct pitches as voices allow, no line artifacts', () => {
    fc.assert(
      fc.property(caseArb, fc.boolean(), ({ lo, hi, notes, k }, many) => {
        const start = many ? notes.slice(0, Math.ceil(notes.length / 2)) : [notes[0]];
        const p = piece({
          pool: POOL,
          range: [lo, hi],
          start,
          glide: { length: 2, jitter: 0.3, stagger: 1 },
          end: { at: 12, fade: 1 },
          moments: [
            {
              type: 'split',
              at: 1,
              count: k,
              notes: { kind: 'pitches', pitches: notes },
              voicing: 'even',
            },
          ],
        });
        const s = compile(p);
        const c = chordAt(s, 9);
        const voices = Math.max(k, start.length);
        expect(c).toHaveLength(voices);
        const want =
          notes.length >= voices ? voices : Math.min(voices, octaveClosure(notes, lo, hi).size);
        expect(new Set(c).size).toBe(want);
        for (const x of c) expect(isOctaveOf(notes, x)).toBe(true);
        expect(lineArtifacts(s, { to: 9 })).toEqual([]);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });
});
