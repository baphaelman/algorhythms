/** Melodies that fit the chords (core/melody.ts, M10b-5). */

import { describe, expect, it } from 'vitest';
import {
  chordFrame,
  fitMelody,
  type MelodyChord,
  type MelodyInput,
} from '../../../src/core/melody';
import { mod } from '../../../src/core/math';
import { noteName, scalePcs } from '../../../src/core/scales';
import type { Key, TunePitchNote } from '../../../src/core/types';

const C: Key = { tonic: 'C', scale: 'major' };
const Am: Key = { tonic: 'A', scale: 'minor' };
const CPenta: Key = { tonic: 'C', scale: 'pentatonic-major' };
const D: Key = { tonic: 'D', scale: 'dorian' };

const BEAT = 0.75; // 80 bpm
const BAR = 4 * BEAT;

/** Chords one bar each, from triads given as pitch classes (bass first). */
const bars = (...triads: number[][]): MelodyChord[] =>
  triads.map((pcs, i) => ({ t: i * BAR, pcs, bass: pcs[0] }));

const I_vi_IV_V = bars([0, 4, 7], [9, 0, 4], [5, 9, 0], [7, 11, 2]);

const input = (extra: Partial<MelodyInput> = {}): MelodyInput => ({
  seed: 1,
  from: 0,
  to: 4 * BAR,
  chords: I_vi_IV_V,
  keys: [{ t: 0, key: C }],
  beat: BEAT,
  meter: 4,
  register: [67, 83],
  ...extra,
});

/** Onset times of each note. */
const starts = (notes: readonly TunePitchNote[], from = 0): number[] => {
  const out: number[] = [];
  let t = from;
  for (const n of notes) {
    out.push(t);
    t += n.len;
  }
  return out;
};

const chordIn = (chords: readonly MelodyChord[], t: number): MelodyChord =>
  [...chords].reverse().find((c) => c.t <= t + 1e-6) ?? chords[0];

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** Every case the property tests sweep: keys, progressions, lengths, meters. */
function cases(): { name: string; inp: MelodyInput; key: Key }[] {
  const out: { name: string; inp: MelodyInput; key: Key }[] = [];
  const progs: [Key, MelodyChord[]][] = [
    [C, I_vi_IV_V],
    [Am, bars([9, 0, 4], [7, 11, 2], [5, 9, 0], [4, 7, 11])],
    [CPenta, bars([0, 4, 7], [9, 0, 4], [0, 4, 7], [9, 0, 4])],
    [D, bars([2, 5, 9], [7, 11, 2], [2, 5, 9], [0, 4, 7])],
  ];
  for (let s = 0; s < 40; s++) {
    const [key, chords] = progs[s % progs.length];
    const meter = [4, 4, 3, 2][s % 4];
    const nBars = [2, 4, 8, 3, 1][s % 5];
    const beat = [0.75, 0.5, 0.6][s % 3];
    const bar = meter * beat;
    const cs = chords.map((c, i) => ({ ...c, t: i * bar * 2 }));
    out.push({
      name: `${key.tonic} ${String(key.scale)} seed ${s}`,
      key,
      inp: input({
        seed: s * 7919 + 3,
        chords: cs,
        keys: [{ t: 0, key }],
        beat,
        meter,
        to: nBars * bar,
        register: [62 + (s % 7), 78 + (s % 5)],
      }),
    });
  }
  return out;
}

describe('fitMelody', () => {
  it('is deterministic per seed and differs across seeds', () => {
    expect(fitMelody(input())).toEqual(fitMelody(input()));
    const seen = new Set<string>();
    for (let s = 0; s < 20; s++) seen.add(JSON.stringify(fitMelody(input({ seed: s }))));
    expect(seen.size).toBeGreaterThan(15);
  });

  it('fills [from, to) exactly; nothing outside it; inside the register', () => {
    for (const { name, inp } of cases()) {
      const from = 3.25;
      const notes = fitMelody({
        ...inp,
        from,
        to: from + inp.to,
        chords: inp.chords.map((c) => ({ ...c, t: c.t + from })),
        keys: [{ t: 0, key: inp.keys[0].key }],
      });
      const total = notes.reduce((a, n) => a + n.len, 0);
      expect(total, name).toBeCloseTo(inp.to, 6);
      for (const n of notes) {
        expect(n.len, name).toBeGreaterThan(0);
        expect(n.pitch, name).toBeGreaterThanOrEqual(inp.register[0] - 4);
        expect(n.pitch, name).toBeLessThanOrEqual(inp.register[1] + 4);
      }
    }
    expect(fitMelody(input({ to: 0 }))).toEqual([]);
  });

  it('puts chord tones on every downbeat and strong beat', () => {
    for (const { name, inp } of cases()) {
      const notes = fitMelody(inp);
      const bar = inp.meter * inp.beat;
      const S = starts(notes);
      let downbeats = 0;
      notes.forEach((n, i) => {
        const pos = S[i] / inp.beat;
        const inBar = mod(Math.round(pos), inp.meter);
        const onBeat = near(pos, Math.round(pos));
        const strong = onBeat && (inBar === 0 || (inp.meter === 4 && inBar === 2));
        if (!strong) return;
        if (inBar === 0) downbeats++;
        const chord = chordIn(inp.chords, S[i]);
        expect(chord.pcs, `${name} note ${i}`).toContain(mod(n.pitch, 12));
      });
      // Every bar has a note on its downbeat.
      expect(downbeats, name).toBe(Math.max(1, Math.floor(inp.to / bar + 1e-6)));
    }
  });

  it('uses only scale tones over diatonic chords', () => {
    for (const { name, inp, key } of cases()) {
      const scale = scalePcs(key);
      for (const n of fitMelody(inp)) expect(scale, name).toContain(mod(n.pitch, 12));
    }
  });

  it('moves mostly by steps between strong beats', () => {
    let steps = 0;
    let moves = 0;
    for (const { inp, key } of cases()) {
      const scale = scalePcs(key);
      const notes = fitMelody(inp);
      for (let i = 1; i < notes.length; i++) {
        const a = notes[i - 1].pitch;
        const b = notes[i].pitch;
        // Scale steps between the two notes.
        let k = 0;
        for (let p = Math.min(a, b) + 1; p <= Math.max(a, b); p++)
          if (scale.includes(mod(p, 12))) k++;
        moves++;
        if (k <= 1) steps++;
        expect(Math.abs(a - b)).toBeLessThanOrEqual(12);
      }
    }
    expect(steps / moves).toBeGreaterThan(0.6);
  });

  it('ends each phrase on a stable note (root, third or fifth), the last on the tonic or root', () => {
    for (const { name, inp } of cases()) {
      const notes = fitMelody(inp);
      const S = starts(notes);
      notes.forEach((n, i) => {
        const ends = i === notes.length - 1 || (n.len >= 2 * inp.beat - 1e-6 && i > 0);
        if (!ends) return;
        const c = chordIn(inp.chords, S[i]);
        if (i === notes.length - 1) {
          expect(chordFrame(c.pcs, c.bass).stable, name).toContain(mod(n.pitch, 12));
          expect(n.len, name).toBeGreaterThanOrEqual(Math.min(inp.to, 2 * inp.beat) - 1e-6);
        }
      });
    }
    let onRoot = 0;
    const all = cases();
    for (const { inp } of all) {
      const notes = fitMelody(inp);
      const S = starts(notes);
      const c = chordIn(inp.chords, S.at(-1)!);
      if (mod(notes.at(-1)!.pitch, 12) === chordFrame(c.pcs, c.bass).root) onRoot++;
    }
    expect(onRoot / all.length).toBeGreaterThan(0.5);
  });

  it('has varied rhythm: mostly quarters and eighths, a long note at phrase ends', () => {
    const notes = fitMelody(input({ to: 8 * BAR }));
    const lens = notes.map((n) => Math.round(n.len / (BEAT / 2)));
    const short = lens.filter((l) => l === 1 || l === 2).length;
    expect(short / lens.length).toBeGreaterThan(0.6);
    expect(new Set(lens).size).toBeGreaterThanOrEqual(3);
    expect(lens.at(-1)).toBeGreaterThanOrEqual(4);
  });

  it('arches over a phrase: the middle is higher than the ends', () => {
    let up = 0;
    for (let s = 0; s < 30; s++) {
      const notes = fitMelody(input({ seed: s }));
      const n = notes.length;
      const third = Math.floor(n / 3);
      const mean = (xs: TunePitchNote[]) => xs.reduce((a, x) => a + x.pitch, 0) / xs.length;
      const mid = mean(notes.slice(third, n - third));
      if (mid > mean(notes.slice(n - third)) && mid > mean(notes.slice(0, third))) up++;
      // The peak is inside the phrase.
      const top = Math.max(...notes.map((x) => x.pitch));
      expect(notes[0].pitch).toBeLessThan(top);
      expect(notes[n - 1].pitch).toBeLessThan(top);
    }
    expect(up).toBeGreaterThanOrEqual(20);
  });

  it('follows chromatic chord tones (V/V in C sounds F♯, not F)', () => {
    const chords = bars([2, 6, 9], [2, 6, 9], [7, 11, 2], [0, 4, 7]);
    for (let s = 0; s < 10; s++) {
      const notes = fitMelody(input({ seed: s, chords }));
      const S = starts(notes);
      notes.forEach((n, i) => {
        if (S[i] < 2 * BAR - 1e-6) expect(noteName(n.pitch)).not.toMatch(/^F\d/);
      });
    }
  });

  it('chordFrame finds root, third and fifth', () => {
    expect(chordFrame([0, 4, 7], 0)).toEqual({ root: 0, stable: [0, 4, 7] });
    expect(chordFrame([4, 7, 0], 4)).toEqual({ root: 0, stable: [0, 4, 7] }); // C/E
    expect(chordFrame([9, 0, 4, 7], 9).root).toBe(9); // Am7
    expect(chordFrame([11, 2, 5], 11)).toEqual({ root: 11, stable: [11, 2, 5] }); // B°
  });
});

describe('rubs against held chord tones (M13, Night Sleeper)', () => {
  const Eb: Key = { tonic: 'Eb', scale: 'lydian' };
  // E♭maj7♯11 held as E♭3 G3 D4 A4 D5: E♭ and B♭ rub a semitone (or ninth) above D and A.
  const held = [51, 55, 62, 69, 74];
  const lydian = (extra: Partial<MelodyInput>): MelodyInput =>
    input({
      chords: [{ t: 0, pcs: [3, 7, 10, 2, 9], bass: 3 }],
      keys: [{ t: 0, key: Eb }],
      register: [76, 92],
      ...extra,
    });
  /** Notes of a beat or more, and strong-beat notes, that rub. */
  const rubbing = (notes: readonly TunePitchNote[]): number =>
    notes.filter((n, i) => {
      const b = starts(notes)[i] / BEAT;
      const onStrong = Math.abs(b - Math.round(b)) < 1e-6 && Math.round(b) % 2 === 0;
      if (!(onStrong || n.len >= BEAT - 1e-6)) return false;
      return held.some((h) => mod(n.pitch - h, 12) === 1 && Math.abs(n.pitch - h) <= 13);
    }).length;

  it('without held lines, lydian melodies rub (the case being fixed)', () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) total += rubbing(fitMelody(lydian({ seed })));
    expect(total).toBeGreaterThan(10);
  });

  it('with them, no strong-beat note or long note sits a semitone above a held tone', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const notes = fitMelody(lydian({ seed, held: () => held }));
      expect(rubbing(notes), `seed ${seed}`).toBe(0);
      const pcs = scalePcs(Eb);
      for (const n of notes) expect(pcs).toContain(mod(n.pitch, 12));
    }
  });
});
