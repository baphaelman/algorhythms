/**
 * The `note` moment (PLAN.md §6.2 note row, revision 6; §7.2, §7.5, §7.9), its palette default
 * and `noteAt` hit testing (§11.3 note points).
 */
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import { defaultNoteFields, nearestNote, noteTargets } from '../../../src/core/moments/note';
import { chordAt as harmonyAt, noteAt, pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { CompiledScore, NoteMoment, Piece } from '../../../src/core/types';
import { chordAt, finalPitch, piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 2, jitter: 0.2, stagger: 0.6, ease: 'smootherstep' as const };
const END = { at: 30, fade: 1 };
const START = [48, 55, 60, 64, 67];

function note(from: number, to: number, extra: Partial<NoteMoment> = {}): MomentInput {
  return { id: 'n', type: 'note', at: 1, from, to, ...extra };
}

/** `piece` with the end at 30 s. */
const make = (opts: Parameters<typeof piece>[0]): Piece => piece({ end: END, ...opts });

const codes = (s: CompiledScore) => s.diagnostics.map((d) => d.code);

/** Pool indices of the voices with a moving segment from moment `id`. */
function movers(s: CompiledScore, id: string): number[] {
  return s.voices
    .filter((v) => v.segments.some((g) => g.momentId === id && (g.p0 !== g.p1 || g.curve)))
    .map((v) => v.index);
}

/** Adjacent voices (by start order) never cross between t0 and t1. */
function expectNoCrossings(s: CompiledScore, order: number[], t0: number, t1: number): void {
  for (let j = 0; j <= 400; j++) {
    const t = t0 + ((t1 - t0) * j) / 400;
    for (let k = 0; k + 1 < order.length; k++) {
      const a = pitchAt(s.voices[order[k]], t)!;
      const b = pitchAt(s.voices[order[k + 1]], t)!;
      expect(a, `v${order[k] + 1}/v${order[k + 1] + 1} at ${t}`).toBeLessThanOrEqual(b + 1e-9);
    }
  }
}

describe('noteTargets / nearestNote', () => {
  it('replaces one entry and keeps order; reports the carrier', () => {
    expect(noteTargets([48, 55, 60, 64, 67], 2, 62)).toEqual({ q: [48, 55, 62, 64, 67], at: 2 });
    expect(noteTargets([48, 55, 60, 64, 67], 2, 70)).toEqual({ q: [48, 55, 64, 67, 70], at: 4 });
    expect(noteTargets([48, 55, 60, 64, 67], 3, 50)).toEqual({ q: [48, 50, 55, 60, 67], at: 1 });
    expect(noteTargets([60, 60, 67], 0, 62)).toEqual({ q: [60, 62, 67], at: 1 });
  });

  it('matches within half a semitone, by either pitch list; ties go low', () => {
    expect(nearestNote([48, 60, 64], 60.3)).toBe(1);
    expect(nearestNote([48, 60, 64], 62)).toBe(-1);
    expect(nearestNote([48, 60, 64], 62, [48, 61.8, 64])).toBe(1);
    expect(nearestNote([60, 61], 60.5 - 1e-9)).toBe(0);
    expect(nearestNote([60, 60], 60)).toBe(0);
  });
});

describe('note moment', () => {
  it('to between the neighbours: only that voice moves', () => {
    const s = compile(make({ start: START, glide: GLIDE, moments: [note(60, 62)] }));
    expect(codes(s)).toEqual([]);
    expect(movers(s, 'n')).toEqual([2]);
    expect(chordAt(s, 6)).toEqual([48, 55, 62, 64, 67]);
  });

  it('to passing neighbours: ordered result, no crossings', () => {
    for (const [from, to, want, moved] of [
      [60, 66, [48, 55, 64, 66, 67], [2, 3]],
      [60, 70, [48, 55, 64, 67, 70], [2, 3, 4]],
      [64, 50, [48, 50, 55, 60, 67], [1, 2, 3]],
    ] as const) {
      const s = compile(make({ start: START, glide: GLIDE, moments: [note(from, to)] }));
      expect(chordAt(s, 6), `${from}→${to}`).toEqual(want);
      expect(movers(s, 'n').sort()).toEqual([...moved]);
      // Pool order is pitch order at the start: it must stay so throughout.
      expectNoCrossings(s, [0, 1, 2, 3, 4], 0, 8);
      expect(s.voices.slice(0, 5).map(finalPitch)).toEqual(want);
    }
  });

  it('several voices on `from`: one moves', () => {
    const s = compile(make({ start: [60, 60, 67], glide: GLIDE, moments: [note(60, 62)] }));
    expect(movers(s, 'n')).toHaveLength(1);
    expect(chordAt(s, 6)).toEqual([60, 62, 67]);
  });

  it('`from` not sounding: warn, no effect, no no-effect report', () => {
    const p = make({ start: START, glide: GLIDE, moments: [note(61, 62)] });
    const s = compile(p);
    expect(codes(s)).toEqual(['note-not-sounding']);
    expect(s.diagnostics[0].level).toBe('warn');
    expect(movers(s, 'n')).toEqual([]);
    expect(momentEffectAt(p, compile(piece({ start: START })), p.moments[0])).toMatchObject({
      effect: false,
    });
  });

  it('`from` = `to`: no-effect', () => {
    const p = make({ start: START, glide: GLIDE, moments: [note(60, 60)] });
    const s = compile(p);
    expect(codes(s)).toEqual(['no-effect']);
    expect(s.diagnostics[0].message).toContain('the note does not change');
    const e = momentEffectAt(p, compile(piece({ start: START })), p.moments[0]);
    expect(e).toEqual({ effect: false, reason: 'the note does not change' });
  });

  it('matches a line mid-glide by the pitch sounding at t', () => {
    const p = make({
      start: START,
      glide: { ...GLIDE, stagger: 0, jitter: 0 },
      moments: [
        { id: 's', type: 'shift', at: 0, by: 2, unit: 'semitones' },
        note(0, 72, { at: 1 }),
      ],
    });
    const base = compile({ ...p, moments: [p.moments[0]] });
    const mid = pitchAt(base.voices[2], 1)!;
    expect(mid).toBeGreaterThan(60.5);
    expect(mid).toBeLessThan(61.5);
    (p.moments[1] as NoteMoment).from = mid;
    const s = compile(p);
    expect(codes(s)).toEqual([]);
    expect(chordAt(s, 8)).toEqual([50, 57, 66, 69, 72]);
  });

  it('`back` returns exactly to the original set, after the glide ends + back', () => {
    const p = make({
      start: START,
      glide: GLIDE,
      end: { at: 20, fade: 1 },
      moments: [note(60, 70, { back: 2 })],
    });
    const { score: s, trace } = compileWithTrace(p);
    expect(codes(s)).toEqual([]);
    expect(trace.moments.map((m) => m.t)).toHaveLength(2);
    const [first, ret] = trace.moments;
    expect(ret.t).toBeCloseTo(first.plan!.window[1] + 2, 9);
    expect(chordAt(s, first.plan!.window[1] + 1)).toEqual([48, 55, 64, 67, 70]);
    expect(s.voices.slice(0, 5).map(finalPitch)).toEqual(START);
    expectNoCrossings(s, [0, 1, 2, 3, 4], 0, 19.9);
    // The moment's span covers the return.
    const span = s.momentSpans.find((x) => x.id === 'n')!;
    expect(span.end).toBeGreaterThan(ret.t);
  });

  it('`back` is skipped when a later moment moved the note away (§7.5)', () => {
    const p = make({
      start: START,
      glide: GLIDE,
      moments: [
        note(60, 62, { back: 3 }),
        { id: 's', type: 'shift', at: 4, by: 5, unit: 'semitones' },
      ],
    });
    const s = compile(p);
    expect(codes(s)).toEqual(['note-back-skipped']);
    expect(chordAt(s, 15)).toEqual([53, 60, 67, 69, 72]);
  });

  it('the chord label follows the new set (and the return)', () => {
    const p = make({
      start: [48, 60, 64, 67],
      glide: GLIDE,
      end: { at: 20, fade: 1 },
      moments: [note(64, 63, { back: 2 })],
    });
    const s = compile(p);
    const labels = s.harmony!.map((h) => h.label);
    expect(labels).toHaveLength(2);
    expect(labels[0]).not.toEqual(labels[1]);
    expect(harmonyAt(s, 1.5)!.pcs).toEqual([0, 3, 7]);
    expect(harmonyAt(s, 19)!.pcs).toEqual([0, 4, 7]);
  });

  it('a pending move the note does not change still arrives', () => {
    // The chord's stagger leaves moves pending at 1.1; the note cancels and re-issues them.
    const p = make({
      start: START,
      glide: { length: 2, jitter: 0, stagger: 3, order: 'low-first' },
      moments: [
        { id: 'c', type: 'shift', at: 1, by: 1, unit: 'semitones' },
        note(55, 57, { at: 1.1 }),
      ],
    });
    const s = compile(p);
    expect(chordAt(s, 12)).toEqual([49, 57, 61, 65, 68]);
  });

  it('a note that does not apply leaves pending moves alone', () => {
    const glide = { length: 2, jitter: 0, stagger: 3, order: 'low-first' as const };
    const shift: MomentInput = { id: 'c', type: 'shift', at: 1, by: 1, unit: 'semitones' };
    const base = compile(make({ start: START, glide, moments: [shift] }));
    for (const n of [note(58, 59, { at: 1.1 }), note(55, 55, { at: 1.1 })]) {
      const s = compile(make({ start: START, glide, moments: [shift, n] }));
      expect(s.voices).toEqual(base.voices);
    }
  });

  it('incremental compile equals full compile', () => {
    const p = make({
      start: START,
      pool: 8,
      glide: GLIDE,
      moments: [
        note(60, 66, { back: 1.5 }),
        { id: 's', type: 'shift', at: 2, by: 2, unit: 'scaleSteps' },
        { id: 'n2', type: 'note', at: 9, from: 69, to: 71, back: 0.5 },
        {
          id: 'c',
          type: 'chord',
          at: 14,
          notes: { kind: 'chord', symbol: 'Am7' },
          voicing: 'even',
          assign: 'ordered',
        },
        { id: 'l', type: 'level', at: 16, gain: 0.5, over: 1 },
      ],
    });
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const edits: ((q: Piece) => void)[] = [
      (q) => ((q.moments[4] as { gain: number }).gain = 0.7),
      (q) => ((q.moments[3] as { at: number }).at = 13),
      (q) => ((q.moments[2] as NoteMoment).back = 3),
      (q) => ((q.moments[2] as NoteMoment).to = 60),
      (q) => delete (q.moments[0] as NoteMoment).back,
      (q) => ((q.moments[0] as NoteMoment).from = 61),
    ];
    let q = p;
    let resumed = 0;
    for (const e of edits) {
      q = structuredClone(q);
      e(q);
      expect(inc.compile(q)).toEqual(compile(q));
      if (inc.stats.mode === 'resume') resumed++;
    }
    expect(resumed).toBeGreaterThanOrEqual(3);
  });

  it('schema: round-trips; `from` and `to` required; `back` ≥ 0', () => {
    const p = make({ start: START, moments: [note(60, 62, { back: 1.5 })] });
    const parsed = parsePiece(JSON.parse(serializePiece(p)));
    expect(parsed.ok && parsed.piece.moments).toEqual(p.moments);
    const bad = (f: (m: Record<string, unknown>) => void) => {
      const j = JSON.parse(serializePiece(p));
      f(j.moments[0]);
      return parsePiece(j).ok;
    };
    expect(bad((m) => delete m.to)).toBe(false);
    expect(bad((m) => delete m.from)).toBe(false);
    expect(bad((m) => (m.back = -1))).toBe(false);
    expect(bad((m) => delete m.back)).toBe(true);
  });
});

describe('note points: defaults and hit testing (§11.3)', () => {
  const s = compile(piece({ start: START }));

  it('default: the sounding note nearest the middle, one scale step up', () => {
    // Middle of 48..67 is 57.5: 55 and 60 tie, the lower wins; one step up in A dorian is 57.
    expect(defaultNoteFields(s, 1)).toEqual({ from: 55, to: 57 });
    expect(defaultNoteFields(compile(piece({ start: [60, 64, 67] })), 1)).toEqual({
      from: 64,
      to: 66,
    });
    expect(defaultNoteFields(compile(piece({ start: [] })), 1)).toEqual({ from: 60, to: 62 });
  });

  it('the default note has an effect (palette)', () => {
    const p = make({ start: START });
    const m = { id: 'x', type: 'note', at: 1, ...defaultNoteFields(s, 1) } as NoteMoment;
    expect(momentEffectAt(p, s, m)).toEqual({ effect: true });
  });

  it('noteAt finds the nearest sounding voice', () => {
    expect(noteAt(s, 1, 61)).toMatchObject({ voice: 2, pitch: 60, dest: 60, distance: 1 });
    expect(noteAt(s, 1, 66)).toMatchObject({ voice: 4, pitch: 67 });
    expect(noteAt(s, 1, 62, 1)).toBeNull();
    expect(noteAt(compile(piece({ start: [] })), 1, 60)).toBeNull();
  });
});
