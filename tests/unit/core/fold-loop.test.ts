/** Next's closed loop (PLAN.md M13 "Next"): down a third, down a third, upside down, up a third. */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { pitchAt } from '../../../src/core/query';
import { suggestNext, type Suggestion } from '../../../src/core/suggest';
import type { Key, Moment, Piece } from '../../../src/core/types';
import { piece as base } from './compiler-fixtures';

/** A fixture piece that lasts a minute. */
const piece = (o: Parameters<typeof base>[0]): Piece => base({ ...o, end: { at: 60, fade: 2 } });

const C: Key = { tonic: 'C', scale: 'major' };

/** The sounding pitches at t, low to high. */
function sounding(p: Piece, t: number): number[] {
  const s = compile(p);
  return s.voices
    .map((v) => pitchAt(v, t))
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
}

const loopCard = (p: Piece, t: number): Suggestion | undefined =>
  suggestNext(p, compile(p), t).find((s) => s.kind === 'loop');

/** `p` with `m` appended at t as `id`. */
const add = (p: Piece, m: Moment, t: number, id: string): Piece => ({
  ...p,
  moments: [...p.moments, { ...m, id, at: t }],
});

describe('Next: the closed loop', () => {
  it('Am7 voiced E4 G4 A4 C5 in C major: four steps that end where they started', () => {
    let p = piece({ pool: 4, start: [64, 67, 69, 72], key: C });
    const labels: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = 6 * (i + 1);
      const card = loopCard(p, t);
      expect(card, `step ${i + 1}`).toBeDefined();
      expect(card!.best).toBe(false);
      labels.push(card!.label);
      p = add(p, card!.moment, t, `loop${i}`);
    }
    expect(labels).toEqual([
      'Down a third (loop 1/4)',
      'Down a third (loop 2/4)',
      'Upside down (loop 3/4)',
      'Up a third (loop 4/4)',
    ]);
    const fold = p.moments.find((m) => m.id === 'loop2')!;
    // About D4, a note that keeps C major; with one length, no stagger and no jitter.
    expect(fold).toMatchObject({ type: 'spread', factor: -1, around: 62, snap: 'chromatic' });
    expect(fold.glide).toMatchObject({ stagger: 0, jitter: 0 });
    expect(sounding(p, 11)).toEqual([60, 63, 65, 68]); // A♭ major's fm7: down a third
    expect(sounding(p, 17)).toEqual([56, 59, 61, 64]); // E major's c♯m7
    expect(sounding(p, 23)).toEqual([60, 63, 65, 68]); // folded: A♭ major again
    expect(sounding(p, 30)).toEqual([64, 67, 69, 72]); // home
  });

  it('is the last card, with the chord cards before it', () => {
    const p = piece({ pool: 4, start: [64, 67, 69, 72], key: C });
    const cards = suggestNext(p, compile(p), 6);
    expect(cards).toHaveLength(4);
    expect(cards.at(-1)!.kind).toBe('loop');
    expect(cards.slice(0, 3).every((c) => c.kind === 'chord')).toBe(true);
  });

  it('not where the voicing does not allow it', () => {
    // C E G: it would end on A minor (not where it started).
    expect(loopCard(piece({ pool: 3, start: [60, 64, 67], key: C }), 6)).toBeUndefined();
    // Two notes.
    expect(loopCard(piece({ pool: 2, start: [64, 69], key: C }), 6)).toBeUndefined();
    // A note outside the key.
    expect(loopCard(piece({ pool: 4, start: [64, 67, 70, 72], key: C }), 6)).toBeUndefined();
    // No room below: the planes would leave the lines' range.
    const low = piece({ pool: 4, start: [64, 67, 69, 72], key: C, range: [60, 84] });
    expect(loopCard(low, 6)).toBeUndefined();
    // A key no fold keeps.
    const hm: Key = { tonic: 'A', scale: 'harmonic-minor' };
    expect(loopCard(piece({ pool: 4, start: [64, 67, 69, 72], key: hm }), 6)).toBeUndefined();
  });

  it('a 6/9 voicing in D dorian, and the loop again once it closes', () => {
    const D: Key = { tonic: 'D', scale: 'dorian' };
    // A C D E G, symmetric about D4 (the dorian tonic): ends exactly where it started.
    let p = piece({ pool: 5, start: [57, 60, 62, 64, 67], key: D });
    for (let i = 0; i < 4; i++) {
      const card = loopCard(p, 6 * (i + 1));
      expect(card, `step ${i + 1}`).toBeDefined();
      p = add(p, card!.moment, 6 * (i + 1), `loop${i}`);
    }
    expect(sounding(p, 30)).toEqual([57, 60, 62, 64, 67]);
    expect(loopCard(p, 30)!.label).toBe('Down a third (loop 1/4)');
  });
});
