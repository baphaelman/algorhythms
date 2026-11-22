/**
 * Tune "Melody on" (owner, 2026-11-21): the menu of sounding notes (high to low, spelled, with
 * parts), Highest/Lowest of the target, the current choice, the fields a pick writes, and the
 * palette default (`line: 'high'` with more than one line).
 */

import { describe, expect, it } from 'vitest';
import { patchMoment } from '../../../src/app/editor/ops';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import {
  melodyMove,
  melodyOptions,
  melodyPatch,
  melodyVoice,
  shiftMelody,
  tuneDots,
} from '../../../src/app/editor/tune';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { Key, Moment, Piece, TuneMoment, TuneNote } from '../../../src/core/types';
import { withStart } from '../core/compiler-fixtures';

const tune = (extra: Partial<TuneMoment> = {}): TuneMoment => ({
  id: 'tun',
  type: 'tune',
  at: 4,
  notes: [
    { pitch: 62, len: 1 },
    { pitch: 65, len: 1 },
  ],
  ...extra,
});

/** A3, C4, E4 (v1–v3) from 0 in C major; `parts`: v1–v3 "Chords", the rest "Melody". */
function make(m: TuneMoment, parts = false): Piece {
  const p = newPiece({ seed: 3 });
  const q: Piece = { ...p, key: { tonic: 'C', scale: 'major' }, end: { at: 20, fade: 1 } };
  if (parts) q.voices = q.voices.map((v, i) => ({ ...v, part: i < 3 ? 'Chords' : 'Melody' }));
  q.moments = withStart(q, [57, 60, 64], [m]);
  return q;
}

const tuneOf = (p: Piece): TuneMoment => p.moments.find((m) => m.id === 'tun') as TuneMoment;
const menu = (p: Piece) => melodyOptions(p, compile(p), tuneOf(p));
/** The voice index playing the tune's first note. */
const lineOf = (p: Piece): number | undefined => tuneDots(compile(p), tuneOf(p))[0]?.voice;

describe('tune: Melody on', () => {
  it('lists the sounding notes high to low between Highest and Lowest; absent line = Lowest', () => {
    const p = make(tune());
    const { options, current } = menu(p);
    expect(options.map((o) => o.label)).toEqual(['Highest note', 'E4', 'C4', 'A3', 'Lowest note']);
    expect(current).toBe('line:low');
    // The tune's own line is listed where it was before the tune moved it.
    expect(options.find((o) => o.label === 'A3')?.value).toBe(`voice:${p.voices[0].id}`);
  });

  it('with parts: part names, "Highest/Lowest of <part>"', () => {
    const p = make(tune({ target: { part: 'Chords' } }), true);
    const { options, current } = menu(p);
    expect(options.map((o) => o.label)).toEqual([
      'Highest of Chords',
      'E4 · Chords',
      'C4 · Chords',
      'A3 · Chords',
      'Lowest of Chords',
    ]);
    expect(current).toBe('line:low');
    const high = make(tune({ target: { part: 'Chords' }, line: 'high' }), true);
    expect(menu(high).current).toBe('line:high');
  });

  it('a note writes a voice target and drops line; Highest/Lowest keep the part', () => {
    const p = make(tune({ target: { part: 'Chords' }, line: 'high' }), true);
    const m = tuneOf(p);
    const c4 = menu(p).options.find((o) => o.label.startsWith('C4'))!;
    const patch = melodyPatch(p, m, c4.choice);
    expect(patch).toEqual({ target: { voices: [p.voices[1].id] }, line: undefined });
    const q = patchMoment(p, 'tun', patch);
    expect(tuneOf(q)).not.toHaveProperty('line');
    expect(tuneOf(q).target).toEqual({ voices: [p.voices[1].id] });
    expect(menu(q).current).toBe(c4.value);
    expect(lineOf(q)).toBe(1);

    // Back to the highest of the voice's part.
    const back = patchMoment(q, 'tun', melodyPatch(q, tuneOf(q), { kind: 'line', line: 'high' }));
    expect(tuneOf(back)).toMatchObject({ target: { part: 'Chords' }, line: 'high' });
    expect(lineOf(back)).toBe(2);
    const low = patchMoment(
      back,
      'tun',
      melodyPatch(back, tuneOf(back), { kind: 'line', line: 'low' }),
    );
    expect(tuneOf(low)).not.toHaveProperty('line');
    expect(tuneOf(low).target).toEqual({ part: 'Chords' });
    expect(lineOf(low)).toBe(0);
  });

  it('without parts a picked note goes back to all notes; a silent picked voice is listed', () => {
    const p = make(tune({ target: { voices: ['v3'] } }));
    expect(melodyPatch(p, tuneOf(p), { kind: 'line', line: 'high' })).toEqual({
      target: undefined,
      line: 'high',
    });
    const silent = make(tune({ target: { voices: [p.voices[5].id] } }));
    const { options, current } = menu(silent);
    expect(current).toBe(`voice:${p.voices[5].id}`);
    expect(options.find((o) => o.value === current)?.label).toMatch(/not sounding/);
  });

  it('multi-part targets (revision 10): "of Chords, Melody", "of all but Chords"; lines in scope', () => {
    const both = make(tune({ target: { parts: ['Chords', 'Melody'] }, line: 'high' }), true);
    expect(menu(both).options[0].label).toBe('Highest of Chords, Melody');
    expect(lineOf(both)).toBe(2);
    const except = make(tune({ target: { exceptParts: ['Melody'] } }), true);
    expect(menu(except).options.at(-1)!.label).toBe('Lowest of all but Melody');
    expect(lineOf(except)).toBe(0);
    // Highest/Lowest keep a list target.
    const m = tuneOf(both);
    expect(melodyPatch(both, m, { kind: 'line', line: 'low' }).target).toEqual({
      parts: ['Chords', 'Melody'],
    });
  });

  it('a rank target: "of the target"', () => {
    const p = make(tune({ target: { rank: [0, 1] } }));
    expect(menu(p).options[0].label).toBe('Highest of the target');
  });
});

describe('tune: palette default', () => {
  it("more than one line: line 'high', notes from the top line; one line: no line", () => {
    const withTune = make(tune());
    const p: Piece = { ...withTune, moments: withTune.moments.filter((x) => x.id !== 'tun') };
    const m = defaultMoment('tune', 8, 'zzzzzz', p, compile(p));
    expect(m.line).toBe('high');
    // A random melody from the top line's note (within a 3rd of E4).
    expect(Math.abs(m.notes[0].pitch! - 64)).toBeLessThanOrEqual(4);
    const q: Piece = { ...p, moments: [...p.moments, m as Moment] };
    expect(tuneDots(compile(q), m)[0].voice).toBe(2);

    const one = newPiece({ seed: 3 });
    one.moments = withStart(one, [60], []);
    const m1 = defaultMoment('tune', 2, 'zzzzzz', one, compile(one));
    expect(m1).not.toHaveProperty('line');
    expect(Math.abs(m1.notes[0].pitch! - 60)).toBeLessThanOrEqual(4);
  });
});

describe('tune: Melody on moves the notes (owner, 2026-11-21)', () => {
  const C: Key = { tonic: 'C', scale: 'major' };
  const ns = (...p: number[]): TuneNote[] => p.map((pitch) => ({ pitch, len: 1 }));
  const pitches = (n: readonly TuneNote[]): number[] => n.map((x) => x.pitch ?? NaN);

  it('shifts by scale steps of the key', () => {
    // A3 → E4 is 4 steps: D4 F4 G4 → A4 C5 D5.
    expect(pitches(shiftMelody(ns(62, 65, 67), 57, 64, C, [38, 96]))).toEqual([69, 72, 74]);
    // C4 → E4 is 2 steps (+4 semitones): D4 B4 → F4 D5 (not F#4, D#5).
    expect(pitches(shiftMelody(ns(62, 71), 60, 64, C, [38, 96]))).toEqual([65, 74]);
    // Down: E4 → C4 is 2 steps.
    expect(pitches(shiftMelody(ns(64, 65, 71), 64, 60, C, [38, 96]))).toEqual([60, 62, 67]);
  });

  it('keeps accidentals and cents as offsets; off-key lines shift by semitones', () => {
    // F#4 (F + 1) up 2 steps → A + 1 = A#4; E4 +30¢ → G4 +30¢.
    expect(pitches(shiftMelody(ns(66, 64.3), 60, 64, C, [38, 96]))).toEqual([70, 67.3]);
    // From C#4 (off the key) to E4: +3 semitones.
    expect(pitches(shiftMelody(ns(61, 62), 61, 64, C, [38, 96]))).toEqual([64, 65]);
  });

  it('folds notes outside the range by octaves; same pitch is a no-op', () => {
    // E4 → A4 (+3 steps): E4 C5 E5 → A4 F5 A5; A5 folds down into [A3, G5].
    expect(pitches(shiftMelody(ns(64, 72, 76), 64, 69, C, [57, 79]))).toEqual([69, 77, 69]);
    // E2 → C2 (−2 steps) folds up two octaves into [D3, A#4].
    expect(pitches(shiftMelody(ns(40), 60, 57, C, [50, 70]))).toEqual([60]);
    const notes = ns(62, 65);
    expect(shiftMelody(notes, 60, 60, C, [38, 96])).toBe(notes);
  });

  it('a picked note moves the melody to its line; Highest/Lowest to theirs', () => {
    const p = make(tune()); // on A3 (lowest), notes D4 F4
    const s = compile(p);
    const m = tuneOf(p);
    const e4 = menu(p).options.find((o) => o.label === 'E4')!;
    const toE4 = melodyMove(p, s, m, e4.choice);
    expect(toE4.target).toEqual({ voices: [p.voices[2].id] });
    expect(pitches(toE4.notes!)).toEqual([69, 72]);
    expect(melodyVoice(p, m, e4.choice)).toBe(2);
    // Highest = E4 too.
    const high = melodyMove(p, s, m, { kind: 'line', line: 'high' });
    expect(high).toEqual({ target: undefined, line: 'high', notes: toE4.notes });
    expect(melodyVoice(p, m, { kind: 'line', line: 'high' })).toBe(2);
    // The same line (Lowest = A3 already): no notes in the patch.
    expect(melodyMove(p, s, m, { kind: 'line', line: 'low' })).not.toHaveProperty('notes');
    // A3 picked as a note: same line, notes unchanged.
    const a3 = menu(p).options.find((o) => o.label === 'A3')!;
    expect(melodyMove(p, s, m, a3.choice)).not.toHaveProperty('notes');
    // Applied: the compiled tune starts on the new line's pitch.
    const q = patchMoment(p, 'tun', toE4);
    expect(tuneDots(compile(q), tuneOf(q))[0]).toMatchObject({ voice: 2, pitch: 69 });
  });

  it('from the top back to the lowest', () => {
    const p = make(tune({ line: 'high', notes: ns(64, 67) })); // on E4
    const low = melodyMove(p, compile(p), tuneOf(p), { kind: 'line', line: 'low' });
    expect(low.line).toBeUndefined();
    expect(pitches(low.notes!)).toEqual([57, 60]); // E4 G4 → A3 C4
  });
});
