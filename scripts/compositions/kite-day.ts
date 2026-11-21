/** Kite Day: C major pentatonic, 100 bpm. Port of generators/kite.py (docs/composing.md §1). */
import { type Note, Song, start } from './song';

export function kiteDay(o: { decay?: number; strike?: boolean } = {}): Record<string, unknown> {
  const s = new Song('Kite Day', 'kd', 1001, { tonic: 'C', scale: 'pentatonic-major' }, 100, 4);
  const [M, C, B, S] = ['Melody', 'Chords', 'Bass', 'Sparkle'];
  const L = 1.6;
  const reed = { reverb: 0.4, delay: 0.15 };
  s.voice({ part: M, timbre: 'reed', range: [60, 80], gain: 1.45 * L, pan: -0.05, sends: reed });
  for (const pan of [-0.5, -0.15, 0.15, 0.5])
    s.voice({ part: C, timbre: 'glass', range: [46, 68], gain: 0.7 * L, pan });
  const organ = { reverb: 0.2, delay: 0 };
  s.voice({ part: B, timbre: 'organ', range: [26, 52], gain: 0.8 * L, pan: 0, sends: organ });
  const high = { reverb: 0.55, delay: 0.35 };
  for (const pan of [-0.65, 0, 0.65])
    s.voice({ part: S, timbre: 'glass', range: [81, 94], gain: 0.6 * L, pan, sends: high });
  s.mix.delay = { time: 0.45, feedback: 0.3, returnLevel: 0.18 };
  s.mix.reverb = { size: 0.7, decay: 3.2, damping: 0.45, preDelay: 0.02, returnLevel: 0.32 };
  s.end = { at: s.T(45), fade: 2 };
  start(s, [72, 52, 55, 60, 64, 36, 81, 84, 88]);
  s.lastChord.set(C, [52, 55, 60, 64]);

  const part = (p: string) => ({ part: p });
  // kite.py had a 0.3 s lead-in; its absolute times move 0.3 s earlier (ramps keep their ends).
  s.level(0, undefined, 0, 0);
  s.level(0, part(C), 0.7, 2.75, 'Intro');

  // prettier-ignore
  const [C_, GB, Am, F_, Em, G_] = [
    [52, 55, 60, 64], [50, 55, 59, 62], [52, 57, 60, 64], [53, 57, 60, 65], [52, 55, 59, 62],
    [50, 55, 59, 62],
  ];
  // Bass root and fifth per chord. G/B's bass is G, not B: in kite.py GB and G_ are the same
  // tuple, so its dict kept G_'s entry. That is the song the owner heard; kept.
  // prettier-ignore
  const BS = new Map<number[], [number, number]>([
    [C_, [36, 43]], [GB, [31, 38]], [Am, [33, 40]], [F_, [29, 36]], [Em, [28, 35]], [G_, [31, 38]],
  ]);
  const pad = { length: 0.7, stagger: 0.2, jitter: 0.15, ease: 'smootherstep' };
  const pulse = {
    pattern: [1, 0.55, 0.8, 0.55],
    decay: o.decay ?? 1.2,
    floor: 0.5,
    mode: 'together',
    strike: o.strike ?? false,
  };
  const last = { pulse: 0 };
  /** One chord per bar on its downbeat, the bass root–fifth–octave; optionally the pad pulses. */
  const bars = (bar0: number, seq: number[][], scale?: number): void => {
    s.chords(
      C,
      bar0,
      seq.map((c): [number[], number] => [c, 4]),
      pad,
    );
    const line = seq.flatMap((c): Note[] => {
      const [r, f] = BS.get(c)!;
      return [
        [r, 2],
        [f, 1],
        [r + 12, 1],
      ];
    });
    s.tune(B, bar0, line, { length: 0.16, ease: 'smoothstep' }, 0.05);
    if (scale !== undefined) {
      // The pulse's accents times the pad level (the accent scale).
      s.level(s.T(bar0), part(C), scale, 0.015);
      s.pulse(part(C), bar0, seq.length, 1, pulse);
      last.pulse = scale;
    }
  };
  const A = [C_, GB, Am, F_];
  const Bs = [F_, G_, Em, Am, F_, G_, C_, C_];
  const melB =
    '72:3 69:1 | 71:2 67:2 | 67:3 64:1 | 69:4 | 72:2 74:2 | 76:2 74:1 71:1 | 72:4 | 72:4';
  const melA =
    '76:2 74:1 72:1 | 74:3 71:1 | 72:2 69:2 | 69:2 72:2 | ' +
    '76:2 79:2 | 79:1 77:1 76:1 74:1 | 72:3 76:1 | 72:4';
  const melGlide = { length: 0.11, ease: 'smoothstep' };

  // Intro (0–3): chords only, then the bass.
  bars(0, A);
  s.level(s.T(2), part(B), 0.7, 2);
  // A ×2 (4–11): the sparkle walk comes in, like birds over a field.
  s.level(s.T(4), part(S), 0.75, 4, 'Sparkle');
  const walk = {
    until: s.T(40),
    target: part(S),
    grid: 0.3,
    density: 0.5,
    steps: [-1, 1, -2, 2],
    stepGlide: 0.06,
    glide: { stagger: 0, jitter: 0, ease: 'smoothstep' },
    label: 'Walk',
  };
  s.m('walk', s.T(4), walk, 'yofgAy'); // the old id: the same steps
  bars(4, [...A, ...A]);
  // B (12–19): the tune.
  s.level(s.T(12) - 0.05, part(M), 0.9, 0.1);
  bars(12, Bs);
  s.tune(M, 12, melB, melGlide, 0.04, 'Tune');
  s.level(s.T(12), part(B), 0.85, 2);
  // A′ (20–27): tune 2, the pad pulses on the beat.
  bars(20, [...A, ...A], 1.1);
  s.tune(M, 20, melA, melGlide, 0.04);
  s.level(s.T(20), part(S), 0.9, 2);
  // B′ (28–35): the tune again, everything up.
  s.level(s.T(28), part(M), 1.1, 2);
  s.level(s.T(28), part(B), 1, 2);
  bars(28, Bs, 1.3);
  s.tune(M, 28, melB, melGlide, 0.04);
  // Outro (36–41): C, F, C; the walk thins and stops, the tune lands. The pad starts from where
  // the pulse left it (0.55 · 1.3 · 0.5), as when the pulse was written as levels.
  s.level(s.T(36), part(C), 0.55 * last.pulse * 0.5, 0);
  bars(36, [C_, F_, C_, F_]);
  s.tune(M, 36, '76:4 | 77:4 | 76:4 | 72:8', melGlide, 0.04);
  s.level(s.T(36) + 0.01, part(C), 0.7, 2);
  const end = {
    target: part(C),
    notes: { kind: 'pitches', pitches: [48, 55, 64, 67] },
    assign: 'ordered',
    glide: { stagger: 0.5, length: 1.5 },
    label: 'End',
  };
  s.m('chord', s.T(40) - 0.3, end, 'IgzFKj'); // the old id: the same jitter
  s.tune(B, 40, '36:4', { length: 0.3, ease: 'smoothstep' }, 0.04);
  s.level(s.T(38), part(S), 0, 5);
  s.level(s.T(41), undefined, 0, 6);
  return s.toJson();
}
