/**
 * Grouped note changes (PLAN.md §11.3 revision 7): a `note` moment with `changes` applies them
 * all in one moment, each on its own voice, honouring `order` and `back`.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import {
  noteChanges,
  noteIsNoop,
  noteTargetsMany,
  withNoteChanges,
} from '../../../src/core/moments/note';
import { pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { CompiledScore, NoteMoment, Piece } from '../../../src/core/types';
import { chordAt, finalPitch, piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 2, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const START = [48, 55, 60, 64, 67];

const make = (moments: MomentInput[], extra: Parameters<typeof piece>[0] = {}): Piece =>
  piece({ start: START, glide: GLIDE, end: { at: 30, fade: 1 }, moments, ...extra });

function shift(changes: { from: number; to: number }[], extra: Partial<NoteMoment> = {}) {
  return { id: 'n', type: 'note', at: 1, changes, ...extra } as MomentInput;
}

const codes = (s: CompiledScore) => s.diagnostics.map((d) => d.code);
const movers = (s: CompiledScore) =>
  s.voices
    .filter((v) => v.segments.some((g) => g.momentId === 'n' && g.p0 !== g.p1))
    .map((v) => v.index);

describe('noteChanges / withNoteChanges', () => {
  it('reads either form and writes the canonical one', () => {
    const one = { id: 'a', type: 'note', at: 0, from: 60, to: 62 } as NoteMoment;
    expect(noteChanges(one)).toEqual([{ from: 60, to: 62 }]);
    const two = withNoteChanges(one, [
      { from: 60, to: 62 },
      { from: 64, to: 65 },
    ]);
    expect(two).toEqual({
      id: 'a',
      type: 'note',
      at: 0,
      changes: [
        { from: 60, to: 62 },
        { from: 64, to: 65 },
      ],
    });
    expect(withNoteChanges(two, [{ from: 64, to: 65 }])).toEqual({
      id: 'a',
      type: 'note',
      at: 0,
      from: 64,
      to: 65,
    });
    expect(noteIsNoop(withNoteChanges(one, [{ from: 60, to: 60 }]))).toBe(true);
    expect(noteChanges({ id: 'x', type: 'note', at: 0 } as NoteMoment)).toEqual([]);
  });

  it('noteTargetsMany sorts once and reports each carrier', () => {
    expect(noteTargetsMany([48, 55, 60, 64, 67], [2, 3], [66, 50])).toEqual({
      q: [48, 50, 55, 66, 67],
      at: [3, 1],
    });
  });
});

describe('note moment with changes', () => {
  it('without order: each change moves its own voice, in one moment', () => {
    const s = compile(
      make([
        shift([
          { from: 60, to: 62 },
          { from: 67, to: 71 },
        ]),
      ]),
    );
    expect(codes(s)).toEqual([]);
    expect(movers(s)).toEqual([2, 4]);
    expect(s.voices.slice(0, 5).map(finalPitch)).toEqual([48, 55, 62, 64, 71]);
  });

  it('two changes on one pitch take two voices sounding it', () => {
    const s = compile(
      make(
        [
          shift([
            { from: 60, to: 59 },
            { from: 60, to: 62 },
          ]),
        ],
        { start: [60, 60, 67] },
      ),
    );
    expect(codes(s)).toEqual([]);
    expect(chordAt(s, 6)).toEqual([59, 62, 67]);
  });

  it('with order: the replaced set is sorted once, no crossings', () => {
    const s = compile(
      make([
        shift(
          [
            { from: 60, to: 66 },
            { from: 64, to: 50 },
          ],
          { order: true },
        ),
      ]),
    );
    expect(codes(s)).toEqual([]);
    expect(s.voices.slice(0, 5).map(finalPitch)).toEqual([48, 50, 55, 66, 67]);
    for (let t = 0; t < 8; t += 0.05) {
      for (let k = 0; k < 4; k++) {
        expect(pitchAt(s.voices[k], t)!).toBeLessThanOrEqual(pitchAt(s.voices[k + 1], t)! + 1e-9);
      }
    }
  });

  it('`back` returns every change', () => {
    const s = compile(
      make([
        shift(
          [
            { from: 60, to: 62 },
            { from: 48, to: 47 },
          ],
          { back: 1 },
        ),
      ]),
    );
    expect(codes(s)).toEqual([]);
    expect(pitchAt(s.voices[2], 3.5)).toBeCloseTo(62, 6);
    expect(pitchAt(s.voices[0], 3.5)).toBeCloseTo(47, 6);
    expect(s.voices.slice(0, 5).map(finalPitch)).toEqual(START);
  });

  it('a change that matches no voice warns; the others still apply', () => {
    const s = compile(
      make([
        shift([
          { from: 61, to: 62 },
          { from: 64, to: 65 },
        ]),
      ]),
    );
    expect(codes(s)).toEqual(['note-not-sounding']);
    expect(movers(s)).toEqual([3]);
  });

  it('all changes no-ops: no-effect', () => {
    const s = compile(make([shift([{ from: 60, to: 60 }])]));
    expect(codes(s)).toEqual(['no-effect']);
  });

  it('incremental compile equals full compile', () => {
    const p = make(
      [
        shift(
          [
            { from: 60, to: 62 },
            { from: 67, to: 69 },
          ],
          { back: 1 },
        ),
        { id: 's', type: 'shift', at: 6, by: 2, unit: 'scaleSteps' },
        { id: 'n2', type: 'note', at: 12, changes: [{ from: 50, to: 52 }] } as MomentInput,
      ],
      { pool: 8 },
    );
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const edits: ((q: Piece) => void)[] = [
      // moments[0] is the opening chord.
      (q) => (q.moments[1] as NoteMoment).changes!.push({ from: 48, to: 47 }),
      (q) => ((q.moments[1] as NoteMoment).changes![1].to = 71),
      (q) => ((q.moments[3] as NoteMoment).changes![0].from = 51),
      (q) => delete (q.moments[1] as NoteMoment).back,
      (q) => ((q.moments[1] as NoteMoment).order = true),
    ];
    let q = p;
    for (const e of edits) {
      q = structuredClone(q);
      e(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
  });

  it('schema: either from/to or changes', () => {
    const p = make([
      shift([
        { from: 60, to: 62 },
        { from: 64, to: 65 },
      ]),
    ]);
    const parsed = parsePiece(JSON.parse(serializePiece(p)));
    expect(parsed.ok && parsed.piece.moments).toEqual(p.moments);
    const ok = (f: (m: Record<string, unknown>) => void) => {
      const j = JSON.parse(serializePiece(p));
      f(j.moments[1]); // after the opening
      return parsePiece(j).ok;
    };
    expect(ok((m) => (m.changes = []))).toBe(false);
    expect(ok((m) => ((m.from = 60), (m.to = 61)))).toBe(false);
    expect(ok((m) => delete m.changes)).toBe(false);
    expect(ok((m) => ((m.changes as unknown[])[0] = { from: 60 }))).toBe(false);
  });
});
