// Crease: a piece folded from one note (experimental composer, 2026-11-23). D dorian, 3/4, 120 bpm.
// D dorian is the one mode that is its own mirror image: fold it about D and every note lands on
// another note of the mode. So the whole piece is built around one horizontal line, the crease at
// D4. The marimba unfolds below it and a choir of plucked syllables above it; they bloom, open
// wider, plane down two whole tones and back, then fold upside down through the crease (every line
// crosses there at one instant), so the marimba ends up on top and the choir underneath. Then
// everything gathers back onto D4. A low hum is the floor under it all.
import { Song } from './song';

type J = Record<string, unknown>;

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

const BPM = 120;
const AXIS = 62; // D4, the crease

export function crease(): J {
  const s = new Song('Crease', 'cr', 2311, { tonic: 'D', scale: 'dorian' }, BPM, 3);
  const [M, C, H] = ['Marimba', 'Choir', 'Hum'];
  const beat = s.beat;
  for (const pan of [-0.4, -0.13, 0.13, 0.4])
    s.voice({
      part: M,
      timbre: 'marimba',
      range: [36, 86],
      gain: 4,
      pan,
      sends: { reverb: 0.4, delay: 0 },
    });
  for (const pan of [-0.3, 0.3, 0])
    s.voice({
      part: C,
      timbre: 'dm',
      range: [40, 82],
      gain: 5.2,
      pan,
      sends: { reverb: 0.5, delay: 0 },
    });
  s.voice({
    part: H,
    timbre: 'hm',
    range: [28, 52],
    gain: 1.3,
    pan: 0,
    sends: { reverb: 0.3, delay: 0 },
  });
  s.mix.reverb = { size: 0.62, decay: 2.6, damping: 0.5, preDelay: 0.018, returnLevel: 0.3 };
  s.mix.delay = { time: r4(beat * 1.5), feedback: 0.2, returnLevel: 0 };

  const T = (bar: number, b = 0) => s.T(bar, b);
  // The arc, in dB over time: quiet at the one note, loudest through the fold and the other side.
  const arcKeys: [number, number][] = [
    [0, -5],
    [12, -3.5],
    [30, -2],
    [42, -1.5],
    [67, -0.5],
    [76.5, 1],
    [84, 1.5],
    [92, 0.5],
    [100, -2.5],
    [110, -3.5],
    [120, -5],
  ];
  const arc = (t: number) => {
    let i = 0;
    while (i < arcKeys.length - 2 && arcKeys[i + 1][0] <= t) i++;
    const [[t0, a], [t1, b]] = [arcKeys[i], arcKeys[i + 1]];
    return 10 ** ((a + (b - a) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))) / 20);
  };
  const lv = (at: number, part: string | string[], gain: number, over: number, label?: string) =>
    s.level(
      at,
      Array.isArray(part) ? { parts: part } : { part },
      gain * arc(at + over),
      over,
      label,
    );
  const place = (part: string, at: number, pitches: number[], glide: J, extra: J = {}) =>
    s.m('chord', at, {
      target: { part },
      notes: { kind: 'pitches', pitches },
      assign: 'ordered',
      glide: { stagger: 0, jitter: 0, ...glide },
      ...extra,
    });
  /** A glide that arrives on its moment's time after `len` s (plus stagger). */
  const land = (len: number, extra: J = {}): J => ({
    length: len,
    ease: 'smootherstep',
    land: true,
    stagger: 0,
    jitter: 0,
    arrive: 'together',
    ...extra,
  });
  const pulse = (part: string, t0: number, t1: number, stepBeats: number, p: J, label?: string) =>
    s.m('pulse', t0, {
      target: { part },
      until: r4(t1),
      step: r4(stepBeats * beat),
      strike: true,
      ...p,
      label,
    });
  const key = (bar: number, tonic: string, label: string) =>
    s.m('key', T(bar), { key: { tonic, scale: 'dorian' }, label });

  // --- The marimba's strikes: a roll under every glide, an arpeggio walking the lines between ---
  /** A roll: all lines struck together in sixteenths, swelling from `a` to `b`. */
  const roll = (t0: number, t1: number, a: number, b: number, label?: string) => {
    const n = Math.max(2, Math.round((t1 - t0) / (beat / 4)));
    const pat = Array.from({ length: n }, (_, i) =>
      r4((a + ((b - a) * i) / (n - 1)) * (i % 2 ? 0.72 : 1)),
    );
    pulse(M, t0, t1, 0.25, { mode: 'together', pattern: pat, decay: 0.16, floor: 0.12 }, label);
  };
  /** An arpeggio up and down the lines, restarting each bar. */
  const arp = (
    t0: number,
    t1: number,
    step: number,
    order: number[],
    pattern: number[],
    label?: string,
  ) =>
    pulse(
      M,
      t0,
      t1,
      step,
      { mode: 'order', order, pattern, decay: 0.55, floor: 0.1, restart: r4(3 * beat) },
      label,
    );
  const up6 = [1, 0.5, 0.7, 0.85, 0.6, 0.5];

  // --- The choir's syllables ---------------------------------------------------------------------
  const sing = (t0: number, t1: number, step: number, p: J, label?: string) =>
    pulse(C, t0, t1, step, { decay: 0.3, floor: 0.14, ...p }, label);

  // ===== 1. One note (bars 0–6): a marimba roll on D4, the choir answering "dm" ==================
  place(M, 0, [AXIS], { length: 0.01 }, { count: 1, label: 'One note' });
  place(C, 0, [AXIS], { length: 0.01 }, { count: 1 });
  place(H, 0, [38], { length: 0.01 }, { count: 1 });
  lv(0.001, [M, C, H], 0, 0);
  lv(0.01, M, 0.75, 4.5, 'Roll');
  roll(0, T(3), 0.35, 1);
  // The roll settles into a 6/8 swing on D (strokes on eighths 1 and 4), the choir between them.
  pulse(M, T(3), T(6), 0.5, {
    mode: 'together',
    pattern: [1, 0, 0, 0.7, 0, 0],
    decay: 0.9,
    floor: 0.1,
    restart: r4(3 * beat),
  });
  lv(T(2) - 0.02, C, 0.75, 0.04);
  sing(
    T(2),
    T(6),
    0.5,
    { mode: 'together', pattern: [0, 0, 1, 0, 0.7, 0], restart: r4(3 * beat) },
    '“dm”',
  );

  // ===== 2. Bloom (bars 6–13): one line opens to two, then to seven ==============================
  // Bloom 1: each part branches away from the crease, the marimba down to G3, the choir up to G4.
  const b1 = land(2.4, { stagger: 0.3, order: 'center-out' });
  place(M, T(8), [55, AXIS], b1, { count: 2, label: 'Bloom' });
  place(C, T(8), [AXIS, 67], b1, { count: 2 });
  roll(T(6), T(8), 0.4, 1);
  lv(T(6), C, 0.5, 0.6); // the choir hums the glide under the roll, softly
  s.m('timbre', T(6), { target: { part: C }, preset: 'ba', fade: 3, label: '“ba”' });
  lv(T(8), C, 0.85, 0.3);
  arp(T(8), T(11), 0.5, [1, 2, 1, 2, 1, 2], up6);
  sing(T(8), T(11), 0.5, { mode: 'order', order: [1, 2], pattern: [1, 0, 0.8, 0, 0.6, 0] });
  // Bloom 2: E minor seven around the crease (E3 G3 B3 D4 | E4 G4 B4).
  const b2 = land(3, { stagger: 0.6, order: 'center-out' });
  place(M, T(13), [52, 55, 59, AXIS], b2, { count: 4 });
  place(C, T(13), [64, 67, 71], b2, { count: 3 });
  roll(T(11), T(13), 0.45, 1);
  lv(T(11), C, 0.55, 0.5);
  lv(T(13), C, 0.85, 0.3);
  // The hum comes up under it, on D.
  lv(T(11), H, 0.35, 4);

  // ===== 3. Wider (bars 13–28): the chord yawns open, around the crease ==========================
  arp(T(13), T(16), 0.5, [1, 2, 3, 4, 3, 2], up6, 'Arpeggio');
  sing(T(13), T(16), 0.5, {
    mode: 'order',
    order: [1, 2, 3, 2],
    pattern: [1, 0, 0.7, 0, 0.8, 0, 0, 0.6, 0.9, 0, 0.7, 0],
    restart: r4(6 * beat),
  });
  // ×1.6 about D4, snapped to the mode: E3 G3 B3 | E4 G4 B4 → A2 D3 A3 | F4 A4 E5 (D minor, wide).
  const wide = {
    length: 4.5,
    stagger: 0.9,
    jitter: 0,
    order: 'center-out',
    ease: 'smootherstep',
    land: true,
    arrive: 'together',
  };
  for (const part of [M, C])
    s.m('spread', T(20), {
      target: { part },
      factor: 1.6,
      around: AXIS,
      snap: 'scale',
      glide: wide,
      label: part === M ? 'Wider' : undefined,
    });
  roll(T(16), T(20), 0.35, 1);
  lv(T(16), C, 0.55, 0.6);
  lv(T(20), C, 0.9, 0.3);
  arp(T(20), T(26), 0.5, [1, 2, 3, 4, 3, 2], up6);
  const turns = {
    mode: 'order',
    order: [3, 1, 2, 3, 2, 1],
    pattern: [1, 0, 0.6, 0.8, 0, 0.6, 0, 0.7, 0.9, 0, 0.6, 0],
    restart: r4(6 * beat),
  };
  sing(T(20), T(26), 0.5, turns, 'Turns');

  // ===== 4. Plane (bars 26–45): down a whole tone, again, then up a major third home ==============
  const plane = (bar: number, by: number, len: number, label: string) =>
    s.m('shift', T(bar), {
      target: { parts: [M, C, H] },
      by,
      unit: 'semitones',
      glide: land(len),
      label,
    });
  const planeSection = (
    from: number,
    to: number,
    len: number,
    by: number,
    tonic: string,
    label: string,
  ) => {
    const g0 = T(from) - len;
    // The last hold's strikes run up to the glide; a roll carries the plane, the choir sustains it.
    roll(g0, T(from), 0.5, 1);
    lv(g0, C, 0.55, 0.3);
    plane(from, by, len, label);
    key(from, tonic, `${tonic} dorian`);
    lv(T(from), C, 0.9, 0.3);
    return [T(from), T(to)];
  };
  // Holds between planes: the marimba walks, the singers take turns.
  arp(T(26), T(28) - 1.5, 0.5, [1, 2, 3, 4, 3, 2], up6);
  sing(T(26), T(28) - 1.5, 0.5, turns);
  planeSection(28, 36, 1.5, -2, 'C', 'Down a tone');
  arp(T(28), T(36) - 1.5, 0.5, [1, 3, 2, 4, 3, 2], up6);
  sing(T(28), T(36) - 1.5, 0.5, turns);
  planeSection(36, 45, 1.5, -2, 'Bb', 'Down a tone');
  arp(T(36), T(45) - 3, 0.5, [1, 3, 2, 4, 3, 2], up6);
  sing(T(36), T(45) - 3, 0.5, turns);
  planeSection(45, 51, 3, 4, 'D', 'Up a third, home');

  // ===== 5. Upside down (bars 51–55): every line through the crease at one instant =================
  // A mirror about D4 with one glide length, no stagger and no jitter: each line p goes to
  // 124 − p and passes D4 halfway, so all of them cross there together (bar 53, beat 1). D dorian
  // folds onto itself: A2 D3 A3 D4 | F4 A4 E5 becomes C3 G3 B3 | D4 G4 D5 G5. The marimba ends up
  // on top, the choir below, and the choir's "ba" closes to "dm" as it passes through.
  arp(T(45), T(51), 0.5, [1, 2, 3, 4, 3, 2], up6);
  sing(T(45), T(51), 0.5, turns);
  const fold = { length: 6, stagger: 0, jitter: 0, ease: 'smootherstep', arrive: 'together' };
  for (const part of [M, C])
    s.m('spread', T(51), {
      target: { part },
      factor: -1,
      around: AXIS,
      snap: 'none',
      glide: fold,
      label: part === M ? 'Upside down' : undefined,
    });
  // Both parts strike in sixteenths all through the fold, loudest where they meet.
  const n = 48;
  const swell = Array.from({ length: n }, (_, i) => {
    const u = i / n;
    const v = 0.35 + 0.65 * Math.max(0, 1 - Math.abs(u - 0.5) / 0.5) ** 1.5;
    return r4(0.72 * (i === n / 2 ? 1 : v * (i % 2 ? 0.75 : 1)));
  });
  pulse(
    M,
    T(51),
    T(55),
    0.25,
    { mode: 'together', pattern: swell, decay: 0.14, floor: 0.12 },
    'Fold',
  );
  pulse(C, T(51), T(55), 0.5, {
    mode: 'together',
    pattern: swell.filter((_, i) => i % 2 === 0),
    decay: 0.22,
    floor: 0.12,
  });
  lv(T(51), C, 0.7, 1);
  // The marimba follows the arc in long ramps.
  for (const [bar, over, g] of [
    [8, 4, 0.75],
    [20, 6, 0.85],
    [28, 6, 0.8],
    [45, 6, 0.8],
    [51, 4, 0.85],
    [55, 4, 0.75],
    [66, 6, 0.6],
  ] as const)
    lv(T(bar), M, g, over);
  s.m('timbre', T(52, 2), { target: { part: C }, preset: 'dm', fade: 1.5 });

  // ===== 6. The other side (bars 55–64): the marimba high, the choir a low vocal bass =============
  lv(T(55), C, 1.05, 0.4);
  pulse(
    M,
    T(55),
    T(66) - 4.1,
    0.25,
    {
      mode: 'order',
      order: [1, 2, 3, 4, 3, 2],
      pattern: [1, 0.45, 0.6, 0.75, 0.5, 0.45],
      decay: 0.4,
      floor: 0.1,
      restart: r4(1.5 * beat),
    },
    'Sixteenths',
  );
  sing(
    T(55),
    T(66) - 4.1,
    0.5,
    {
      mode: 'order',
      order: [1, 2, 1, 3],
      pattern: [1, 0, 0, 0.75, 0, 0.8, 1, 0, 0.6, 0, 0.75, 0],
      decay: 0.35,
      restart: r4(6 * beat),
    },
    '“dm” bass',
  );
  lv(T(55), H, 0.3, 2);

  // ===== 7. Gather (bars 64–78): closer to G, then every line onto D4 ==============================
  const g1 = land(3.5, { stagger: 0.6, order: 'outside-in' });
  place(M, T(66), [AXIS, 67], g1, { count: 2, label: 'Gather' });
  place(C, T(66), [55, 59], g1, { count: 2 });
  roll(T(66) - 4.1, T(66), 0.4, 0.75);
  lv(T(66) - 4.1, C, 0.6, 0.4);
  lv(T(66), C, 0.7, 0.3);
  arp(T(66), T(70), 0.5, [1, 2, 1, 2, 1, 2], [1, 0.5, 0.7, 0.6, 0.55, 0.45]);
  sing(T(66), T(70), 0.5, { mode: 'order', order: [1, 2], pattern: [1, 0, 0, 0.7, 0, 0] });
  const g2 = land(6, { stagger: 1, order: 'outside-in' });
  place(M, T(72), [AXIS], g2, { count: 1, label: 'One note' });
  place(C, T(72), [AXIS], g2, { count: 1 });
  roll(T(70), T(72), 0.35, 0.8);
  lv(T(70), C, 0.5, 0.6);
  // On D4 again: the roll from the start, thinning out; the choir's last "dm"s.
  pulse(M, T(72), T(77), 0.5, {
    mode: 'together',
    pattern: [1, 0, 0, 0.6, 0, 0],
    decay: 1,
    floor: 0.1,
    restart: r4(3 * beat),
  });
  sing(T(72), T(76), 0.5, {
    mode: 'together',
    pattern: [0, 0, 0.9, 0, 0.6, 0],
    restart: r4(3 * beat),
  });
  lv(T(72), C, 0.7, 0.3);
  lv(T(73), [M, C], 0, T(78) - T(73), 'Out');
  lv(T(72), H, 0, T(78) - T(72));
  s.end = { at: r4(T(78) + 0.5), fade: 0.5 };

  const piece = s.toJson();
  piece.meta = {
    ...(piece.meta as object),
    author: 'AlgoRhythms gallery',
    created: '2026-11-23T00:00:00.000Z',
    modified: '2026-11-23T00:00:00.000Z',
  };
  const vowel = (f: [number, number, number][]) => f.map(([hz, bw, gain]) => ({ hz, bw, gain }));
  const flat = (k: number) => Array.from({ length: k }, () => 1);
  piece.timbres = {
    // An open "ba": the vowel /a/ with a quick, crisp onset and a short ring, a little breath.
    ba: {
      harmonics: flat(28),
      stretch: 0,
      noise: { level: 0.06, bandwidth: 2 },
      brightness: { tilt: -4.5, track: 0 },
      detuneSpread: 5,
      accent: 0.1,
      articulation: { amount: 0.78, attack: 0.007, decay: 0.32, crisp: true },
      vibrato: { rate: 5.2, depthCents: 6, delay: 0.35, jitter: 0.6 },
      formants: vowel([
        [740, 100, 1],
        [1150, 120, 0.55],
        [2500, 200, 0.22],
        [3300, 280, 0.1],
      ]),
      drift: { cents: 4, rate: 0.3, amp: 0.05 },
    },
    // A closed "dm": a nasal murmur, darker and rounder, with a slightly slower bloom.
    dm: {
      harmonics: flat(24),
      stretch: 0,
      noise: { level: 0.02, bandwidth: 1.2 },
      brightness: { tilt: -6, track: 0 },
      detuneSpread: 5,
      accent: 0.1,
      articulation: { amount: 0.8, attack: 0.012, decay: 0.4, crisp: true },
      vibrato: { rate: 5, depthCents: 5, delay: 0.4, jitter: 0.6 },
      formants: vowel([
        [260, 80, 1],
        [520, 120, 0.25],
        [1050, 220, 0.12],
        [2400, 300, 0.05],
      ]),
      drift: { cents: 4, rate: 0.3, amp: 0.05 },
    },
    // The floor: a low closed-mouth hum.
    hm: {
      harmonics: flat(32),
      stretch: 0,
      brightness: { tilt: -7.5, track: 0 },
      detuneSpread: 0,
      accent: 0.05,
      articulation: { amount: 0.05, attack: 0.3, decay: 1 },
      vibrato: { rate: 4.4, depthCents: 4, delay: 0.9, jitter: 0.5 },
      formants: vowel([
        [130, 140, 0.9],
        [290, 100, 1],
        [680, 160, 0.15],
      ]),
      drift: { cents: 3, rate: 0.25, amp: 0.04 },
    },
  };
  const col: Record<string, string> = { [M]: '#b4532a', [C]: '#2f4f8f', [H]: '#8c8577' };
  piece.voices = (piece.voices as J[]).map((v) => ({ ...v, color: col[v.part as string] }));
  piece.view = { ...(piece.view as J), colors: 'custom', window: 20 };
  return piece;
}
