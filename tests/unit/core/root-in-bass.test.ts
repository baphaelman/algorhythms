/**
 * Root in the bass (docs/composing.md §3 #2): a chord symbol on exactly one sounding line puts it
 * on the chord's bass (slash bass, else root), at the octave nearest its pitch within its range.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import type { Piece, Pitch, VoiceSelector } from '../../../src/core/types';
import { chordAt, finalPitch, piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const BASS: VoiceSelector = { part: 'Bass' };

/** v1–v3 "Chords" on C E G; v4 "Bass" on `bass` (v5, v6 "Bass", dormant). */
function band(bass: Pitch, moments: MomentInput[]): Piece {
  const p = piece({
    pool: 6,
    start: [60, 64, 67, bass],
    glide: GLIDE,
    end: { at: 30, fade: 1 },
    key: { tonic: 'C', scale: 'major' },
    moments,
  });
  p.voices.forEach((v, i) => (v.part = i >= 3 ? 'Bass' : 'Chords'));
  return p;
}

const chord = (
  symbol: string,
  target: VoiceSelector,
  extra: Partial<Extract<MomentInput, { type: 'chord' }>> = {},
): MomentInput => ({
  type: 'chord',
  at: 1,
  notes: { kind: 'chord', symbol },
  voicing: 'close',
  assign: 'ordered',
  target,
  ...extra,
});

const bassOf = (p: Piece): Pitch => finalPitch(compile(p).voices[3]);

describe('root in the bass', () => {
  it('a one-line part takes the root at the nearest octave', () => {
    expect(bassOf(band(43, [chord('Am', BASS)]))).toBe(45);
    expect(bassOf(band(50, [chord('Am7', BASS)]))).toBe(45);
    expect(bassOf(band(52, [chord('Am', BASS)]))).toBe(57);
    // Ties go down: C♯3 (49) is 6 from both G2 (43) and G3 (55).
    expect(bassOf(band(49, [chord('G', BASS)]))).toBe(43);
    // Numerals too: vi in C is A.
    expect(bassOf(band(43, [chord('vi', BASS)]))).toBe(45);
    // Every voicing mode.
    for (const voicing of ['even', 'close', 'nearest'] as const)
      expect(bassOf(band(48, [chord('Em', BASS, { voicing })])), voicing).toBe(52);
  });

  it('a slash bass wins over the root', () => {
    expect(bassOf(band(48, [chord('C/E', BASS)]))).toBe(52);
    expect(bassOf(band(43, [chord('Am/G', BASS)]))).toBe(43);
  });

  it("stays within the line's range, and the chord's register when it holds one", () => {
    const p = band(55, [chord('A', BASS)]);
    p.voices[3].range = [40, 56];
    expect(bassOf(p)).toBe(45); // 57 is nearer but out of range
    expect(bassOf(band(55, [chord('A', BASS, { register: [36, 50] })]))).toBe(45);
  });

  it('a single voice and a rank of size 1 count as one line', () => {
    expect(bassOf(band(43, [chord('Dm', { voices: ['v4'] })]))).toBe(38);
    expect(bassOf(band(43, [chord('Dm', { rank: [0, 0] })]))).toBe(38);
  });

  it('several lines are voiced as before', () => {
    // nearest: C→C, E→E, G→A; the root is not forced to the bottom.
    const s = compile(band(43, [chord('Am', { part: 'Chords' }, { voicing: 'nearest' })]));
    expect(chordAt(s, 10)).toEqual([43, 60, 64, 69]);
  });

  it('hand-written notes and per-voice overrides win', () => {
    const pitches: MomentInput = {
      type: 'chord',
      at: 1,
      notes: { kind: 'pitches', pitches: [52] },
      voicing: 'close',
      assign: 'ordered',
      target: BASS,
    };
    expect(bassOf(band(43, [pitches]))).toBe(52);
    expect(bassOf(band(43, [chord('Am', BASS, { overrides: [{ voice: 3, pitch: 48 }] })]))).toBe(
      48,
    );
  });

  it('a chord count that adds lines is voiced as before', () => {
    const s = compile(band(43, [chord('Am', BASS, { count: 3 })]));
    // Two newborns join the bass's part: three lines on A C E.
    expect(chordAt(s, 10).length).toBe(6);
  });

  it('incremental compile equals full compile', () => {
    const p = band(43, [chord('Am', BASS), { ...chord('F/C', BASS), at: 3 }]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const q = structuredClone(p);
    (q.moments.find((m) => m.id === 'm1') as { notes: unknown }).notes = {
      kind: 'chord',
      symbol: 'Dm',
    };
    const full = compile(q);
    expect(inc.compile(q)).toEqual(full);
    expect(finalPitch(full.voices[3])).toBe(50);
  });
});
