/** Chord theory for Next (PLAN.md §11.3 revision 14): `core/theory`. */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { SCALE_NAMES } from '../../../src/core/scales';
import {
  bestBetween,
  matchChord,
  moveReason,
  pickCards,
  progressionAt,
  rankNext,
  spotRanks,
  theoryOf,
  type Job,
} from '../../../src/core/theory';
import type { Key, Piece } from '../../../src/core/types';
import { progression } from './progression-fixture';

const C: Key = { tonic: 'C', scale: 'major' };
const Am: Key = { tonic: 'A', scale: 'minor' };

const best = (key: Key, symbols: string[]): string => {
  const th = theoryOf(key)!;
  const s = compile(progression(key, symbols));
  return rankNext(th, progressionAt(s, 4 * symbols.length))[0].num;
};

describe('theoryOf', () => {
  it('the third picks the family; pentatonic and blues use their parents; some have none', () => {
    const fam = (scale: string) => theoryOf({ tonic: 'D', scale } as Key)?.family ?? null;
    expect(fam('major')).toBe('major');
    expect(fam('lydian')).toBe('major');
    expect(fam('mixolydian')).toBe('major');
    expect(fam('pentatonic-major')).toBe('major');
    expect(fam('dorian')).toBe('minor');
    expect(fam('phrygian')).toBe('minor');
    expect(fam('harmonic-minor')).toBe('minor');
    expect(fam('pentatonic-minor')).toBe('minor');
    expect(fam('blues')).toBe('minor');
    expect(fam('whole-tone')).toBeNull();
    expect(fam('chromatic')).toBeNull();
    expect(fam('locrian')).toBeNull();
  });

  it('a modal key’s own colour chords take function jobs', () => {
    const job = (key: Key, num: string) => theoryOf(key)!.chords.find((c) => c.num === num)?.job;
    expect(job({ tonic: 'A', scale: 'dorian' }, 'IV')).toBe('lift');
    expect(job({ tonic: 'G', scale: 'mixolydian' }, 'bVII')).toBe('tension');
    expect(job({ tonic: 'G', scale: 'mixolydian' }, 'V/IV')).toBeUndefined();
    expect(job({ tonic: 'F', scale: 'lydian' }, 'V/V')).toBe('lift');
    expect(job({ tonic: 'E', scale: 'phrygian' }, 'bII')).toBe('tension');
    expect(job(C, 'bVII')).toBe('colour');
    expect(job(Am, 'IV')).toBe('colour');
    // Pitch classes come from the numeral parser: ♭VI in A minor is F.
    expect(theoryOf(Am)!.chords.find((c) => c.num === 'bVI')!.triad).toEqual([5, 9, 0]);
  });
});

describe('progression and ranking', () => {
  it('reads the compiled harmony as numerals, repeats collapsed', () => {
    const s = compile(progression(C, ['I', 'V', 'V', 'vi', 'IV']));
    expect(progressionAt(s, 30)).toEqual(['I', 'V', 'vi', 'IV']);
    expect(progressionAt(s, 5)).toEqual(['I', 'V']);
    // A cluster that matches nothing restarts the sequence.
    const odd = compile(
      progression(
        C,
        ['I', 'V', 'vi'],
        [
          {
            id: 'x',
            type: 'chord',
            at: 14,
            notes: { kind: 'pitches', pitches: [61, 63, 66] },
            voicing: 'close',
            assign: 'ordered',
          },
          {
            id: 'y',
            type: 'chord',
            at: 16,
            notes: { kind: 'chord', symbol: 'IV' },
            voicing: 'close',
            register: [52, 72],
            assign: 'ordered',
          },
        ],
      ),
    );
    expect(progressionAt(odd, 30)).toEqual(['IV']);
  });

  it('M10 acceptance: I–V–vi–IV → I, V → I in C major; i–♭VII–♭VI → V in A minor', () => {
    expect(best(C, ['I', 'V', 'vi', 'IV'])).toBe('I');
    expect(best(C, ['V'])).toBe('I');
    expect(best(C, ['I', 'V'])).toBe('vi'); // the pop loop continues
    expect(best(Am, ['i', 'bVII', 'bVI'])).toBe('V');
    // Same in other keys of the family.
    expect(best({ tonic: 'Eb', scale: 'major' }, ['I', 'V', 'vi', 'IV'])).toBe('I');
    expect(best({ tonic: 'D', scale: 'dorian' }, ['i', 'bVII', 'bVI'])).toBe('V');
  });

  it('a later key reads each chord in the key at its time', () => {
    // C major I–V, then G major from 8 s: D (V in G) and G (I in G) read as V, I.
    const p = progression(
      C,
      ['I', 'V', 'V', 'I'],
      [
        {
          id: 'k',
          type: 'key',
          at: 8,
          key: { tonic: 'G', scale: 'major' },
        } as Piece['moments'][number],
      ],
    );
    const s = compile(p);
    expect(progressionAt(s, 30)).toEqual(['I', 'V', 'I']);
  });

  it('never ranks the current chord; A–B–A to a non-Home chord is damped', () => {
    const th = theoryOf(C)!;
    expect(rankNext(th, ['I', 'IV']).some((r) => r.num === 'IV')).toBe(false);
    const after = (seq: string[], num: string) => rankNext(th, seq).find((r) => r.num === num)!;
    expect(after(['vi', 'IV'], 'vi').score).toBeLessThan(after(['iii', 'IV'], 'vi').score);
  });

  it('reasons are at most six words; matching wants the root and two shared tones', () => {
    for (const key of [C, Am, { tonic: 'D', scale: 'dorian' } as Key]) {
      const th = theoryOf(key)!;
      for (const a of [null, ...th.chords.map((c) => c.num)]) {
        for (const c of th.chords) {
          const r = moveReason(th, a, c.num);
          expect(r.split(/\s+/).length, r).toBeLessThanOrEqual(6);
        }
        for (const r of rankNext(th, a === null ? [] : [a]))
          expect(r.reason.split(/\s+/).length, r.reason).toBeLessThanOrEqual(6);
      }
    }
    const th = theoryOf(C)!;
    expect(matchChord(th, [7, 11, 2, 5], 7)).toBe('V');
    expect(matchChord(th, [2, 6, 9, 0], 2)).toBe('V/V');
    expect(matchChord(th, [4, 9, 0], 4)).toBe('vi'); // first inversion: root A sounds
    expect(matchChord(th, [2, 11], 2)).toBe('vii°'); // G missing: B and D only
    expect(matchChord(th, [11, 2, 7], 11)).toBe('V'); // inversion: full triad beats bass-as-root
    expect(matchChord(th, [9, 0, 5, 4], 9)).toBe('IV'); // Fmaj7/A: a whole seventh chord
    expect(matchChord(th, [9, 0, 4, 7], 9)).toBe('vi');
    expect(matchChord(th, [0, 4, 7, 10], 0)).toBe('V/IV');
    expect(matchChord(th, [0], 0)).toBeNull();
    expect(matchChord(th, [1, 3, 6], 1)).toBeNull();
  });
});

describe('cards, between, spots', () => {
  it('cards: best first, one per job, a Surprise whenever the key has one', () => {
    const jobs: Job[] = [];
    for (const name of SCALE_NAMES) {
      const th = theoryOf({ tonic: 'C', scale: name });
      if (!th) continue;
      for (const seq of [[], ['I'], ['i'], [th.chords[0].num, th.chords[3].num]]) {
        const ranked = rankNext(th, seq);
        const cards = pickCards(ranked);
        expect(cards[0]).toBe(ranked[0]);
        expect(cards.length).toBeLessThanOrEqual(4);
        expect(new Set(cards.map((c) => c.job)).size).toBe(cards.length);
        if (ranked.some((r) => r.job === 'colour'))
          expect(cards.some((c) => c.job === 'colour')).toBe(true);
        jobs.push(...cards.map((c) => c.job));
      }
    }
    expect(new Set(jobs).size).toBe(5);
  });

  it('bestBetween links two chords, neither of them', () => {
    const th = theoryOf(C)!;
    expect(bestBetween(th, 'I', 'V').num).toBe('IV');
    expect(bestBetween(th, 'ii', 'I').num).toBe('V');
    expect(bestBetween(th, 'vi', 'I').num).toBe('IV');
    expect(bestBetween(theoryOf(Am)!, 'i', 'i').num).not.toBe('i');
  });

  it('spot ranks: transitions in and out; Home first with no neighbours', () => {
    const th = theoryOf(C)!;
    const r = spotRanks(th, 'ii', 'I');
    expect(r.find((x) => x.rank === 0)!.num).toBe('V');
    expect(new Set(r.map((x) => x.rank)).size).toBe(r.length);
    expect(spotRanks(th, null, null).find((x) => x.rank === 0)!.num).toBe('I');
  });
});
