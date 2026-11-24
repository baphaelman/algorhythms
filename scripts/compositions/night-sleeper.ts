// Night Sleeper: the dream from a gallery song (Sleeper Car), grown into a whole piece by the
// experimental composer (2026-11-23; gallery/notes/experiments/night-sleeper.md, local only). No song: the harmony is made of chord moves. One hummed note blooms into an
// E♭ lydian chord, opens wide, sinks by major thirds (E♭, B, G) with every interval kept, folds
// upside down through a single crossing point (which lands it on B), rises a third home to E♭,
// blooms to seven lines, then folds back down to one note. A music box plays each chord one note
// at a time, an upright bass clicks the rail joints once a bar, a low bell tolls each arrival,
// and a crooned voice sings a slow tune in each key. 108 bpm, 4/4, 50 bars.
import { Song } from './song';

type J = Record<string, unknown>;
type Note = [pitch: number, beats: number];

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export function nightSleeper(): Record<string, unknown> {
  const s = new Song('Night Sleeper', 'ns', 2311, { tonic: 'Eb', scale: 'lydian' }, 108, 4);
  const [C, X, L, B, U, Tl, W] = ['Choir', 'Box', 'Voice', 'Bass', 'Upright', 'Toll', 'Whistle'];
  const voice = (
    part: string,
    timbre: string,
    range: [number, number],
    gain: number,
    pan: number,
    sends: J,
  ) => s.voice({ part, timbre, range, gain: 1.1 * gain, pan, sends });
  for (const pan of [-0.5, -0.25, 0, 0.25, 0.5, -0.65, 0.65, -0.1, 0.1])
    voice(C, 'ooh', [38, 80], 1.1, pan, { reverb: 0.55, delay: 0 });
  for (const pan of [0.35, -0.35, 0.15, -0.15, 0.55, -0.55, 0, 0.45, -0.45])
    voice(X, 'celesta', [66, 104], 2.8, pan, { reverb: 0.6, delay: 0.3 });
  voice(L, 'croon', [62, 88], 3, 0.05, { reverb: 0.45, delay: 0 });
  voice(B, 'hum', [26, 55], 2.4, 0, { reverb: 0.25, delay: 0 });
  voice(U, 'upright', [26, 48], 2, 0.1, { reverb: 0.2, delay: 0 });
  voice(Tl, 'bell', [48, 72], 2.8, -0.2, { reverb: 0.7, delay: 0 });
  for (const pan of [0.5, 0.6, 0.7, 0.8])
    voice(W, 'steam', [58, 92], 2, pan, { reverb: 0.9, delay: 0.35 });
  s.mix.reverb = { size: 0.82, decay: 4.2, damping: 0.45, preDelay: 0.025, returnLevel: 0.34 };
  s.mix.delay = { time: r4(60 / 108), feedback: 0.3, returnLevel: 0.12 };

  const T0 = (bar: number, beat = 0) => s.T(bar, beat);
  const place = (part: string, at: number, pitches: number[], glide: J, extra: J = {}) =>
    s.m('chord', at, {
      target: { part },
      notes: { kind: 'pitches', pitches },
      assign: 'ordered',
      glide: { stagger: 0, jitter: 0, ...glide },
      ...extra,
    });
  /** A glide that lands on bar b after `len` s (plus stagger): transitions sized to the gesture. */
  const land = (len: number, extra: J = {}) => ({
    length: len,
    ease: 'smootherstep',
    land: true,
    stagger: 0,
    jitter: 0,
    ...extra,
  });
  const pulse = (part: string, b0: number, b1: number, step: number, p: J, label?: string) =>
    s.m('pulse', T0(b0), {
      target: { part },
      until: r4(T0(b1)),
      step: r4(step * s.beat),
      strike: true,
      ...p,
      label,
    });
  const key = (b: number, tonic: string, label: string) =>
    s.m('key', T0(b), { key: { tonic, scale: 'lydian' }, label });
  const plane = (b: number, by: number, len: number, label: string) =>
    s.m('shift', T0(b), {
      target: { parts: [C, X, B, U] },
      by,
      unit: 'semitones',
      glide: land(len),
      label,
    });
  // Each part's entry and exit fades (every level change here ramps; nothing steps).
  const lv = (at: number, part: string | string[], gain: number, over: number, label?: string) =>
    s.level(at, Array.isArray(part) ? { parts: part } : { part }, gain, over, label);

  // --- 1. Breath (bars 0–8): one hummed note, the rail joints, then the bloom --------------------
  place(C, 0, [63], { length: 0.01 }, { count: 1, label: 'One note' });
  s.m('chord', 0, {
    target: { parts: [B, U] },
    notes: { kind: 'pitches', pitches: [39, 39] },
    assign: 'ordered',
    glide: { length: 0.01, stagger: 0, jitter: 0 },
    count: 2,
  });

  place(X, 0, [87], { length: 0.01 }, { count: 1 });
  place(L, 0, [79], { length: 0.01 }, { count: 1 });
  place(Tl, 0, [63], { length: 0.01 }, { count: 1 });
  // The whistle's chime is G A C G (lydian; no B♭ against the choir's A, no D against the box's E♭),
  // a semitone sharp.
  place(W, 0, [68, 70, 73, 80], { length: 0.01 }, { count: 4 });
  lv(0.001, [C, X, L, B, U, Tl, W], 0, 0);
  lv(0.01, C, 0.3, 4, 'Breath');
  lv(T0(1), U, 2.2, 2);
  lv(T0(2), B, 0.5, 4);
  // The music box pings the note, then opens with the chord.
  lv(T0(2), X, 0.8, 0.02);
  pulse(X, 2, 4, 1, {
    mode: 'together',
    pattern: [1, 0, 0, 0.55, 0, 0, 0.7, 0],
    decay: 1.8,
    floor: 0.04,
  });
  // Bloom: 1 → 3 → 5 lines, each new line branching off its neighbour.
  place(C, T0(3), [55, 63, 67], land(3.2, { stagger: 0.6, order: 'center-out' }), {
    count: 3,
    label: 'Bloom',
  });
  place(C, T0(6), [55, 58, 62, 67, 70], land(3.6, { stagger: 0.8, order: 'center-out' }), {
    count: 5,
  });
  place(X, T0(4), [79, 87, 91], land(0.01), { count: 3 });
  pulse(X, 4, 6, 0.5, {
    mode: 'order',
    order: [1, 2, 3, 2],
    pattern: [1, 0.55, 0.75, 0.55],
    decay: 1.4,
    floor: 0.04,
    restart: r4(T0(1)),
  });
  place(X, T0(6), [79, 86, 91, 93, 98], land(0.01), { count: 5 });
  // The music box's arpeggio: up and down the chord in eighths, restarting each bar.
  const box = {
    mode: 'order',
    order: [1, 2, 3, 4, 5, 4, 3, 2],
    pattern: [1, 0.5, 0.7, 0.55, 0.9, 0.5, 0.7, 0.55],
    decay: 1.4,
    floor: 0.04,
    restart: r4(T0(1)),
  };
  pulse(X, 6, 22, 0.5, box, 'Music box');
  // Rail joints: "da-DUM" once a bar on the triplet grid, all the way to the slowing at the end.
  const rails = {
    mode: 'together',
    pattern: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.55],
    decay: 1,
    floor: 0.04,
  };
  pulse(U, 1, 38, 1 / 3, rails, 'Rail joints');

  // --- 2. Wide (bars 8–14): the chord yawns open; the voice's first tune -------------------------
  s.m('spread', T0(7), {
    target: { part: C },
    factor: 1.5,
    around: 'median',
    snap: 'scale',
    glide: { length: 5, stagger: 1.2, jitter: 0, order: 'center-out', ease: 'smootherstep' },
    label: 'Wider',
  });

  // --- 3. Sinking (bars 14–24): planes down a major third, twice --------------------------------
  plane(15, -4, 3.2, 'Down a third');
  key(15, 'B', 'B lydian');
  plane(21, -4, 3.2, 'Down a third');
  key(21, 'G', 'G lydian');
  // The music box winds down before the fold.
  lv(T0(22), X, 0, 1.6);

  // --- 4. The fold (bars 24–26): upside down, every line through one point ----------------------
  // The choir mirrors about its middle line (G lydian's major seventh, F♯): with no stagger and
  // one glide length, every line reaches the middle line at the same instant and they all cross
  // there. G lydian folded about its seventh is B lydian, open (no third). The bass and the
  // upright climb from G to B underneath.
  s.m('spread', T0(23, 2), {
    target: { part: C },
    factor: -1,
    around: 'median',
    snap: 'none',
    glide: { length: 4.4, stagger: 0, jitter: 0, ease: 'smootherstep' },
    label: 'Upside down',
  });
  key(25, 'B', 'B lydian');
  place(B, T0(25), [35], land(4.4));
  place(U, T0(25), [35], land(4.4));
  // The music box comes back on the new chord, two octaves up.
  // (B C♯ E♯ B C♯: no F♯ near the choir's E♯.)
  place(X, T0(25), [83, 85, 89, 95, 97], land(0.01), { count: 5 });
  lv(T0(25, 2), X, 1.2, 1.5);
  pulse(X, 25, 31, 0.5, box);

  // --- 5. Home (bars 30–38): up a third to E♭, the whistle passes, seven lines ------------------
  plane(31, 4, 3, 'Up a third, home');
  key(31, 'Eb', 'E♭ lydian');
  // The whistle approaches a semitone sharp and lands on E♭6 with everyone else (a Doppler fall).
  lv(T0(29, 3), W, 0.45, 2);
  s.m('shift', T0(31), { target: { part: W }, by: -1, unit: 'semitones', glide: land(3) });
  lv(T0(31), W, 0, 5);
  // Bloom to seven: E♭maj7♯11 in full, in the choir and the music box.
  place(C, T0(33), [51, 55, 58, 62, 67, 69, 74], land(3, { stagger: 0.6, order: 'center-out' }), {
    count: 7,
    label: 'Seven',
  });
  place(X, T0(33), [74, 79, 81, 86, 91, 93, 98], land(1.2, { stagger: 0.3, order: 'center-out' }), {
    count: 7,
  });
  // The box quickens: triplets, up the seven and back.
  pulse(
    X,
    33,
    38,
    1 / 3,
    {
      ...box,
      order: [1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2],
      pattern: [1, 0.45, 0.6, 0.5, 0.65, 0.5, 0.85, 0.5, 0.6, 0.5, 0.65, 0.5],
    },
    'Triplets',
  );

  // --- 6. Folding to sleep (bars 38–50): 7 → 5 → 3 → 1, everything slowing -----------------------
  place(C, T0(39), [51, 58, 62, 67, 74], land(4.2, { stagger: 0.8, order: 'outside-in' }), {
    count: 5,
    label: 'Fewer',
  });
  place(X, T0(39), [79, 86, 91, 93, 98], land(2, { stagger: 0.4, order: 'outside-in' }), {
    count: 5,
  });
  pulse(X, 38, 42, 0.5, box);
  place(C, T0(42), [55, 62, 70], land(4.2, { stagger: 0.8, order: 'outside-in' }), { count: 3 });
  place(X, T0(42), [86, 91, 98], land(2, { stagger: 0.4, order: 'outside-in' }), { count: 3 });
  pulse(X, 42, 45, 1, { ...box, order: [1, 2, 3, 2], pattern: [1, 0.6, 0.8, 0.6], decay: 2 });
  place(C, T0(46), [63], land(6, { stagger: 1, order: 'outside-in' }), {
    count: 1,
    label: 'One note',
  });
  place(X, T0(46), [87], land(2.5, { stagger: 0.5, order: 'outside-in' }), { count: 1 });
  pulse(X, 45, 48, 2, { mode: 'together', pattern: [1, 0.7], decay: 2.5, floor: 0.04 });
  // The rail joints slow: every second bar, then once more, then stop.
  pulse(
    U,
    38,
    46,
    1 / 3,
    { ...rails, pattern: [...rails.pattern, ...Array(12).fill(0)] },
    'Slowing',
  );
  pulse(U, 46, 48, 1 / 3, { ...rails, pattern: [1, ...Array(23).fill(0)], decay: 3 });

  // --- The voice: a slow tune in each key, phrases breathing in and out ---------------------------
  const croon = { length: 0.045, stagger: 0, jitter: 0, ease: 'smoothstep', land: true };
  const sing = (b: number, notes: Note[], gain: number, label?: string) => {
    let t = T0(b);
    s.m('tune', t, {
      target: { part: L },
      notes: notes.map(([pitch, n]) => ({ pitch, len: r4(n * s.beat) })),
      glide: croon,
      label,
    });
    lv(t, L, gain, 0.08);
    for (const [, n] of notes) t += n * s.beat;
    lv(t - 0.35, L, 0, 0.35);
  };
  // The tune keeps off the root and the fifth while the chords hold the major seventh and the ♯11
  // (a semitone below each), singing the third, ♯11, sixth, ninth and seventh instead.
  // E♭ lydian: G A G F | D C D | F A G.
  sing(
    8,
    [
      [79, 3],
      [81, 1],
      [79, 2],
      [77, 2],
      [74, 2],
      [72, 2],
      [74, 4],
      [77, 1],
      [81, 1],
      [79, 4],
    ],
    0.8,
    'Voice',
  );
  // B lydian: D♯ E♯ D♯ | C♯ D♯ A♯.
  sing(
    16,
    [
      [75, 3],
      [77, 1],
      [75, 4],
      [73, 2],
      [75, 2],
      [70, 3],
    ],
    0.8,
  );
  // B, open: D♯ G♯ C♯ | G♯ D♯.
  sing(
    26,
    [
      [75, 2],
      [80, 2],
      [85, 4],
      [80, 4],
      [75, 3],
    ],
    0.85,
  );
  // Home, at the top: A C D | C A G | F D F | G.
  sing(
    33,
    [
      [81, 2],
      [84, 2],
      [86, 4],
      [84, 2],
      [81, 2],
      [79, 4],
      [77, 3],
      [74, 1],
      [77, 4],
      [79, 8],
    ],
    0.95,
  );
  // Falling asleep: G, F, G, and E♭ only when the choir arrives on it.
  sing(
    42,
    [
      [79, 6],
      [77, 2],
      [79, 8],
      [75, 10],
    ],
    0.75,
  );

  // --- The toll: a low bell on each arrival --------------------------------------------------------
  const toll = (b: number, pitch: number, gain = 1) => {
    s.m('tune', T0(b) - 0.001, {
      target: { part: Tl },
      notes: [{ pitch, len: r4(s.beat * 4) }],
      glide: { length: 0.01, stagger: 0, jitter: 0 },
    });
    lv(T0(b) - 0.02, Tl, gain, 0.015);
    lv(T0(b) + 1.5, Tl, 0, 4.5);
  };
  // It tolls each chord's third (the root rubs against the major seventh), and E♭ at the end.
  toll(7, 67, 0.8);
  toll(15, 63);
  toll(21, 59);
  toll(25, 63);
  toll(31, 67, 1.1);
  toll(46, 63, 0.9);

  // --- Levels and the end -----------------------------------------------------------------------
  lv(T0(4), C, 0.5, 4);
  lv(T0(6), X, 1.2, 3);
  lv(T0(15), C, 0.6, 3);
  lv(T0(23, 2), C, 0.7, 2, 'Fold');
  lv(T0(27), C, 0.6, 3);
  lv(T0(25), B, 0.6, 3);
  lv(T0(33), C, 1.05, 3, 'Seven');
  lv(T0(33), X, 1.5, 2);
  lv(T0(33), B, 0.8, 3);
  lv(T0(39), C, 0.6, 5);
  // Out: the one note fades; the whistle passes once more far off and slides flat as it goes.
  lv(T0(47), [C, B, X], 0, T0(50) - T0(47), 'Out');
  place(W, T0(46), [67, 70, 72, 75], { length: 0.01 });
  lv(T0(47, 2), W, 0.35, 2);
  s.m('shift', T0(49), {
    target: { part: W },
    by: -1,
    unit: 'semitones',
    glide: { length: 2.6, ease: 'smoothstep', stagger: 0, jitter: 0 },
  });
  lv(T0(49), W, 0, 3.6);
  s.end = { at: r4(T0(51) + 0.5), fade: 0.5 };

  const piece = s.toJson() as J;
  piece.meta = {
    ...(piece.meta as object),
    author: 'AlgoRhythms examples',
    created: '2026-11-23T00:00:00.000Z',
    modified: '2026-11-23T00:00:00.000Z',
  };
  const vowel = (f: [number, number, number][]) => f.map(([hz, bw, gain]) => ({ hz, bw, gain }));
  const flat = (n: number) => Array.from({ length: n }, () => 1);
  piece.timbres = {
    // Sleeper Car's timbres. The voice: an "aw" with a singer's ring and a late crooner's vibrato.
    croon: {
      harmonics: flat(28),
      stretch: 0,
      brightness: { tilt: -5, track: 0 },
      detuneSpread: 0,
      accent: 0.05,
      noise: { level: 0.03, bandwidth: 1.5 },
      articulation: { amount: 0.25, attack: 0.025, decay: 0.3, crisp: true },
      vibrato: { rate: 5.2, depthCents: 20, delay: 0.4, jitter: 0.45 },
      formants: vowel([
        [650, 120, 1],
        [1080, 140, 0.5],
        [2650, 240, 0.3],
        [3250, 320, 0.16],
      ]),
      drift: { cents: 3, rate: 0.35, amp: 0.05 },
    },
    // The choir on "ooh": soft attack, gentle vibrato, an ensemble's slight detune and wander.
    ooh: {
      harmonics: flat(24),
      stretch: 0,
      brightness: { tilt: -6.5, track: 0 },
      detuneSpread: 4,
      accent: 0.15,
      articulation: { amount: 0.1, attack: 0.15, decay: 0.8 },
      vibrato: { rate: 5, depthCents: 10, delay: 0.45, jitter: 0.8 },
      formants: vowel([
        [330, 90, 1],
        [780, 110, 0.4],
        [2300, 220, 0.06],
      ]),
      drift: { cents: 5, rate: 0.3, amp: 0.06 },
    },
    // A low hum: chest resonance under "mm" (a closed "oo").
    hum: {
      harmonics: flat(32),
      stretch: 0,
      brightness: { tilt: -7, track: 0 },
      detuneSpread: 0,
      accent: 0.1,
      articulation: { amount: 0.1, attack: 0.2, decay: 0.8 },
      vibrato: { rate: 4.6, depthCents: 5, delay: 0.8, jitter: 0.5 },
      formants: vowel([
        [120, 170, 0.9],
        [300, 100, 1],
        [700, 140, 0.2],
      ]),
      drift: { cents: 3, rate: 0.3, amp: 0.04 },
    },
    upright: {
      harmonics: [1, 0.6, 0.3, 0.15, 0.08, 0.04],
      stretch: 0,
      noise: { level: 0.03, bandwidth: 1 },
      brightness: { tilt: -4, track: 0 },
      detuneSpread: 0,
      accent: 0.05,
      articulation: { amount: 0.8, attack: 0.006, decay: 0.7, crisp: true },
      vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
    },
    steam: {
      harmonics: [1, 0.3, 0.12, 0.05, 0.02],
      stretch: 0,
      noise: { level: 0.45, bandwidth: 0.22 },
      brightness: { tilt: -1, track: 0 },
      detuneSpread: 9,
      accent: 0.2,
      articulation: { amount: 0.3, attack: 0.08, decay: 0.4 },
      vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
      drift: { cents: 6, rate: 0.6, amp: 0.08 },
    },
    celesta: {
      harmonics: [1, 0.06],
      stretch: 0,
      strikePartials: [
        { ratio: 4, amp: 0.3, decay: 0.3 },
        { ratio: 6.27, amp: 0.14, decay: 0.12 },
      ],
      brightness: { tilt: 0, track: 0.2 },
      detuneSpread: 1,
      accent: 0,
      articulation: { amount: 0.92, attack: 0.001, decay: 1.5, crisp: true },
      vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
    },
  };
  // In the app: one colour per part, as in the video (moonlit choir, red music box, amber voice,
  // green hum, walnut upright, brass bell, steam-white whistle).
  const col: Record<string, string> = {
    [C]: '#a5b6ff',
    [X]: '#ff6474',
    [L]: '#f7c56a',
    [B]: '#4cc29a',
    [U]: '#c4834a',
    [Tl]: '#d9a441',
    [W]: '#d4dae8',
  };
  piece.voices = (piece.voices as J[]).map((v) => ({ ...v, color: col[v.part as string] }));
  piece.view = { ...(piece.view as J), colors: 'custom', window: 24 };
  return piece;
}

/** Which examples folder build.mjs writes this piece into. */
export const kind = 'experiment' as const;
