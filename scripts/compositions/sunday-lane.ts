/**
 * Sunday Lane: a whistled tune. G major, 4/4, 100 bpm, 42 bars (1′43″). A custom `whistle`
 * timbre (a near-sine with narrow breath noise, scooped notes, a late vibrato) over a Travis-picked
 * guitar (one `order` pulse, one voice per string), an upright bass, a glockenspiel answering the
 * phrase ends and a glass pad from the bridge on. A second whistle harmonises the last verse.
 * Form: intro 4, A 8, A′ 8, B 8, A″ 8, outro 6. Ported from the gallery piece; its share link is
 * over 2,000 characters (owner, 2026-11-22: ship it whole).
 */
import { Song } from './song';

type Ev = [bar: number, beat: number, pitch: number, beats: number];

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export function sundayLane(): Record<string, unknown> {
  const s = new Song('Sunday Lane', 'sl', 1122, { tonic: 'G', scale: 'major' }, 100, 4);
  const [W, W2, G, B, K, P] = ['Whistle', 'Whistle 2', 'Guitar', 'Bass', 'Glock', 'Pad'];
  s.voice({
    part: W,
    timbre: 'whistle',
    range: [72, 96],
    gain: 4,
    pan: 0.08,
    sends: { reverb: 0.42, delay: 0.2 },
  });
  s.voice({
    part: W2,
    timbre: 'whistle',
    range: [66, 90],
    gain: 2.32,
    pan: -0.28,
    sends: { reverb: 0.48, delay: 0.2 },
  });
  for (const pan of [-0.42, -0.2, 0.02, 0.22]) {
    s.voice({
      part: G,
      timbre: 'guitar',
      range: [50, 72],
      gain: 3.84,
      pan,
      sends: { reverb: 0.3, delay: 0 },
    });
  }
  s.voice({
    part: B,
    timbre: 'upright',
    range: [31, 55],
    gain: 3.84,
    pan: 0,
    sends: { reverb: 0.15, delay: 0 },
  });
  s.voice({
    part: K,
    timbre: 'glock',
    range: [84, 100],
    gain: 2.08,
    pan: 0.38,
    sends: { reverb: 0.55, delay: 0.3 },
  });
  for (const pan of [-0.6, 0.1, 0.6]) {
    s.voice({
      part: P,
      timbre: 'glass',
      range: [58, 78],
      gain: 1.6,
      pan,
      sends: { reverb: 0.6, delay: 0 },
    });
  }
  s.mix.reverb = { size: 0.62, decay: 2.4, damping: 0.5, preDelay: 0.018, returnLevel: 0.3 };
  s.mix.delay = { time: 0.45, feedback: 0.22, returnLevel: 0.1 };

  // Harmony: guitar voicing (four strings), pad voicing, bass root, chord tones (pitch classes).
  // prettier-ignore
  const CH: Record<string, { gtr: number[]; pad: number[]; root: number; pcs: number[] }> = {
    G:     { gtr: [55, 59, 62, 67], pad: [62, 67, 71], root: 43, pcs: [7, 11, 2] },
    Em:    { gtr: [55, 59, 64, 67], pad: [64, 67, 71], root: 40, pcs: [4, 7, 11] },
    C:     { gtr: [55, 60, 64, 67], pad: [64, 67, 72], root: 36, pcs: [0, 4, 7] },
    D:     { gtr: [57, 62, 66, 69], pad: [62, 66, 69], root: 38, pcs: [2, 6, 9] },
    D7:    { gtr: [57, 60, 66, 69], pad: [62, 66, 72], root: 38, pcs: [2, 6, 9, 0] },
    Cm:    { gtr: [55, 60, 63, 67], pad: [63, 67, 72], root: 36, pcs: [0, 3, 7] },
    E7:    { gtr: [56, 59, 62, 64], pad: [62, 68, 71], root: 40, pcs: [4, 8, 11, 2] },
    Am:    { gtr: [57, 60, 64, 69], pad: [64, 69, 72], root: 45, pcs: [9, 0, 4] },
    Gmaj7: { gtr: [54, 59, 62, 67], pad: [62, 66, 71], root: 43, pcs: [7, 11, 2, 6] },
  };
  // Bars as [chord, beats] lists.
  const bar = (...cs: string[]): [string, number][] => cs.map((c) => [c, 4 / cs.length]);
  const Abars = [
    bar('G'),
    bar('Em'),
    bar('C'),
    bar('D'),
    bar('G'),
    bar('Em'),
    bar('C', 'D7'),
    bar('G'),
  ];
  const BARS: [string, number][][] = [
    bar('G'),
    bar('G'),
    bar('C'),
    bar('D7'), // intro 0–3
    ...Abars,
    ...Abars, // A 4–11, A′ 12–19
    ...['C', 'Cm', 'G', 'E7', 'Am', 'D7', 'G', 'D7'].map((c) => bar(c)), // B 20–27
    ...Abars, // A″ 28–35
    bar('G'),
    bar('C'),
    bar('Cm'),
    bar('G'),
    bar('Gmaj7'),
    bar('Gmaj7'), // outro 36–41
  ];
  const END = BARS.length;
  const chordAt = (b: number, beat: number): string => {
    let x = 0;
    for (const [c, n] of BARS[b]) if (beat < (x += n) - 1e-9) return c;
    return BARS[b][BARS[b].length - 1][0];
  };

  /** Parses `pitch:beats` notes (`r:beats` a rest; `|` ignored) starting at bar b0, beat 0. */
  const parse = (b0: number, text: string, beat0 = 0): Ev[] => {
    let at = beat0;
    const out: Ev[] = [];
    for (const tok of text.split(/[\s|]+/).filter(Boolean)) {
      const [p, n] = tok.split(':');
      if (p !== 'r') out.push([b0 + Math.floor(at / 4), at % 4, Number(p), Number(n)]);
      at += Number(n);
    }
    return out;
  };
  /** One tune from absolute events, rests filling the gaps. */
  const tune = (part: string, evs: Ev[], glide: Record<string, unknown>, label?: string): void => {
    const beatOf = ([b, bt]: Ev) => b * 4 + bt;
    const notes: ({ pitch: number; len: number } | { rest: true; len: number })[] = [];
    evs.forEach((e, i) => {
      const next = evs[i + 1];
      const end = beatOf(e) + e[3];
      notes.push({ pitch: e[2], len: r4(e[3] * s.beat) });
      if (next && beatOf(next) > end + 1e-9)
        notes.push({ rest: true, len: r4((beatOf(next) - end) * s.beat) });
    });
    s.m('tune', s.T(evs[0][0], evs[0][1]), { target: { part }, notes, glide, label });
  };

  // The melody.
  const A1 =
    '86:1.5 83:.5 79:1 83:1 | 88:1.5 86:.5 83:2 | 84:1 88:1 91:1.5 88:.5 | 86:3 r:1 | ' +
    '86:1.5 83:.5 79:1 83:1 | 88:1.5 86:.5 83:1 79:1 | 88:1 84:1 81:1 78:1 | 79:3 r:1';
  const A2 =
    '86:1.5 83:.5 79:1 83:1 | 88:1.5 86:.5 83:2 | 84:1 88:1 91:1.5 88:.5 | 86:2 88:.5 86:.5 84:.5 81:.5 | ' +
    '83:1.5 81:.5 79:1 83:1 | 88:1.5 86:.5 83:1 79:1 | 88:.5 86:.5 84:.5 88:.5 81:1 78:1 | 79:2 r:1 86:.5 88:.5';
  const Bm =
    '91:2 88:1 84:1 | 91:2 87:1 84:1 | 86:1.5 83:.5 79:2 | 80:1 83:1 86:1 88:1 | ' +
    '88:1.5 84:.5 81:2 | 84:1 86:1 90:1 88:1 | 86:2 83:1 79:1 | 81:1 78:1 81:1 84:1';
  const A3 = A2.replace(/79:2 r:1 86:.5 88:.5$/, '79:4');
  const OUT = '86:1.5 83:.5 79:2 | 88:2 84:2 | 87:2 84:1 81:1 | 83:1 79:3 | r:2 79:.5';
  const mel: Ev[] = [
    ...parse(3, '83:.5 84:.5', 3),
    ...parse(4, A1),
    ...parse(12, A2),
    ...parse(20, Bm),
    ...parse(28, A3),
    ...parse(36, OUT),
  ];
  const at = (evs: Ev[], b: number, beat: number): number | undefined =>
    evs.find(
      (e) => e[0] * 4 + e[1] <= b * 4 + beat + 1e-9 && b * 4 + beat < e[0] * 4 + e[1] + e[3] - 1e-9,
    )?.[2];
  const scoop = { length: 0.065, ease: 'smoothstep', land: true };
  tune(W, mel, scoop, 'Whistle');
  // The last note: a slow slide up an octave, held.
  s.m('tune', s.T(40, 2.5), {
    target: { part: W },
    notes: [{ pitch: 91, len: r4(5.5 * s.beat) }],
    glide: { length: 0.42, ease: 'smoothstep' },
  });

  // Second whistle in A″ and the outro: on the beat, the chord tone a third to a sixth below the
  // whistle nearest the harmony's last note (fourths and fifths only as a last resort); off-beat
  // short notes move a diatonic third below, in parallel.
  const SCALE = [0, 2, 4, 6, 7, 9, 11]; // G major pitch classes, from C: C D E F# G A B
  const pcOf = (p: number) => ((p % 12) + 12) % 12;
  const third = (p: number): number => {
    let i = SCALE.indexOf(pcOf(p));
    if (i < 0) return p - 3;
    let q = p;
    for (let k = 0; k < 2; k++) {
      const j = (i + 6) % 7;
      q -= (SCALE[i] - SCALE[j] + 12) % 12;
      i = j;
    }
    return q;
  };
  let prev = 83;
  const harm: Ev[] = [...parse(28, A3), ...parse(36, OUT).filter(([b]) => b < 40)].map(
    ([b, bt, p, n]) => {
      const pcs = CH[chordAt(b, bt)].pcs;
      let q = third(p);
      if (!(n < 1 && bt % 1 !== 0)) {
        let best = Infinity;
        for (let d = 3; d <= 9; d++) {
          if (d === 6 || !pcs.includes(pcOf(p - d))) continue;
          const cost = Math.abs(p - d - prev) + (d === 5 || d === 7 ? 3 : 0);
          if (cost < best) [best, q] = [cost, p - d];
        }
      }
      prev = q;
      return [b, bt, q, n];
    },
  );
  tune(W2, harm, scoop, 'Harmony');

  // Opening pitches: whistles, guitar, bass, glock, pad.
  s.m(
    'chord',
    0,
    {
      notes: { kind: 'pitches', pitches: [83, harm[0][2], ...CH.G.gtr, 43, 91, ...CH.C.pad] },
      voicing: 'even',
      assign: 'ordered',
      byVoice: true,
    },
    'start0',
  );
  s.lastChord.set(G, CH.G.gtr);
  s.lastChord.set(P, CH.C.pad);

  // Guitar: chord changes landing on the beat, picked in a Travis pattern (thumb on the beats
  // alternating the low strings, fingers on the off-beats).
  const seq = BARS.flat().map(([c, n]): [number[], number] => [CH[c].gtr, n]);
  s.chords(G, 0, seq, { length: 0.05, stagger: 0.012, jitter: 0, ease: 'smoothstep' });
  s.pulse(
    { part: G },
    0,
    40,
    0.5,
    {
      pattern: [0.95, 0.5, 0.75, 0.55, 0.85, 0.5, 0.75, 0.6],
      order: [1, 3, 2, 4, 1, 3, 2, 4],
      decay: 1.1,
      floor: 0.2,
      mode: 'order',
    },
    'Picking',
  );
  // The last chord, rolled once.
  s.pulse({ part: G }, 40, 1, 0.12, {
    pattern: [0.6, 0.55, 0.55, 0.6, 0, 0, 0, 0],
    order: [1, 2, 3, 4],
    decay: 2.5,
    floor: 0.3,
    mode: 'order',
  });

  // Pad: from the bridge on, slow gliding chords.
  const padSeq = BARS.slice(20)
    .flat()
    .map(([c, n]): [number[], number] => [CH[c].pad, n]);
  s.chords(P, 20, padSeq, { length: 0.8, stagger: 0.2, jitter: 0.2, ease: 'smoothstep' });

  // Bass: two in a bar in the verses, walking quarters in the bridge and the last verse.
  const bassEv: Ev[] = [];
  const fifth = (r: number) => (r + 7 <= 50 ? r + 7 : r - 5);
  for (let b = 0; b < END; b++) {
    const cs = BARS[b];
    const walk = b >= 20 && b < 36;
    if (b >= 40) {
      bassEv.push([b, 0, 43, 4]);
    } else if (cs.length === 2) {
      cs.forEach(([c], i) => bassEv.push([b, i * 2, CH[c].root, 2]));
    } else if (!walk) {
      const r = CH[cs[0][0]].root;
      bassEv.push([b, 0, r, 2], [b, 2, fifth(r), 2]);
    } else {
      const c = cs[0][0];
      const r = CH[c].root;
      const minor = CH[c].pcs.includes((r + 3) % 12);
      const next = CH[BARS[b + 1][0][0]].root;
      const five = r + 7 <= 52 ? r + 7 : r - 5;
      // Approach the next root by a step, avoiding a semitone against the whistle.
      const ws = [at(mel, b, 3), at(harm, b, 3)].filter((w) => w !== undefined);
      const cands = [next - 1, next + 1, next - 2, next + 2].sort(
        (x, y) => Math.abs(x - five) - Math.abs(y - five),
      );
      const appr = cands.find((c) => ws.every((w) => ![1, 11].includes(pcOf(w - c)))) ?? five;
      bassEv.push([b, 0, r, 1], [b, 1, r + (minor ? 3 : 4), 1], [b, 2, five, 1], [b, 3, appr, 1]);
    }
  }
  tune(
    B,
    bassEv.filter(([b]) => b >= 2),
    { length: 0.035, ease: 'smoothstep', land: true },
    'Bass',
  );

  // Glockenspiel: answers in the phrase-end rests, and the last ring.
  const glock: Ev[] = [
    ...parse(11, '91:.5 95:.5 98:1', 1.5),
    ...parse(15, '93:.5 98:.5', 3),
    ...parse(19, '95:.5 91:.5', 2),
    ...parse(23, '92:1 95:1 98:2'),
    ...parse(31, '93:.5 98:.5', 3),
    ...parse(35, '91:.5 95:.5 98:1 95:1'),
    ...parse(39, '98:.5 95:.5 91:1', 2),
    ...parse(41, '95:4'),
  ];
  tune(K, glock, { length: 0.01, land: true }, 'Glock');

  // Levels.
  s.level(0, undefined, 0, 0);
  s.level(0.01, { part: G }, 0.75, 0.3, 'Intro');
  s.level(s.T(2) - 0.05, { part: B }, 0.8, 0.05);
  s.level(s.T(3, 3) - 0.1, { part: W }, 0.8, 0.08, 'A');
  s.level(s.T(11, 1), { part: K }, 0.7, 0.1);
  s.level(s.T(12), { part: G }, 0.82, 2, 'A′');
  s.level(s.T(19, 3), { part: W }, 0.9, 0.5, 'B');
  s.level(s.T(20), { part: P }, 0.4, 3);
  s.level(s.T(20), { part: B }, 0.85, 1);
  s.level(s.T(28) - 0.1, { part: W2 }, 0.62, 0.1, 'A″');
  s.level(s.T(28), { part: P }, 0.5, 2);
  s.level(s.T(36), { part: W }, 0.82, 2, 'Outro');
  s.level(s.T(39, 3.5), { part: W2 }, 0, 0.6);
  s.level(s.T(36), { part: P }, 0.32, 4);
  s.level(s.T(40), { part: P }, 0.42, 1.5);
  s.level(s.T(41), undefined, 0, s.T(42) - s.T(41) + 1.2);
  s.end = { at: r4(s.T(42) + 1.4), fade: 0.6 };

  const piece = s.toJson() as Record<string, unknown>;
  piece.meta = {
    ...(piece.meta as object),
    created: '2026-11-22T00:00:00.000Z',
    modified: '2026-11-22T00:00:00.000Z',
  };
  // One colour per part, as in the gallery video (lightened to read on both themes).
  const col = {
    W: '#3d8fd1',
    W2: '#8ab8e6',
    G: '#d9922b',
    B: '#a0704a',
    K: '#e2557a',
    P: '#8fb08a',
  };
  const colors = [col.W, col.W2, col.G, col.G, col.G, col.G, col.B, col.K, col.P, col.P, col.P];
  (piece.voices as { color?: string }[]).forEach((v, i) => (v.color = colors[i]));
  (piece.view as { colors: string }).colors = 'custom';
  piece.timbres = {
    // Whistle: a near-pure tone with a narrow band of breath around it, a little swell on each
    // note, a late irregular vibrato and a human wander in pitch and level.
    whistle: {
      harmonics: [1, 0.025, 0.008],
      stretch: 0,
      noise: { level: 0.1, bandwidth: 0.12 },
      brightness: { tilt: 0, track: 0 },
      detuneSpread: 0,
      accent: 0.2,
      articulation: { amount: 0.25, attack: 0.035, decay: 0.28 },
      vibrato: { rate: 5.6, depthCents: 16, delay: 0.22, jitter: 0.6 },
      drift: { cents: 4, rate: 0.45, amp: 0.07 },
    },
    // Nylon guitar: softer than `pluck`, ringing a second.
    guitar: {
      harmonics: [1, 0.55, 0.32, 0.2, 0.12, 0.09, 0.06, 0.04, 0.03, 0.02],
      stretch: 0,
      noise: { level: 0.02, bandwidth: 2 },
      brightness: { tilt: -3, track: 0.4 },
      detuneSpread: 1.5,
      accent: 0.05,
      articulation: { amount: 0.88, attack: 0.002, decay: 0.9, crisp: true },
      vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
    },
    // Upright bass: round, plucked, a short ring.
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
    // Glockenspiel: a sine with a steel bar's upper partials on the strike.
    glock: {
      harmonics: [1],
      stretch: 0,
      strikePartials: [
        { ratio: 2.76, amp: 0.5, decay: 0.4 },
        { ratio: 5.4, amp: 0.25, decay: 0.15 },
        { ratio: 8.93, amp: 0.1, decay: 0.08 },
      ],
      brightness: { tilt: 0, track: 0.2 },
      detuneSpread: 0,
      accent: 0,
      articulation: { amount: 0.9, attack: 0.001, decay: 1.8, crisp: true },
      vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
    },
  };
  return piece;
}
