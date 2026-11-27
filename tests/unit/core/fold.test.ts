import { describe, expect, it } from 'vitest';
import { foldAxes, foldedKey, foldedPcs, mirrorSums } from '../../../src/core/fold';
import { mod } from '../../../src/core/math';
import { SCALE_NAMES, scalePcs } from '../../../src/core/scales';
import type { Key, PitchClass, ScaleName } from '../../../src/core/types';

const TONICS: PitchClass[] = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

/** Where the major scale's 2nd degree sits above each mode's tonic (the axis that keeps it). */
const KEEP: Partial<Record<ScaleName, number>> = {
  major: 2,
  ionian: 2,
  dorian: 0,
  phrygian: 10,
  lydian: 9,
  mixolydian: 7,
  minor: 5,
  aeolian: 5,
  locrian: 3,
};

describe('fold axes (M13 "Where a fold lands")', () => {
  it('every diatonic mode: the axis that keeps it is the 2nd degree of its major scale', () => {
    for (const [scale, deg] of Object.entries(KEEP) as [ScaleName, number][]) {
      for (const [t, tonic] of TONICS.entries()) {
        const key: Key = { tonic, scale };
        const ax = foldAxes(key, 60)!;
        expect(ax, `${tonic} ${scale}`).not.toBeNull();
        // The 2nd degree of the parent major, or a tritone from it.
        expect(mod(ax.keep - t - deg, 6), `${tonic} ${scale}`).toBe(0);
        expect(ax.lift).toBe(ax.keep + 1);
        expect(Math.abs(ax.keep - 60)).toBeLessThanOrEqual(3);
      }
    }
  });

  it('every scale: keep maps it onto itself, lift onto itself a whole step up', () => {
    for (const scale of SCALE_NAMES) {
      for (const tonic of TONICS) {
        const key: Key = { tonic, scale };
        const s = scalePcs(key);
        const ax = foldAxes(key, 64.3);
        if (!ax) {
          expect(mirrorSums(key), `${tonic} ${scale}`).toEqual([]);
          continue;
        }
        expect(foldedPcs(key, ax.keep), `${tonic} ${scale}`).toEqual(s);
        expect(foldedPcs(key, ax.lift), `${tonic} ${scale}`).toEqual(
          sorted(s.map((pc) => mod(pc + 2, 12))),
        );
        expect(foldedKey(key, ax.keep)).toEqual(key);
        expect(scalePcs(foldedKey(key, ax.lift)!)).toEqual(sorted(s.map((pc) => mod(pc + 2, 12))));
      }
    }
  });

  it('harmonic minor and blues have no axis that keeps them', () => {
    expect(foldAxes({ tonic: 'A', scale: 'harmonic-minor' }, 60)).toBeNull();
    expect(foldAxes({ tonic: 'A', scale: 'blues' }, 60)).toBeNull();
  });

  it('names the key a fold lands in (the gallery pieces)', () => {
    // Crease: D dorian about D4 keeps D dorian.
    expect(foldedKey({ tonic: 'D', scale: 'dorian' }, 62)).toEqual({ tonic: 'D', scale: 'dorian' });
    // Calling Changes: D major about F4 is E major.
    expect(foldedKey({ tonic: 'D', scale: 'major' }, 65)).toEqual({ tonic: 'E', scale: 'major' });
    // Night Sleeper: G lydian about F♯4 is B lydian.
    expect(foldedKey({ tonic: 'G', scale: 'lydian' }, 66)).toEqual({ tonic: 'B', scale: 'lydian' });
    // C major: keep about D, lift about D♯ (D major); about C it is A♭ major.
    expect(foldAxes({ tonic: 'C', scale: 'major' }, 61)).toEqual({ keep: 62, lift: 63 });
    expect(foldedKey({ tonic: 'C', scale: 'major' }, 60)).toEqual({ tonic: 'Ab', scale: 'major' });
    // Off the semitone grid: no key.
    expect(foldedKey({ tonic: 'C', scale: 'major' }, 60.25)).toBeNull();
    // A scale that doesn't mirror lands in another built-in scale, or none.
    const hm = foldedKey({ tonic: 'A', scale: 'harmonic-minor' }, 69);
    expect(hm).toBeNull();
  });
});
