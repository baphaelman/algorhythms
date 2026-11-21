/** Harbour Song: D major, 72 bpm. Port of generators/harbour.py (docs/composing.md §1). */
import { Song, start } from './song';

export function harbourSong(o: { decay?: number; strike?: boolean } = {}): Record<string, unknown> {
  const s = new Song('Harbour Song', 'hs', 7272, { tonic: 'D', scale: 'major' }, 72, 4);
  const [M, C, B, S] = ['Melody', 'Chords', 'Bass', 'Sparkle'];
  const LOUD = 1.7;
  const reed = { reverb: 0.45, delay: 0.12 };
  s.voice({ part: M, timbre: 'reed', range: [60, 92], gain: 1.5 * LOUD, pan: 0.05, sends: reed });
  for (const pan of [-0.55, -0.2, 0.2, 0.55])
    s.voice({ part: C, timbre: 'glass', range: [48, 72], gain: 0.75 * LOUD, pan });
  const organ = { reverb: 0.25, delay: 0 };
  s.voice({ part: B, timbre: 'organ', range: [28, 52], gain: 0.85 * LOUD, pan: 0, sends: organ });
  const high = { reverb: 0.7, delay: 0.5 };
  for (const pan of [-0.7, 0.7])
    s.voice({ part: S, timbre: 'glass', range: [90, 98], gain: 0.55 * LOUD, pan, sends: high });
  s.mix.delay = { time: 0.625, feedback: 0.3, returnLevel: 0.2 };
  s.mix.reverb = { size: 0.8, decay: 4.2, damping: 0.45, preDelay: 0.02, returnLevel: 0.36 };
  s.end = { at: s.T(44), fade: 3 };
  start(s, [78, 54, 57, 62, 66, 38, 90, 93]);
  s.lastChord.set(C, [54, 57, 62, 66]);

  const part = (p: string) => ({ part: p });
  // harbour.py had a 0.5 s lead-in; its absolute times move 0.5 s earlier (ramps keep their ends).
  s.level(0, undefined, 0, 0);
  s.level(0, part(C), 0.45, 3.6, 'Intro');
  s.level(1.0, part(B), 0.6, 3);

  // Pad voicings, chosen for voice leading.
  // prettier-ignore
  const [D, Bm7, G7, A7s, A7, DF, Gc, Em7, Ac, Bm, Fm7, As4, GA, Dadd9, GD] = [
    [54, 57, 62, 66], [54, 57, 59, 62], [55, 59, 62, 66], [55, 57, 62, 64], [55, 57, 61, 64],
    [57, 62, 66, 69], [55, 59, 62, 67], [55, 59, 62, 64], [57, 61, 64, 69], [54, 59, 62, 66],
    [54, 57, 61, 64], [57, 62, 64, 69], [55, 59, 62, 67], [54, 57, 62, 64], [55, 59, 62, 67],
  ];
  type Seq = [number[], number][];
  // prettier-ignore
  const A_ch: Seq = [[D, 4], [Bm7, 4], [G7, 4], [A7s, 2], [A7, 2], [DF, 4], [Gc, 4], [Em7, 4], [Ac, 4]];
  // prettier-ignore
  const A2_ch: Seq = [[D, 4], [Bm7, 4], [G7, 4], [A7s, 2], [A7, 2], [DF, 4], [Gc, 4], [Em7, 2], [A7, 2], [D, 4]];
  // prettier-ignore
  const B_ch: Seq = [[Bm, 4], [Fm7, 4], [G7, 4], [DF, 4], [Em7, 4], [G7, 4], [As4, 2], [Ac, 2], [Ac, 4]];
  const bassA = '38:4 | 35:4 | 43:4 | 45:4 | 42:4 | 43:4 | 40:4 | 45:4';
  const bassA2 = '38:4 | 35:4 | 43:4 | 45:4 | 42:4 | 43:4 | 40:2 45:2 | 38:4';
  const bassB = '35:4 | 42:4 | 43:4 | 42:4 | 40:4 | 43:4 | 45:4 | 45:2 33:2';
  const melA =
    '78:2 76:1 74:1 | 81:3 78:1 | 83:2 81:1 79:1 | 76:2 78:1 76:1 | ' +
    '74:1 78:1 81:2 | 83:1.5 86:0.5 83:2 | 81:1 79:1 78:1 76:1 | 73:2 76:2';
  const melA2 =
    '78:2 76:1 74:1 | 81:3 83:1 | 86:2 83:1 81:1 | 79:2 78:1 76:1 | ' +
    '74:1 78:1 81:2 | 83:1 81:1 79:1 76:1 | 78:2 76:2 | 74:4';
  const melB =
    '86:2 85:1 83:1 | 81:3 78:1 | 79:1 81:1 83:2 | 81:4 | ' +
    '79:2 81:1 83:1 | 86:2 88:2 | 86:2 85:2 | 81:2 76:1 78:1';

  const pad = { length: 0.9, stagger: 0.25, jitter: 0.15, ease: 'smootherstep' };
  const bassGlide = { length: 0.22, ease: 'smoothstep' };
  const melGlide = { length: 0.11, ease: 'smoothstep' };
  const ML = { g: 0.7 };
  /** The singer breathes at a phrase end (at the melody level of the moment it was written). */
  const breathe = (barEnd: number): void => {
    const t = s.T(barEnd) - 0.35;
    s.level(t, part(M), ML.g * 0.45, 0.3);
    s.level(t + 0.38, part(M), ML.g, 0.12);
  };
  const mlevel = (bar: number, g: number, over = 2): void => {
    ML.g = g;
    s.level(s.T(bar), part(M), g, over);
  };
  // The pad's eighth-note pulse: accents, then a fall to floor · accent.
  const pulse = {
    pattern: [1, 0.45, 0.7, 0.45, 0.9, 0.45, 0.7, 0.5],
    decay: o.decay ?? 0.86,
    mode: 'together',
    strike: o.strike ?? false,
  };

  // Intro: two bars of D, G/D.
  s.chords(
    C,
    0,
    [
      [D, 4],
      [GD, 4],
    ],
    pad,
  );
  s.level(s.T(2) - 0.05, part(M), 0.7, 0.15);
  // A (bars 2–9), A′ (10–18)
  s.chords(C, 2, A_ch, pad, 'A');
  s.tune(B, 2, bassA, bassGlide, 0.12);
  s.tune(M, 2, melA, melGlide, 0.04, 'Melody');
  breathe(6);
  breathe(10);
  s.chords(C, 10, A2_ch, pad, "A'");
  s.tune(B, 10, bassA2, bassGlide, 0.12);
  s.tune(M, 10, melA2, melGlide, 0.04);
  breathe(14);
  breathe(18);
  s.level(s.T(10), part(C), 0.65, 6);
  mlevel(10, 0.9);
  s.level(s.T(10), part(B), 0.8, 6);
  // Bar 18: pickup into B (the bass walks down D, C♯).
  s.tune(M, 18, '74:2 78:1 81:1', melGlide, 0.04);
  s.tune(B, 18, '38:2 37:2', bassGlide, 0.12);
  // B (19–27): relative minor, the pad pulses in eighths.
  mlevel(19, 1.15, 1);
  s.level(s.T(19), part(B), 1.0, 2);
  s.chords(C, 19, B_ch, pad, 'B');
  s.tune(B, 19, bassB, bassGlide, 0.12);
  s.tune(M, 19, melB, melGlide, 0.04);
  breathe(23);
  s.level(s.T(19), part(C), 1.4, 0.015);
  s.pulse(part(C), 19, 9, 0.5, { ...pulse, floor: 0.4 }, 'Pulse');
  mlevel(24, 1.3, 4);
  // Bar 27: one bar of A7 before the return.
  s.chords(C, 27, [[A7, 4]], pad);
  s.tune(M, 27, '79:2 76:2', melGlide, 0.04);
  s.tune(B, 27, '45:2 33:2', bassGlide, 0.12);
  // A″ (28–36): full, pulsing, a little shimmer on top.
  s.chords(C, 28, A2_ch, pad, "A''");
  s.tune(B, 28, bassA2, bassGlide, 0.12);
  s.tune(M, 28, melA2, melGlide, 0.04);
  breathe(32);
  s.level(s.T(28), part(C), 1.65, 0.015);
  s.pulse(part(C), 28, 8, 0.5, { ...pulse, floor: 0.45 });
  mlevel(28, 1.35, 1);
  s.level(s.T(28), part(B), 1.2, 1);
  s.level(s.T(28), part(S), 0.7, 3);
  const walk = {
    until: s.T(36),
    target: part(S),
    grid: 0.4167,
    density: 0.3,
    steps: [-1, 1, -2, 2],
    stepGlide: 0.05,
    glide: { stagger: 0, jitter: 0 },
    label: 'Shimmer',
  };
  s.m('walk', s.T(28), walk, 'jVlpiT'); // the old id: the same steps
  s.level(s.T(35), part(S), 0, 4);
  // Coda (36–): Gmaj7, G/A, D add9, held and fading. The pad starts from where the pulse left it
  // (0.5 · 1.65 · 0.45), as when the pulse was written as levels.
  s.level(s.T(36), part(C), 0.5 * 1.65 * 0.45, 0);
  s.chords(
    C,
    36,
    [
      [G7, 8],
      [GA, 4],
      [Dadd9, 8],
    ],
    { ...pad, length: 1.4, stagger: 0.5 },
    'Coda',
  );
  s.level(s.T(36) + 0.01, part(C), 1.0, 1);
  s.tune(B, 36, '43:8 | 45:4 | 38:8', { length: 0.4, ease: 'smoothstep' }, 0.15);
  s.tune(M, 36, '83:4 | 81:2 78:2 | 76:4 | 74:8', { length: 0.18, ease: 'smoothstep' }, 0.04);
  s.level(s.T(40), part(M), 0.7, 5);
  s.level(s.T(41), undefined, 0, 9);
  return s.toJson();
}
