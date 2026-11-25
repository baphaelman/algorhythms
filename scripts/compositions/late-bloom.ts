// Late Bloom (2026-11-25; a gallery piece, gallery/notes/audiovisual/late-bloom.md, local only). A neo-soul groove first, then something that blooms out of it.
// D minor, 92 bpm, 4/4, sixteenths swung 60 % (a 10-per-beat grid: hits at 0, 3, 5, 8).
// The loop is Bbmaj9 | A7(b13) | Dm11 | Cm11 F9sus, the Rhodes and the bass pushing chords an
// eighth early.
// A drum kit built from custom timbres, a fingered bass, the Rhodes, a flute theme, glockenspiel
// answers. In the bloom (B) a choir opens out of one note into a wide chord over new changes
// (Gm9 C13 Fmaj9 Bbmaj9 Em7b5 A7 Dm9) while the groove keeps going. In the breakdown the choir
// folds upside down through one note (D dorian is its own mirror about D): Dm becomes G6, the kick
// lands on the crossing, and the groove drops back in.
// Form: intro 0–3, groove 4–11, theme 12–19, bloom 20–27, theme 28–35, breakdown 36–39,
// theme 40–47, outro 48–51.
import { Song } from './song';

type J = Record<string, unknown>;

const still = { rate: 5, depthCents: 0, delay: 0.5 };

const TIMBRES: Record<string, J> = {
  // Kick on A1 (55 Hz): the body, with struck partials above it that die fast (the pitch-drop
  // thump) and a short high click for the beater.
  kick: {
    harmonics: [1, 0.06],
    stretch: 0,
    strikePartials: [
      { ratio: 1.5, amp: 1.4, decay: 0.07 },
      { ratio: 2.25, amp: 0.9, decay: 0.045 },
      { ratio: 3.4, amp: 0.45, decay: 0.025 },
      { ratio: 22, amp: 0.12, decay: 0.008 },
      { ratio: 29, amp: 0.1, decay: 0.006 },
    ],
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0,
    articulation: { amount: 1, attack: 0.001, decay: 0.42, crisp: true },
    vibrato: still,
  },
  // Snare body on G3: a drum skin's inharmonic modes and a low puff of noise.
  skin: {
    harmonics: [1, 0.15],
    stretch: 0,
    strikePartials: [
      { ratio: 1.59, amp: 0.9, decay: 0.09 },
      { ratio: 2.14, amp: 0.6, decay: 0.06 },
      { ratio: 2.65, amp: 0.35, decay: 0.04 },
    ],
    noise: { level: 1.2, bandwidth: 4 },
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0,
    articulation: { amount: 1, attack: 0.001, decay: 0.2, crisp: true },
    vibrato: still,
  },
  // Snare wires: a metallic FM tone buried in a wide band of noise around 2 kHz.
  wires: {
    harmonics: [1],
    stretch: 0,
    fm: { ratio: 1.4142, index: 8, indexTrack: 0, held: 0.4 },
    noise: { level: 4, bandwidth: 2.6 },
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0,
    articulation: { amount: 1, attack: 0.001, decay: 0.26, crisp: true },
    vibrato: still,
  },
  // Closed hi-hat (the Calling Changes shaker, shorter and brighter).
  hat: {
    harmonics: [1],
    stretch: 0,
    fm: { ratio: 1.4142, index: 7, indexTrack: 0 },
    noise: { level: 3.2, bandwidth: 1.2 },
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0,
    articulation: { amount: 1, attack: 0.001, decay: 0.06, crisp: true },
    vibrato: still,
  },
  // Open hi-hat: the same metal, ringing.
  ohat: {
    harmonics: [1],
    stretch: 0,
    fm: { ratio: 1.4142, index: 7, indexTrack: 0 },
    noise: { level: 3.2, bandwidth: 1.4 },
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0,
    articulation: { amount: 1, attack: 0.001, decay: 0.45, crisp: true },
    vibrato: still,
  },
  // The kick's beater: a few ms of noise around 2.6 kHz.
  click: {
    harmonics: [1],
    stretch: 0,
    fm: { ratio: 1.4142, index: 5, indexTrack: 0 },
    noise: { level: 3, bandwidth: 1.6 },
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0,
    articulation: { amount: 1, attack: 0.001, decay: 0.018, crisp: true },
    vibrato: still,
  },
  // Fingered electric bass: round, a bright pluck that settles (FM index under the strike).
  fbass: {
    harmonics: [1, 0.55, 0.32, 0.2, 0.11, 0.07, 0.04, 0.025],
    stretch: 0,
    fm: { ratio: 1, index: 1.1, indexTrack: 0, held: 0.25 },
    noise: { level: 0.03, bandwidth: 1 },
    brightness: { tilt: -1.5, track: 0 },
    detuneSpread: 0,
    accent: 0.05,
    articulation: { amount: 0.6, attack: 0.004, decay: 0.7, crisp: true },
    vibrato: still,
  },
  // The lead: a breathy flute with a quick, crisp start so notes sit on the beat.
  fl: {
    harmonics: [1, 0.3, 0.1, 0.04, 0.015],
    stretch: 0,
    noise: { level: 0.06, bandwidth: 0.35 },
    brightness: { tilt: -1, track: 0.3 },
    detuneSpread: 0,
    accent: 0.12,
    articulation: { amount: 0.22, attack: 0.018, decay: 0.35, crisp: true },
    vibrato: { rate: 5.3, depthCents: 10, delay: 0.3, jitter: 0.5 },
    drift: { cents: 2, rate: 0.3, amp: 0.04 },
  },
  // The bloom: a held "ah" choir, steady enough to sit in tune with the keys.
  ah: {
    harmonics: Array.from({ length: 28 }, () => 1),
    stretch: 0,
    noise: { level: 0.03, bandwidth: 1.5 },
    brightness: { tilt: -4.6, track: 0 },
    detuneSpread: 5,
    accent: 0.1,
    articulation: { amount: 0.15, attack: 0.08, decay: 0.6 },
    vibrato: { rate: 5, depthCents: 9, delay: 0.4, jitter: 0.7 },
    formants: [
      { hz: 700, bw: 110, gain: 1 },
      { hz: 1150, bw: 130, gain: 0.55 },
      { hz: 2550, bw: 220, gain: 0.25 },
      { hz: 3350, bw: 300, gain: 0.12 },
    ],
    drift: { cents: 4, rate: 0.3, amp: 0.05 },
  },
  // A solo "oo" for the harmony under the last theme: soft, with a quick start.
  oo: {
    harmonics: Array.from({ length: 24 }, () => 1),
    stretch: 0,
    noise: { level: 0.03, bandwidth: 1.2 },
    brightness: { tilt: -6, track: 0 },
    detuneSpread: 0,
    accent: 0.1,
    articulation: { amount: 0.2, attack: 0.025, decay: 0.4, crisp: true },
    vibrato: { rate: 5.2, depthCents: 12, delay: 0.3, jitter: 0.6 },
    formants: [
      { hz: 330, bw: 90, gain: 1 },
      { hz: 780, bw: 110, gain: 0.4 },
      { hz: 2300, bw: 220, gain: 0.08 },
    ],
    drift: { cents: 3, rate: 0.3, amp: 0.04 },
  },
  // Glockenspiel (Calling Changes').
  glock: {
    harmonics: [1],
    stretch: 0,
    strikePartials: [
      { ratio: 2.76, amp: 0.35, decay: 0.35 },
      { ratio: 5.4, amp: 0.18, decay: 0.15 },
      { ratio: 8.93, amp: 0.08, decay: 0.08 },
    ],
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 1,
    accent: 0,
    articulation: { amount: 0.95, attack: 0.001, decay: 1.2, crisp: true },
    vibrato: still,
  },
};

type Hits = Record<number, number>;
/** [bar, 16th index, pitch, length in 16ths, legato into the next note] */
type Ev = [number, number, number, number, boolean?];

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const BPM = 92;
const SW = [0, 3, 5, 8];
const BARS = 52;

function build(): { piece: J; q: (bar: number, i?: number) => number } {
  const s = new Song('Late Bloom', 'lb', 1125, { tonic: 'D', scale: 'minor' }, BPM, 4);
  const beat = s.beat;
  /** Time of 16th `i` (swung) in bar `bar`; i may run past 15. */
  const q = (bar: number, i = 0): number => {
    const b = bar + Math.floor(i / 16);
    const j = ((i % 16) + 16) % 16;
    return r4(s.T(b) + beat * (Math.floor(j / 4) + SW[j % 4] / 10));
  };
  const [Kk, Sn, Ht, Oh, Bs, Ky, Fl, Hm, Pd, Gl] = [
    'Kick',
    'Snare',
    'Hat',
    'OpenHat',
    'Bass',
    'Keys',
    'Flute',
    'Harmony',
    'Choir',
    'Glock',
  ];
  const G = 1;
  const v = (
    part: string,
    timbre: string,
    range: [number, number],
    gain: number,
    pan: number,
    reverb: number,
    delay = 0,
  ) => s.voice({ part, timbre, range, gain: gain * G, pan, sends: { reverb, delay } });
  v(Kk, 'kick', [28, 40], 4.5, 0, 0.02);
  v(Kk, 'click', [94, 106], 1.4, 0, 0.02);
  v(Sn, 'skin', [50, 60], 2.8, 0.03, 0.16);
  v(Sn, 'wires', [90, 100], 1.7, 0.03, 0.16);
  v(Ht, 'hat', [104, 116], 1.3, 0.35, 0.06);
  v(Oh, 'ohat', [102, 114], 0.6, 0.42, 0.1);
  v(Bs, 'fbass', [26, 55], 3.0, 0, 0.03);
  for (const pan of [-0.55, -0.2, 0.2, 0.55]) v(Ky, 'epiano', [50, 80], 3.9, pan, 0.26, 0.06);
  v(Fl, 'fl', [64, 94], 3.4, 0.05, 0.34, 0.16);
  v(Hm, 'oo', [55, 84], 2.4, -0.25, 0.4, 0.1);
  for (const pan of [-0.85, -0.45, 0, 0.45, 0.85]) v(Pd, 'ah', [44, 84], 0.85, pan, 0.5, 0.05);
  v(Gl, 'glock', [76, 100], 4.1, -0.5, 0.42, 0.3);
  s.mix.reverb = { size: 0.7, decay: 2.4, damping: 0.5, preDelay: 0.02, returnLevel: 0.3 };
  // A dotted-eighth echo: on the grid, never near a sixteenth.
  s.mix.delay = { time: r4(beat * 0.75), feedback: 0.3, returnLevel: 0.18 };
  s.mix.sends = { reverb: 0.3, delay: 0 };
  s.mix.limiter = { ceilingDb: -1 };

  const lv = (at: number, part: string | string[], gain: number, over: number, label?: string) =>
    s.level(at, Array.isArray(part) ? { parts: part } : { part }, gain, over, label);
  const place = (part: string, at: number, pitches: number[], glide: J, extra: J = {}) =>
    s.m('chord', at, {
      target: { part },
      notes: { kind: 'pitches', pitches },
      assign: 'ordered',
      glide: { stagger: 0, jitter: 0, ...glide },
      ...extra,
    });
  const land = (length: number, extra: J = {}): J => ({
    length,
    stagger: 0,
    jitter: 0,
    ease: 'smootherstep',
    land: true,
    ...extra,
  });

  // --- sections ------------------------------------------------------------------------------
  const sec = (b: number): string =>
    b < 4
      ? 'intro'
      : b < 12
        ? 'A'
        : b < 20
          ? 'A1'
          : b < 28
            ? 'B'
            : b < 36
              ? 'A2'
              : b < 40
                ? 'brk'
                : b < 48
                  ? 'A3'
                  : 'out';
  const FILL = new Set([11, 19, 27, 35, 47]);

  // --- harmony -------------------------------------------------------------------------------
  // Rhodes (4 voices, voice-led by hand) and choir (5 voices) voicings.
  // prettier-ignore
  const KEYS: Record<string, number[]> = {
    Bb: [57, 60, 62, 65], A7: [55, 59, 61, 65], Dm9: [55, 57, 60, 65], Cm9: [55, 58, 63, 65], F13: [55, 58, 63, 65],
    Gm9: [58, 62, 65, 69], C13: [58, 62, 64, 69], Fmaj9: [57, 60, 64, 67], Em7b5: [55, 58, 62, 64],
    G6: [55, 59, 62, 64], A7sus: [55, 59, 62, 64],
  };
  // prettier-ignore
  const PAD: Record<string, number[]> = {
    Bb: [50, 57, 60, 65, 69], A7: [49, 55, 59, 65, 67], Dm9: [50, 57, 60, 65, 69], Cm9: [48, 55, 58, 63, 67], F13: [48, 55, 58, 63, 67],
    // The bloom's wider voicings.
    Gm9: [55, 62, 65, 69, 74], C13: [58, 64, 67, 69, 74], Fmaj9: [57, 64, 67, 72, 76], BbB: [57, 62, 65, 72, 77],
    Em7b5: [55, 62, 64, 70, 74], A7B: [55, 61, 65, 71, 73], Dm9B: [57, 60, 65, 69, 74],
    // Breakdown: Dm/A mirrored about D4 is G6 (G B D E G).
    Dm9k: [57, 60, 62, 65, 69], A7sus: [55, 59, 62, 64, 69], A7k: [55, 59, 61, 65, 67],
    End: [50, 57, 65, 69, 76],
  };
  /** Chord changes: [bar, 16th, keys chord, choir chord]. */
  const CH: [number, number, string, string][] = [];
  for (let b = 0; b < 50; b++) {
    const k = sec(b);
    if (k === 'B' || k === 'brk') continue;
    const r = b % 4;
    if (b === 0) CH.push([0, 0, 'Bb', 'Bb']);
    if (r === 0) CH.push([b, 14, 'A7', 'A7']);
    if (r === 1 && b !== 49) CH.push([b + 1, 0, 'Dm9', 'Dm9']);
    if (r === 2) CH.push([b, 14, 'Cm9', 'Cm9']);
    if (r === 3) {
      CH.push([b, 8, 'F13', 'F13']);
      if (b === 19) CH.push([19, 14, 'Gm9', 'Gm9']);
      else if (b !== 35 && b !== 47) CH.push([b, 14, 'Bb', 'Bb']);
    }
  }
  CH.push(
    [20, 14, 'C13', 'C13'],
    [22, 0, 'Fmaj9', 'Fmaj9'],
    [22, 14, 'Bb', 'BbB'],
    [24, 0, 'Em7b5', 'Em7b5'],
    [24, 14, 'A7', 'A7B'],
    [26, 0, 'Dm9', 'Dm9B'],
    [27, 14, 'Bb', 'Bb'],
    [36, 0, 'Dm9', 'Dm9k'],
    [37, 8, 'G6', ''],
    [38, 0, 'G6', ''],
    [39, 0, 'A7sus', 'A7sus'],
    [39, 8, 'A7', 'A7k'],
    [39, 14, 'Bb', 'Bb'],
    [47, 14, 'Bb', 'Bb'],
    [50, 0, 'Dm9', 'End'],
  );
  CH.sort((a, b) => q(a[0], a[1]) - q(b[0], b[1]));

  // --- births: every part's lines exist from 0, silent where they come in later --------------
  place(Ky, 0, KEYS.Bb, { length: 0.01 }, { count: 4, label: 'Rhodes' });
  place(Kk, 0, [33, 100], { length: 0.01 }, { count: 2 });
  place(Sn, 0, [55, 96], { length: 0.01 }, { count: 2 });
  place(Ht, 0, [110], { length: 0.01 }, { count: 1 });
  place(Oh, 0, [108], { length: 0.01 }, { count: 1 });
  place(Bs, 0, [38], { length: 0.01 }, { count: 1 });
  place(Fl, 0, [74], { length: 0.01 }, { count: 1 });
  place(Hm, 0, [69], { length: 0.01 }, { count: 1 });
  place(Pd, 0, [65], { length: 0.01 }, { count: 1 });
  place(Gl, 0, [93], { length: 0.01 }, { count: 1 });
  lv(0, [Bs, Fl, Hm, Pd, Gl], 0, 0);
  lv(0, Ky, 0.72, 0);

  // Keys and choir follow the changes (choir only once it has bloomed).
  for (const [b, i, kc, pc] of CH) {
    const t = q(b, i);
    if (!(b === 0 && i === 0)) place(Ky, t, KEYS[kc], land(0.03));
    if (pc && b >= 20)
      place(
        Pd,
        t,
        PAD[pc],
        b >= 36 && b < 40
          ? land(0.6, { stagger: 0.12 })
          : land(0.45, { stagger: 0.1, jitter: 0.03 }),
      );
  }

  // --- drums ----------------------------------------------------------------------------------
  /** 16th hits per bar → pattern on the 10-per-beat grid. */
  const grid = (bars: Hits[]): number[] => {
    const out = new Array(bars.length * 40).fill(0);
    bars.forEach((h, k) => {
      for (const [i, a] of Object.entries(h))
        out[k * 40 + Math.floor(+i / 4) * 10 + SW[+i % 4]] = r4(a);
    });
    return out;
  };
  const scale = (h: Hits, x: number): Hits =>
    Object.fromEntries(Object.entries(h).map(([i, a]) => [i, a * x]));
  const drop = (h: Hits, ...ks: number[]): Hits =>
    Object.fromEntries(Object.entries(h).filter(([i]) => !ks.includes(+i)));
  const KA: Hits = { 0: 1, 10: 0.85 };
  const KB: Hits = { 0: 1, 6: 0.5, 10: 0.85, 13: 0.45 };
  const SA: Hits = { 4: 1, 7: 0.14, 12: 1 };
  const SB: Hits = { 4: 1, 9: 0.16, 12: 1, 15: 0.2 };
  const SF: Hits = { 4: 1, 10: 0.3, 12: 0.9, 13: 0.45, 14: 0.65, 15: 0.85 };
  const HA: Hits = {
    0: 0.8,
    2: 0.42,
    4: 0.72,
    6: 0.42,
    8: 0.8,
    10: 0.42,
    11: 0.2,
    12: 0.72,
    14: 0.42,
  };
  const HB: Hits = {
    0: 0.8,
    2: 0.42,
    3: 0.2,
    4: 0.72,
    6: 0.42,
    8: 0.8,
    10: 0.42,
    12: 0.72,
    14: 0.42,
    15: 0.26,
  };
  const HF: Hits = { 0: 0.8, 2: 0.42, 4: 0.72, 6: 0.42, 8: 0.8, 10: 0.42 };
  const openBar = (b: number) =>
    (sec(b) === 'A2' || sec(b) === 'A3' || sec(b) === 'B') && b % 2 === 1 && !FILL.has(b);
  const kick = (b: number): Hits =>
    b < 2
      ? {}
      : b === 2
        ? { 0: 0.7, 10: 0.55 }
        : b === 3
          ? { 0: 0.85, 10: 0.7, 13: 0.4 }
          : b === 36 || b === 38
            ? {}
            : b === 37
              ? { 0: 1 }
              : b === 39
                ? { 0: 0.8, 8: 0.7, 10: 0.55 }
                : b === 50
                  ? { 0: 1 }
                  : b > 50
                    ? {}
                    : b % 2 === 0
                      ? KA
                      : KB;
  const snare = (b: number): Hits =>
    b < 3
      ? {}
      : b === 3
        ? { 4: 0.45, 12: 0.7, 14: 0.4, 15: 0.6 }
        : b === 36 || b === 38
          ? { 4: 0.32, 12: 0.38 }
          : b === 37
            ? {}
            : b === 39
              ? { 4: 0.45, 8: 0.3, 10: 0.38, 11: 0.45, 12: 0.55, 13: 0.68, 14: 0.82, 15: 1 }
              : b >= 50
                ? {}
                : FILL.has(b)
                  ? SF
                  : b % 2
                    ? SB
                    : SA;
  const hat = (b: number): Hits =>
    b < 2
      ? {}
      : b === 2
        ? scale(HA, 0.55)
        : b === 3
          ? scale(HB, 0.75)
          : b === 36 || b === 38
            ? scale(HA, 0.55)
            : b === 37
              ? {}
              : b === 39
                ? scale(HF, 0.8)
                : b === 50
                  ? { 0: 0.5 }
                  : b > 50
                    ? {}
                    : FILL.has(b)
                      ? HF
                      : openBar(b)
                        ? drop(HB, 14, 15)
                        : b % 2
                          ? HB
                          : HA;
  const ohat = (b: number): Hits => (openBar(b) && b < 50 ? { 14: 0.75 } : {});
  const bars = (f: (b: number) => Hits) => Array.from({ length: BARS }, (_, b) => f(b));
  const drum = (part: string, f: (b: number) => Hits, decay: number) =>
    s.m('pulse', 0, {
      target: { part },
      until: r4(s.T(BARS)),
      step: r6(beat / 10),
      mode: 'together',
      pattern: grid(bars(f)),
      decay,
      floor: 0,
      strike: true,
    });
  drum(Kk, kick, 0.45);
  drum(Sn, snare, 0.24);
  drum(Ht, hat, 0.07);
  drum(Oh, ohat, 0.4);

  // --- Rhodes comping: one pulse; chords arrive struck, the comp re-strikes them ------------
  // prettier-ignore
  const COMP: Hits[] = [
    { 0: 0.9, 6: 0.55, 10: 0.7, 14: 0.85 },
    { 3: 0.45, 6: 0.7, 10: 0.6, 12: 0.5 },
    { 0: 0.9, 6: 0.55, 10: 0.7, 14: 0.85 },
    { 3: 0.45, 6: 0.65, 8: 0.85, 11: 0.5, 14: 0.85 },
  ];
  const comp = (b: number): Hits =>
    b === 36 || b === 38
      ? { 0: 0.85, 10: 0.45 }
      : b === 37
        ? { 8: 0.5 }
        : b === 39
          ? { 0: 0.7, 8: 0.8, 14: 0.9 }
          : b === 47
            ? drop(COMP[3])
            : b === 50
              ? { 0: 1 }
              : b > 50
                ? {}
                : COMP[b % 4];
  s.m('pulse', 0, {
    target: { part: Ky },
    until: r4(s.T(BARS)),
    step: r6(beat / 10),
    mode: 'together',
    pattern: grid(bars(comp)),
    decay: 0.5,
    floor: 0.3,
    strike: true,
  });

  // --- lines from events ------------------------------------------------------------------------
  /** One tune from events; gaps become rests; non-legato notes sound `stac` of their length. */
  const tune = (part: string, evs: Ev[], glide: J, stac = 1, label?: string): void => {
    const notes: J[] = [];
    evs.forEach((e, k) => {
      const t0 = q(e[0], e[1]);
      const tEnd = q(e[0], e[1] + e[3]);
      const next = evs[k + 1];
      const tn = next ? q(next[0], next[1]) : tEnd + beat;
      let len = e[4] || stac >= 1 ? Math.min(tEnd, tn) - t0 : Math.max(0.07, (tEnd - t0) * stac);
      if (tn - t0 - len < 0.012) len = tn - t0;
      notes.push({ pitch: e[2], len: r4(len) });
      if (tn - t0 - len > 0) notes.push({ rest: true, len: r4(tn - t0 - len) });
    });
    s.m('tune', q(evs[0][0], evs[0][1]), { target: { part }, notes, glide, strike: true, label });
  };
  /** Fades a sustained line in at each entry (50 ms) and out before each rest (≤ 0.2 s). */
  const breathe = (part: string, evs: Ev[], gain: (b: number) => number) => {
    evs.forEach((e, k) => {
      const prev = evs[k - 1];
      const next = evs[k + 1];
      const t0 = q(e[0], e[1]);
      const tEnd = q(e[0], e[1] + e[3]);
      if (!prev || q(prev[0], prev[1] + prev[3]) < t0 - 0.012) lv(t0, part, gain(e[0]), 0.05);
      if (!next || q(next[0], next[1]) > tEnd + 0.012) {
        const f = Math.min(0.2, 0.4 * (tEnd - t0));
        lv(tEnd - f, part, 0, f);
      }
    });
  };
  const at = (bar: number, list: [number, number, number, boolean?][]): Ev[] =>
    list.map(([i, p, n, l]) => [bar, i, p, n, l]);

  // --- bass -------------------------------------------------------------------------------------
  // Pushed chords are pushed in the bass too: the note an eighth early is tied over the bar line
  // (length 5 sixteenths), so the bar starts with its ghost on the "e".
  // prettier-ignore
  const LOOP: [number, number, number, boolean?][][] = [
    [[3, 34, 1], [6, 41, 2], [8, 46, 2], [10, 45, 1], [11, 41, 3], [14, 33, 5]],
    [[3, 33, 1], [6, 45, 2], [8, 43, 2], [10, 37, 2], [12, 33, 2], [14, 37, 2, true]],
    [[0, 38, 3], [3, 38, 1], [6, 45, 2], [8, 48, 2], [10, 45, 2], [12, 41, 1], [13, 40, 1], [14, 36, 5]],
    [[3, 36, 1], [6, 43, 2], [8, 41, 3], [11, 41, 1], [12, 39, 2], [14, 34, 5]],
  ];
  // prettier-ignore
  const BASS_B: [number, number, number, boolean?][][] = [
    [[3, 31, 1], [6, 38, 2], [8, 43, 2], [10, 41, 2], [12, 38, 2], [14, 36, 5]],
    [[3, 36, 1], [6, 43, 2], [8, 46, 2], [10, 43, 2], [12, 43, 2], [14, 40, 2, true]],
    [[0, 41, 3], [3, 41, 1], [6, 36, 2], [8, 40, 2], [10, 41, 2], [12, 45, 2], [14, 34, 5]],
    [[3, 34, 1], [6, 41, 2], [8, 45, 2], [10, 46, 2], [12, 41, 2], [14, 39, 2, true]],
    [[0, 40, 3], [3, 40, 1], [6, 46, 2], [8, 43, 2], [10, 40, 2], [12, 38, 2], [14, 33, 5]],
    [[3, 33, 1], [6, 45, 2], [8, 43, 2], [10, 37, 2], [12, 33, 2], [14, 37, 2, true]],
    [[0, 38, 3], [3, 38, 1], [6, 45, 2], [8, 48, 2], [10, 45, 2], [12, 41, 2], [14, 41, 2]],
    [[0, 38, 3], [3, 38, 1], [6, 45, 2], [8, 43, 2], [10, 41, 2], [12, 38, 2], [14, 34, 5]],
  ];
  const last = (
    bar: [number, number, number, boolean?][],
    e: [number, number, number, boolean?],
  ) => [...bar.slice(0, -1), e];
  const bass: Ev[] = [];
  for (let b = 2; b < 50; b++) {
    if (sec(b) === 'B') bass.push(...at(b, BASS_B[b - 20]));
    else if (b === 36) bass.push(...at(b, [[0, 38, 8]]));
    else if (b === 37 || b === 38) continue;
    else if (b === 39)
      bass.push(
        ...at(b, [
          [8, 45, 2],
          [10, 43, 2],
          [12, 37, 2],
          [14, 34, 5],
        ]),
      );
    else if (b === 19) bass.push(...at(b, last(LOOP[3], [14, 31, 5])));
    else if (b === 35) bass.push(...at(b, last(LOOP[3], [14, 37, 2, true])));
    else if (b === 2) bass.push(...at(b, LOOP[2]));
    else if (b === 49) bass.push(...at(b, LOOP[1]));
    else bass.push(...at(b, LOOP[b % 4]));
  }
  bass.push([50, 0, 38, 32, true]);
  tune(Bs, bass, land(0.03, { ease: 'smoothstep' }), 0.82, 'Bass');
  lv(q(2) - 0.02, Bs, 1, 0.02);

  // --- the flute --------------------------------------------------------------------------------
  // prettier-ignore
  const THEME: [number, number, number][][] = [
    [[2, 74, 2], [4, 77, 3], [7, 76, 1], [8, 74, 2], [10, 72, 2], [12, 69, 4]],
    [[2, 73, 2], [4, 76, 2], [6, 77, 3], [9, 76, 1], [10, 73, 6]],
    [[2, 69, 2], [4, 72, 2], [6, 74, 2], [8, 76, 2], [10, 77, 2], [12, 76, 1], [13, 74, 3]],
    [[0, 75, 2], [2, 74, 2], [4, 72, 2], [6, 70, 2], [8, 69, 4]],
    [[2, 77, 2], [4, 81, 3], [7, 79, 1], [8, 77, 2], [10, 76, 2], [12, 74, 2], [14, 73, 2]],
    [[2, 76, 1], [3, 77, 1], [4, 76, 2], [6, 73, 2], [8, 69, 2], [10, 71, 2], [12, 73, 4]],
    [[0, 74, 6], [6, 77, 2], [8, 81, 4], [12, 79, 2], [14, 77, 2]],
    [[0, 79, 3], [3, 77, 1], [4, 75, 4], [8, 74, 2], [10, 72, 2], [12, 69, 4]],
  ];
  // prettier-ignore
  const SONG_B: [number, number, number][][] = [
    [[4, 81, 8], [12, 79, 2], [14, 76, 10]],
    [[8, 74, 4], [12, 72, 2], [14, 74, 2]],
    [[0, 79, 8], [8, 76, 4], [12, 72, 4]],
    [[0, 74, 6], [6, 72, 2], [8, 77, 4], [12, 81, 4]],
    [[0, 82, 8], [8, 79, 4], [12, 76, 4]],
    [[0, 77, 6], [6, 76, 2], [8, 73, 8]],
    [[0, 74, 4], [4, 76, 4], [8, 77, 4], [12, 81, 4]],
    [[0, 76, 10]],
  ];
  const theme = (b0: number, last?: [number, number, number][]): Ev[] =>
    THEME.flatMap((bar, k) => at(b0 + k, k === 7 && last ? last : bar));
  const flute: Ev[] = [
    ...theme(12),
    ...SONG_B.flatMap((bar, k) => at(20 + k, bar)),
    ...theme(28),
    ...theme(40, [
      [0, 79, 3],
      [3, 77, 1],
      [4, 75, 4],
      [8, 74, 8],
    ]),
    ...at(48, [
      [2, 74, 2],
      [4, 77, 3],
      [7, 76, 1],
      [8, 74, 2],
      [10, 72, 2],
      [12, 69, 4],
    ]),
    ...at(49, [
      [2, 73, 2],
      [4, 76, 2],
      [6, 77, 3],
      [9, 76, 1],
      [10, 73, 6],
    ]),
    ...at(50, [[0, 74, 32]]),
  ];
  // Contiguous notes are legato; the tune's rests are the breaths.
  flute.forEach((e, k) => {
    const n = flute[k + 1];
    if (n && Math.abs(q(n[0], n[1]) - q(e[0], e[1] + e[3])) < 0.012) e[4] = true;
  });
  tune(Fl, flute, land(0.04, { ease: 'smoothstep' }), 1, 'Theme');
  breathe(Fl, flute, (b) => (sec(b) === 'B' ? 0.82 : sec(b) === 'A3' || b >= 48 ? 0.95 : 0.88));

  // --- a sung harmony under the last theme: a third (or a sixth) below, on a chord tone ----------
  const chordAt = (t: number): string =>
    CH.reduce((c, [b, i, k]) => (q(b, i) <= t + 1e-6 ? k : c), 'Bb');
  const ROOT: Record<string, number> = {
    Bb: 10,
    A7: 9,
    Dm9: 2,
    Cm9: 0,
    F13: 5,
    Gm9: 7,
    C13: 0,
    Fmaj9: 5,
    Em7b5: 4,
    G6: 7,
    A7sus: 9,
  };
  const pcs = (c: string) => new Set([ROOT[c], ...KEYS[c].map((p) => p % 12)]);
  let prevH = 69;
  const harm: Ev[] = flute
    .filter(([b]) => b >= 40)
    .map(([b, i, p, n, l]) => {
      if (n > 1) {
        const ok = pcs(chordAt(q(b, i)));
        let best = Infinity;
        for (const d of [3, 4, 8, 9, 5]) {
          const h = p - d;
          if (!ok.has(((h % 12) + 12) % 12)) continue;
          const cost = Math.abs(h - prevH) + (d >= 8 ? 2 : 0) + (d === 5 ? 6 : 0);
          if (cost < best) [best, prevH] = [cost, h];
        }
      }
      return [b, i, prevH, n, l];
    });
  tune(Hm, harm, land(0.04, { ease: 'smoothstep' }), 1, 'Harmony');
  breathe(Hm, harm, () => 0.7);

  // --- the glockenspiel: answers at phrase ends, colours in the bloom ---------------------------
  const glock: Ev[] = [];
  const answer1 = (b: number) =>
    glock.push(
      ...at(b, [
        [10, 93, 2],
        [12, 89, 2],
        [14, 86, 6],
      ]),
    );
  const answer2 = (b: number) =>
    glock.push(
      ...at(b, [
        [12, 96, 1],
        [13, 93, 1],
        [14, 89, 2],
        [16, 86, 8],
      ]),
    );
  answer1(7);
  answer2(11);
  answer1(15);
  answer2(19);
  // prettier-ignore
  glock.push(...at(20, [[14, 88, 18]]), ...at(22, [[0, 91, 14], [14, 89, 18]]), ...at(24, [[0, 94, 14], [14, 85, 18]]), ...at(26, [[0, 88, 8], [8, 93, 24]]));
  answer1(31);
  answer2(35);
  glock.push(
    ...at(38, [
      [0, 91, 4],
      [4, 88, 4],
      [8, 86, 8],
    ]),
    ...at(39, [
      [8, 85, 4],
      [12, 88, 2],
      [14, 89, 6],
    ]),
  );
  answer1(43);
  answer2(47);
  glock.push(
    ...at(50, [
      [0, 93, 4],
      [4, 88, 4],
      [8, 86, 24],
    ]),
  );
  glock.sort((a, b) => q(a[0], a[1]) - q(b[0], b[1]));
  tune(Gl, glock, land(0.01), 1, 'Glock');
  // Struck: the part comes up just before each figure and fades after its ring.
  glock.forEach((e, k) => {
    const prev = glock[k - 1];
    const t0 = q(e[0], e[1]);
    if (!prev || q(prev[0], prev[1] + prev[3]) < t0 - 0.012)
      lv(t0 - 0.03, Gl, sec(e[0]) === 'B' ? 0.75 : 0.62, 0.02);
    const n = glock[k + 1];
    const tEnd = q(e[0], e[1] + e[3]);
    if (!n || q(n[0], n[1]) > tEnd + 0.012) lv(tEnd - 0.5, Gl, 0, 0.5);
  });

  // --- the choir: the bloom ---------------------------------------------------------------------
  // One "ah" on F4 swells through bar 19 and opens out from the centre onto Gm9, pushed with the Rhodes.
  lv(q(19), Pd, 0.5, 4 * beat);
  place(Pd, q(19, 14), PAD.Gm9, land(2.4, { order: 'center-out' }), { count: 5, label: 'Bloom' });
  lv(q(20), Pd, 0.85, 2);
  lv(q(27, 8), Pd, 0.38, 2.5);
  // Theme again: the choir stays under it, softly, then rises for the breakdown.
  lv(q(35, 8), Pd, 0.8, 2.6);
  // The fold: every line through D4 at once (bar 37's downbeat), landing on G6 at 38.
  s.m('spread', q(38), {
    target: { part: Pd },
    factor: -1,
    around: 62,
    snap: 'none',
    glide: land(q(38) - q(36, 8)),
    label: 'Fold',
  });
  lv(q(39, 8), Pd, 0.95, 1.6);
  lv(q(40), Pd, 0.5, 1.5);
  lv(q(47, 8), Pd, 0.8, 3);

  // --- dynamics ---------------------------------------------------------------------------------
  lv(q(4) - 0.2, Ky, 0.85, 0.2);
  lv(q(12), Ky, 0.78, 1);
  lv(q(20), Ky, 0.72, 1);
  lv(q(36), Ky, 0.9, 0.3);
  lv(q(40), Ky, 0.82, 0.3);
  lv(q(50, 8), [Ky, Pd, Fl, Hm, Bs], 0, 5);

  s.end = { at: r4(q(52) + 1), fade: 3 };
  const piece = s.toJson();
  piece.meta = {
    ...(piece.meta as J),
    created: '2026-11-25T00:00:00.000Z',
    modified: '2026-11-25T00:00:00.000Z',
  };
  piece.timbres = TIMBRES;
  return { piece, q };
}

// The gallery video's palette, one colour per part (the click and the wires dimmed: they double
// the kick and the snare).
const COLOR: Record<string, string> = {
  Kick: '#9d8cff',
  Snare: '#c9c0ff',
  Hat: '#7d7898',
  OpenHat: '#a7a2c4',
  Bass: '#36c2b4',
  Keys: '#f4b25c',
  Flute: '#fff3d6',
  Harmony: '#ffb59c',
  Choir: '#ff6fa6',
  Glock: '#ffe08a',
};

export const kind = 'song';

export function lateBloom(): J {
  const { piece } = build();
  (piece.voices as J[]).forEach(
    (v, i) => (v.color = i === 1 || i === 3 ? '#4a4660' : COLOR[v.part as string]),
  );
  piece.view = { ...(piece.view as J), colors: 'custom', window: 12 };
  return piece;
}
