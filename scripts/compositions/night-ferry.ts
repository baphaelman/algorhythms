/**
 * Night Ferry: A minor, 6/8 (168 eighths a minute). Port of generators/ferry.py
 * (docs/composing.md §1). The arpeggio is one `together` pulse per chord voice: the bar's voice
 * order low, 3rd, 4th, top, 4th, 2nd ([0, 2, 3, 4, 3, 1]) is not a pulse mode (`updown` walks
 * 0 1 2 3 4 3 2 1 against a 6-step bar), so each voice's pattern holds its accents and rests.
 */
import { type Note, Song, start } from './song';

type Opts = { arp?: 'glass' | 'pluck'; decay?: number; strike?: boolean };

export function nightFerry(opts: Opts = {}): Record<string, unknown> {
  const s = new Song('Night Ferry', 'nf', 6868, { tonic: 'A', scale: 'minor' }, 168, 6);
  const [M, C, B] = ['Melody', 'Chords', 'Bass'];
  const L = 1.6;
  const arpTimbre = opts.arp ?? 'glass';
  const reed = { reverb: 0.5, delay: 0.22 };
  s.voice({ part: M, timbre: 'reed', range: [62, 92], gain: 1.5 * L, pan: 0, sends: reed });
  const pads = { reverb: 0.45, delay: 0.1 };
  const arp = [-0.1, -0.45, 0.45, -0.25, 0.25].map((pan) =>
    s.voice({ part: C, timbre: arpTimbre, range: [38, 78], gain: 0.8 * L, pan, sends: pads }),
  );
  const organ = { reverb: 0.2, delay: 0 };
  s.voice({ part: B, timbre: 'organ', range: [26, 48], gain: 0.7 * L, pan: 0, sends: organ });
  s.mix.delay = { time: 1.0714, feedback: 0.28, returnLevel: 0.16 };
  s.mix.reverb = { size: 0.8, decay: 4.5, damping: 0.45, preDelay: 0.02, returnLevel: 0.38 };
  s.end = { at: s.T(68), fade: 2 };
  start(s, [76, 45, 52, 57, 60, 64, 33]);
  s.lastChord.set(C, [45, 52, 57, 60, 64]);

  const part = (p: string) => ({ part: p });
  // Chord voicings and their bass roots.
  // prettier-ignore
  const [Am, F, Fm7, C_, G_, Dm7, E7s, E7, Em7, As4, A_, Aa9] = [
    [45, 52, 57, 60, 64], [41, 48, 57, 60, 65], [41, 48, 52, 57, 64], [48, 52, 55, 60, 64],
    [43, 50, 55, 59, 62], [50, 53, 57, 60, 65], [52, 57, 59, 62, 64], [52, 56, 59, 62, 64],
    [52, 55, 59, 62, 67], [45, 52, 57, 62, 64], [45, 52, 57, 61, 64], [45, 52, 59, 60, 64],
  ];
  // prettier-ignore
  const root = new Map<number[], number>([
    [Am, 33], [F, 29], [Fm7, 29], [C_, 36], [G_, 31], [Dm7, 38], [E7s, 28], [E7, 28], [Em7, 28],
    [As4, 33], [A_, 33], [Aa9, 33],
  ]);
  const verse_ch = [Am, Am, F, F, C_, C_, G_, G_, Am, Am, F, F, Dm7, E7s, E7, E7];
  const chorus_ch = [F, G_, Em7, Am, F, G_, C_, C_, Dm7, Em7, Fm7, G_, F, G_, As4, A_];
  const verse1 =
    '76:3 74:2 72:1 | 71:2 72:1 69:3 | 72:3 77:2 76:1 | 74:6 | ' +
    '72:2 74:1 76:3 | 79:3 76:3 | 74:2 72:1 71:2 72:1 | 74:6';
  const verse2 =
    '76:3 74:2 72:1 | 71:2 72:1 76:3 | 81:3 79:2 77:1 | 76:6 | ' +
    '77:3 76:2 74:1 | 76:3 81:3 | 80:6 | 76:3 80:3';
  const chorus =
    '81:6 | 79:3 81:2 79:1 | 76:3 74:2 76:1 | 72:6 | 81:3 84:3 | 83:3 79:3 | ' +
    '79:2 81:1 79:2 76:1 | 76:6 | 77:3 81:3 | 79:3 83:3 | 84:6 | 83:3 86:3 | 84:6 | ' +
    '83:3 79:3 | 81:3 74:3 | 73:6';

  // Levels: the arpeggio's sits under its pulse (accents up to 1); breathe dips the melody.
  s.level(0, part(M), 0, 0);
  s.level(0, part(B), 0, 0);
  s.level(0, part(C), 0.8, 0);
  const chordGlide = { length: 0.28, stagger: 0.06, jitter: 0.2, ease: 'smoothstep' };
  const bassGlide = { length: 0.3, ease: 'smoothstep' };
  /** One chord per bar (a change lands on the bar line) and the bass on its roots. */
  const section = (bar0: number, chords: number[][], label?: string): void => {
    s.chords(
      C,
      bar0,
      chords.map((c): [number[], number] => [c, 6]),
      chordGlide,
      label,
    );
    s.tune(
      B,
      bar0,
      chords.map((c): Note => [root.get(c)!, 6]),
      bassGlide,
      0.1,
    );
  };
  const ML = { g: 0.8 };
  const breathe = (barEnd: number): void => {
    const t = s.T(barEnd) - 0.3;
    s.level(t, part(M), ML.g * 0.4, 0.25);
    s.level(t + 0.32, part(M), ML.g, 0.1);
  };
  const lv = (bar: number, o: { mg?: number; ag?: number; bg?: number }, over = 2): void => {
    if (o.mg !== undefined) {
      ML.g = o.mg;
      s.level(s.T(bar), part(M), o.mg, over);
    }
    // The arpeggio's level scales its accents from the next hit on.
    if (o.ag !== undefined) s.level(s.T(bar), part(C), o.ag, 0.02);
    if (o.bg !== undefined) s.level(s.T(bar), part(B), o.bg, over);
  };
  const mel = (length: number) => ({ length, ease: 'smoothstep' });

  // The arpeggio, bars 0–65: per bar, voices (low → high) 0 2 3 4 3 1 with accents ACC; each hit
  // falls to 10 % (one decay for ferry.py's two stages: 38 % in 0.22 s, then 10 % over 0.9 s).
  const ORDER = [0, 2, 3, 4, 3, 1];
  const ACC = [1, 0.55, 0.7, 0.85, 0.6, 0.55];
  const strike = opts.strike ?? arpTimbre !== 'glass';
  arp.forEach((v, i) => {
    const pattern = ORDER.map((o, k) => (o === i ? ACC[k] : 0));
    const p = { pattern, decay: opts.decay ?? 1.1, floor: 0.1, mode: 'together' };
    s.pulse(
      { voices: [v] },
      0,
      66,
      1,
      strike ? p : { ...p, strike: false },
      i ? undefined : 'Arpeggio',
    );
  });

  // Intro: four bars of arpeggio alone; the bass enters.
  section(0, [Am, Am, Fm7, Fm7], 'Intro');
  lv(0, { bg: 0.45 }, 6);
  // Verse 1 (4–19)
  s.level(s.T(4) - 0.05, part(M), 0.8, 0.1);
  section(4, verse_ch, 'Verse');
  s.tune(M, 4, `${verse1} | ${verse2}`, mel(0.09), 0.04, 'Melody');
  breathe(8);
  breathe(12);
  breathe(16);
  // Chorus 1 (20–35): fuller.
  lv(20, { mg: 1.0, ag: 1.0, bg: 0.75 }, 1);
  section(20, chorus_ch, 'Chorus');
  s.tune(M, 20, chorus, mel(0.1), 0.04);
  breathe(24);
  breathe(28);
  breathe(32);
  // Verse 2 (36–43): hushed, second half only.
  lv(36, { mg: 0.7, ag: 0.7, bg: 0.5 }, 2);
  section(36, verse_ch.slice(8), 'Verse 2');
  s.tune(M, 36, verse2, mel(0.09), 0.04);
  breathe(40);
  // Chorus 2 (44–59): biggest.
  lv(44, { mg: 1.15, ag: 1.15, bg: 0.9 }, 1);
  section(44, chorus_ch, 'Chorus 2');
  s.tune(M, 44, chorus, mel(0.1), 0.04);
  breathe(48);
  breathe(52);
  breathe(56);
  // Outro (60–67): Fmaj7, then A minor add9, thinning out. (ferry.py also lowers the arpeggio
  // at bars 63–65, but after the outro's hits were written, so that never sounded.)
  lv(60, { mg: 0.85, ag: 0.8, bg: 0.6 }, 3);
  section(60, [Fm7, Fm7, Aa9, Aa9, Aa9, Aa9], 'Outro');
  s.tune(M, 60, '76:6 | 72:6 | 71:6 | 69:18', mel(0.14), 0.04);
  s.level(s.T(64), part(M), 0, 7);
  s.level(s.T(64), part(B), 0, 7);
  // The pulses end at bar 66: the arpeggio stays about where its last hits fell (0.1 · 0.8 ·
  // accent), as when it was written as levels, and fades with the rest.
  s.level(s.T(66), part(C), 0.06, 0);
  s.level(s.T(66) + 0.01, undefined, 0, 4);
  return s.toJson();
}

/** Which examples folder build.mjs writes this piece into. */
export const kind = 'song' as const;
