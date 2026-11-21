/**
 * R9-1 (PLAN §5, §11.3 "Parts", revision 9): distinct notes holds within a part; lines in
 * different parts may share a resting pitch and never merge; `{ part }` targets.
 */
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import { linesAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import { chordAt, piece, pitchesAt, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };

/** v1–v3, v5, v6 "Chords"; v4, v7, v8 "Melody". The opening sounds v1–v4. */
const PARTS = ['Chords', 'Chords', 'Chords', 'Melody', 'Chords', 'Chords', 'Melody', 'Melody'];

function parted(start: number[], moments: MomentInput[], parts: boolean = true): Piece {
  const p = piece({ pool: 8, start, glide: GLIDE, end: { at: 30, fade: 1 }, moments });
  if (parts) p.voices.forEach((v, i) => (v.part = PARTS[i]));
  return p;
}

const partOfVoice = (p: Piece, v: number): string => p.voices[v].part ?? '';

describe('parts: lines of different parts never merge', () => {
  it("a pin onto another part's resting pitch does not merge", () => {
    const m: MomentInput[] = [{ type: 'pin', at: 1, voice: 'v4', pitch: 60 }];
    const s = compile(parted([48, 55, 60, 72], m));
    expect(linesAt(s, 10)).toBe(4);
    expect(chordAt(s, 10)).toEqual([48, 55, 60, 60]);
    // The same pin without parts merges (revision 8).
    expect(linesAt(compile(parted([48, 55, 60, 72], m, false)), 10)).toBe(3);
  });

  it('a unison across parts merges each part into one line', () => {
    const s = compile(
      parted([48, 55, 60, 72], [{ type: 'unison', at: 1, pitch: 60, octaves: false }]),
    );
    expect(linesAt(s, 10)).toBe(2);
    expect(chordAt(s, 10)).toEqual([60, 60]);
  });

  it('an explicit merge glides into a neighbour of its own part', () => {
    // v3 (Chords, 70): nearest neighbour is v4 (Melody, 71); its own part's is v2 (60).
    const m: MomentInput[] = [
      { type: 'merge', at: 1, count: 3, which: 'top', fade: 0.5, target: { voices: ['v3'] } },
    ];
    const into = (p: Piece): number | undefined =>
      compileWithTrace(p)
        .trace.moments.find((t) => t.id === 'm0')!
        .intents!.find((it) => it.kind === 'death')!.into;
    expect(into(parted([48, 60, 70, 71], m))).toBe(1);
    expect(into(parted([48, 60, 70, 71], m, false))).toBe(3);
    const s = compile(parted([48, 60, 70, 71], m));
    expect(chordAt(s, 10)).toEqual([48, 60, 71]);
  });

  it('a merge with no survivor in its part fades where it is', () => {
    const m: MomentInput[] = [{ type: 'merge', at: 1, count: 3, which: 'top', fade: 0.5 }];
    const { score: s, trace } = compileWithTrace(parted([48, 60, 70, 72], m));
    const death = trace.moments
      .find((t) => t.id === 'm0')!
      .intents!.find((it) => it.kind === 'death')!;
    expect(death.voice).toBe(3);
    expect(death.into).toBe(-1);
    expect(chordAt(s, 10)).toEqual([48, 60, 70]);
  });

  it('a chord count death merges into its own part', () => {
    const m: MomentInput[] = [
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches: [48, 60, 72] },
        voicing: 'even',
        assign: 'ordered',
        count: 3,
      },
    ];
    const { trace } = compileWithTrace(parted([48, 60, 70, 72], m));
    const p = parted([48, 60, 70, 72], m);
    for (const it of trace.moments.find((t) => t.id === 'm0')!.intents!) {
      if (it.kind !== 'death' || it.into === undefined || it.into < 0) continue;
      expect(partOfVoice(p, it.into)).toBe(partOfVoice(p, it.voice));
    }
  });

  it("a newborn is a voice of its parent's part", () => {
    const m: MomentInput[] = [{ type: 'split', at: 1, count: 7, voicing: 'even' }];
    const p = parted([48, 55, 60, 72], m);
    const { trace } = compileWithTrace(p);
    const births = trace.moments
      .find((t) => t.id === 'm0')!
      .intents!.filter((it) => it.kind === 'birth');
    expect(births.length).toBeGreaterThan(0);
    for (const b of births) expect(partOfVoice(p, b.voice)).toBe(partOfVoice(p, b.parent!));
  });
});

describe('parts: free octaves', () => {
  // Chords on 48 55 64 (v1–v3), Melody on 72 (v4); a close C triad in [67, 79] is 67 72 76.
  const chord = (target: MomentInput['target']): MomentInput[] => [
    {
      type: 'chord',
      at: 1,
      notes: { kind: 'chord', symbol: 'C' },
      voicing: 'close',
      assign: 'ordered',
      register: [67, 79],
      target,
    },
  ];

  it("a chord in one part ignores the other part's notes", () => {
    const s = compile(parted([48, 55, 64, 72], chord({ part: 'Chords' })));
    expect(chordAt(s, 10)).toEqual([67, 72, 72, 76]);
    expect(linesAt(s, 10)).toBe(4);
  });

  it('without parts the held note is taken, so the chord moves off it', () => {
    const s = compile(parted([48, 55, 64, 72], chord({ voices: ['v1', 'v2', 'v3'] }), false));
    const ps = chordAt(s, 10);
    expect(ps.filter((p) => p === 72)).toHaveLength(1);
    expect(linesAt(s, 10)).toBe(4);
  });
});

describe('parts: the { part } target', () => {
  it('picks only the active voices of that part', () => {
    const s = compile(
      parted(
        [48, 55, 60, 72],
        [{ type: 'shift', at: 1, by: 2, unit: 'semitones', target: { part: 'Melody' } }],
      ),
    );
    expect(pitchesAt(s, 10).slice(0, 4)).toEqual([48, 55, 60, 74]);
  });

  it("counts that part's lines (split and merge)", () => {
    const s = compile(
      parted(
        [48, 55, 60, 72],
        [
          { type: 'split', at: 1, count: 3, voicing: 'even', target: { part: 'Melody' } },
          { type: 'merge', at: 8, count: 1, which: 'top', fade: 0.5, target: { part: 'Chords' } },
        ],
      ),
    );
    // Melody: 1 → 3 lines, its newborns v7, v8; Chords: 3 → 1.
    expect(linesAt(s, 6)).toBe(6);
    expect(pitchesAt(s, 6)[6]).not.toBeNull();
    expect(pitchesAt(s, 6)[7]).not.toBeNull();
    expect(pitchesAt(s, 6)[4]).toBeNull();
    expect(linesAt(s, 15)).toBe(4);
  });

  it('an unknown part warns `unknown-part` and targets nothing', () => {
    const s = compile(
      parted(
        [48, 55, 60, 72],
        [{ type: 'shift', at: 1, by: 2, unit: 'semitones', target: { part: 'Bass' } }],
      ),
    );
    const d = s.diagnostics.filter((x) => x.code === 'unknown-part');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ level: 'warn', momentId: 'm0' });
    expect(chordAt(s, 10)).toEqual([48, 55, 60, 72]);
  });

  it('establishes from silence with the dormant voices of the part', () => {
    const p = parted([], []);
    p.moments = [
      {
        id: 'o',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [72, 76] },
        voicing: 'even',
        assign: 'ordered',
        target: { part: 'Melody' },
      },
    ];
    const s = compile(p);
    const on = pitchesAt(s, 1).flatMap((x, i) => (x === null ? [] : [i]));
    expect(on.map((i) => p.voices[i].part)).toEqual(['Melody', 'Melody']);
  });

  it('the palette reads the part (momentEffectAt)', () => {
    const p = parted([48, 55, 60, 72], []);
    const s = compile(p);
    const merge = (part: string) =>
      momentEffectAt(p, s, {
        id: 'x',
        type: 'merge',
        at: 5,
        count: 1,
        which: 'top',
        fade: 0.5,
        target: { part },
      });
    expect(merge('Melody').effect).toBe(false);
    expect(merge('Chords').effect).toBe(true);
  });

  it('round-trips through the schema', () => {
    const p = parted(
      [48, 72],
      [{ type: 'shift', at: 1, by: 1, unit: 'semitones', target: { part: 'Melody' } }],
    );
    const r = parsePiece(JSON.parse(JSON.stringify(p)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.piece.voices[3].part).toBe('Melody');
    expect(r.piece.moments[1].target).toEqual({ part: 'Melody' });
  });
});

describe('parts: incremental compile', () => {
  it('equals the full compile across edits', () => {
    const p = parted(
      [48, 55, 60, 72],
      [
        { type: 'pin', at: 1, voice: 'v4', pitch: 60 },
        { type: 'unison', at: 4, pitch: 60, octaves: false },
        { type: 'split', at: 8, count: 7, voicing: 'even' },
        { type: 'shift', at: 12, by: 3, unit: 'semitones', target: { part: 'Melody' } },
      ],
    );
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const q = structuredClone(p);
    q.moments[3].at = 6;
    expect(inc.compile(q)).toEqual(compile(q));
    const r = structuredClone(q);
    r.voices[2].part = 'Melody';
    expect(inc.compile(r)).toEqual(compile(r));
  });
});
