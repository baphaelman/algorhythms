/**
 * Hand-written CompiledScore fixtures for the DSP tests and the hidden fixture page (M2). They
 * stand in for compiler output until M1's compiler exists, and follow the CompiledScore contract
 * (core/types.ts): contiguous segments within each life, born = t0 of the first segment, died =
 * end of the fade-out.
 */

import type {
  PulseRecord,
  CompiledScore,
  CompiledVoice,
  EaseRef,
  LevelChange,
  MixSettings,
  Segment,
  Timbre,
  TimbreChange,
} from '../../core/types';
import { Prng } from '../../dsp/rng';

/** One glide: start at `at`, reach `to` after `len` seconds. */
export interface Move {
  at: number;
  to: number;
  len: number;
  ease?: EaseRef;
  /** Carried-velocity term (an interruption), semitones. */
  m0?: number;
}

/** A voice described by its start pitch and moves. */
export interface VoiceSpec {
  id?: string;
  start: number;
  moves?: Move[];
  born?: number;
  died?: number;
  fadeIn?: number;
  fadeOut?: number;
  timbre?: string | TimbreChange[];
  gain?: number;
  pan?: number | 'auto';
  level?: LevelChange[];
  sends?: { reverb?: number; delay?: number };
  mute?: boolean;
  solo?: boolean;
}

/** Fixture mix: a modest room, a quiet delay, the −1 dBFS limiter. */
export const FIXTURE_MIX: MixSettings = {
  reverb: { size: 0.6, decay: 2.4, damping: 0.4, preDelay: 0.02, returnLevel: 0.3 },
  delay: { time: 0.375, feedback: 0.3, returnLevel: 0.15 },
  sends: { reverb: 0.35, delay: 0.1 },
  tone: { tilt: 0, lowpassHz: 18000 },
  limiter: { ceilingDb: -1 },
  panAuto: 'index',
};

/** No FX at all (sends and returns 0, tone flat): isolates the voices. */
export const DRY_MIX: MixSettings = {
  reverb: { size: 0.5, decay: 2, damping: 0.4, preDelay: 0.02, returnLevel: 0 },
  delay: { time: 0.375, feedback: 0.3, returnLevel: 0 },
  sends: { reverb: 0, delay: 0 },
  tone: { tilt: 0, lowpassHz: 24000 },
  limiter: { ceilingDb: -1 },
  panAuto: 'index',
};

function segmentsFor(spec: VoiceSpec, born: number, end: number): Segment[] {
  const segs: Segment[] = [];
  let t = born;
  let p = spec.start;
  for (const m of spec.moves ?? []) {
    const at = Math.max(t, m.at);
    if (at >= end) break;
    if (at > t) segs.push({ t0: t, t1: at, p0: p, p1: p, ease: 'linear' });
    const seg: Segment = {
      t0: at,
      t1: at + m.len,
      p0: p,
      p1: m.to,
      ease: m.ease ?? 'smootherstep',
    };
    if (m.m0) seg.m0 = m.m0;
    segs.push(seg);
    t = at + m.len;
    p = m.to;
  }
  if (end > t) segs.push({ t0: t, t1: end, p0: p, p1: p, ease: 'linear' });
  return segs;
}

/** Builds a voice; `end` is the score end used when the voice has no `died`. */
export function makeVoice(index: number, spec: VoiceSpec, end: number): CompiledVoice {
  const born = spec.born ?? 0;
  const died = spec.died ?? end;
  const timbre: TimbreChange[] =
    typeof spec.timbre === 'object'
      ? spec.timbre
      : [{ t: 0, preset: spec.timbre ?? 'sine', fade: 0 }];
  return {
    id: spec.id ?? `v${index + 1}`,
    index,
    lives: [
      { born, died, fadeIn: spec.fadeIn ?? (born > 0 ? 0.5 : 0), fadeOut: spec.fadeOut ?? 0.5 },
    ],
    segments: segmentsFor(spec, born, died),
    timbre,
    level: spec.level ?? [],
    gain: spec.gain ?? 1,
    pan: spec.pan ?? 'auto',
    mute: spec.mute ?? false,
    solo: spec.solo ?? false,
    sends: spec.sends ?? {},
  };
}

/**
 * Adds pulse records (revision 9) to every `every`-th voice, in place: from 1 s to 1 s before the
 * end, a hit every `step` (accents 1, 0.5, 0.75, 0.25; decay 0.6·step; floor 0.2; re-striking),
 * then back to 1. For the RTF and no-GC workloads (R9-3b).
 */
export function withPulses(score: CompiledScore, every = 2, step = 0.25): CompiledScore {
  const accents = [1, 0.5, 0.75, 0.25];
  const end = score.duration - 1;
  score.voices.forEach((v, i) => {
    if (i % every !== 0 || end <= 1) return;
    const recs: PulseRecord[] = [{ t: 1, accent: 1, decay: 0, floor: 0.2, strike: false }];
    for (let k = 0; 1 + k * step < end; k++) {
      const t = Math.round((1 + k * step) * 1e9) / 1e9;
      recs.push({
        t,
        accent: accents[k % 4],
        decay: 0.6 * step,
        floor: 0.2,
        strike: true,
        hit: true,
      });
    }
    recs.push({ t: end, accent: 1, decay: 0, floor: 1, strike: false });
    v.pulse = recs;
  });
  return score;
}

/** Builds a score from voice specs; duration = the last death. */
export function makeScore(specs: VoiceSpec[], end: number, seed = 1): CompiledScore {
  const voices = specs.map((s, i) => makeVoice(i, s, end));
  const duration = Math.max(0, ...voices.flatMap((v) => v.lives.map((l) => l.died ?? end)));
  return {
    duration,
    voices,
    walkSteps: [],
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'A', scale: 'minor' } }],
    referenceHz: 440,
    seed,
  };
}

/**
 * N voices fanned around `pitch`, gliding into a unison at 0.5–2.5 s and holding it until `hold`
 * seconds; they fade out over the last 0.5 s.
 */
export function unisonScore(
  n: number,
  opts: { pitch?: number; hold?: number; timbre?: string; seed?: number } = {},
): CompiledScore {
  const pitch = opts.pitch ?? 57;
  const end = opts.hold ?? 12;
  const specs: VoiceSpec[] = [];
  for (let i = 0; i < n; i++) {
    const start = pitch + (i - (n - 1) / 2) * 2;
    specs.push({ start, moves: [{ at: 0.5, to: pitch, len: 2 }], timbre: opts.timbre ?? 'sine' });
  }
  return makeScore(specs, end, opts.seed ?? 7);
}

/**
 * N voices fanned 2 semitones apart around `pitch`: they glide into a unison at 0.5–2.5 s, hold
 * it, and at `splitAt` glide back out to where they started (over 2 s); the score ends at `end`.
 */
export function unisonSplitScore(
  n: number,
  opts: {
    pitch?: number;
    splitAt?: number;
    end?: number;
    timbre?: string;
    seed?: number;
    prefix?: string;
  } = {},
): CompiledScore {
  const pitch = opts.pitch ?? 57;
  const splitAt = opts.splitAt ?? 7;
  const specs: VoiceSpec[] = [];
  for (let i = 0; i < n; i++) {
    const start = pitch + (i - (n - 1) / 2) * 2;
    specs.push({
      id: opts.prefix === undefined ? undefined : `${opts.prefix}${i}`,
      start,
      moves: [
        { at: 0.5, to: pitch, len: 2 },
        { at: splitAt, to: start, len: 2 },
      ],
      timbre: opts.timbre ?? 'sine',
    });
  }
  return makeScore(specs, opts.end ?? splitAt + 4, opts.seed ?? 7);
}

/**
 * A phrase of unisons and chords for six voices (about 20 s): an A minor chord gathers into a
 * unison on A3, opens into F major, folds into an octave pair, opens into E major and closes on
 * an A minor chord.
 */
export function unisonChordScore(timbre = 'sine', seed = 13): CompiledScore {
  const chordA = [45, 52, 57, 60, 64, 69];
  const chordF = [41, 48, 57, 60, 65, 72];
  const octaves = [45, 45, 45, 57, 57, 57];
  const chordE = [40, 52, 56, 59, 64, 68];
  const specs: VoiceSpec[] = chordA.map((p, v) => ({
    id: `phrase-${v}`,
    start: p,
    moves: [
      { at: 1.5, to: 57, len: 2 },
      { at: 6, to: chordF[v], len: 1.5 },
      { at: 9.5, to: octaves[v], len: 1.5 },
      { at: 13.5, to: chordE[v], len: 1.2 },
      { at: 16.5, to: chordA[v], len: 1.2 },
    ],
    timbre,
  }));
  return makeScore(specs, 20.5, seed);
}

/**
 * Merge: four voices; at 2 s voices 2 and 4 glide onto voices 1 and 3 over 1.5 s and then fade
 * out over 2 s (dying at 5.5 s); the survivors hold until 10 s.
 */
export function mergeScore(timbre = 'sine', seed = 3): CompiledScore {
  const end = 10;
  return makeScore(
    [
      { start: 50, timbre },
      { start: 53, moves: [{ at: 2, to: 50, len: 1.5 }], died: 5.5, fadeOut: 2, timbre },
      { start: 57, timbre },
      { start: 62, moves: [{ at: 2, to: 57, len: 1.5 }], died: 5.5, fadeOut: 2, timbre },
    ],
    end,
    seed,
  );
}

/** One voice sweeping 24 → 108 (linear, 20 s) and back down to 36 (smootherstep, 10 s). */
export function longGlideScore(timbre = 'reed'): CompiledScore {
  return makeScore(
    [
      {
        start: 24,
        moves: [
          { at: 0.5, to: 108, len: 20, ease: 'linear' },
          { at: 21, to: 36, len: 10 },
        ],
        timbre,
      },
    ],
    32,
  );
}

/** Pitch sets for chord fixtures: A minor-ish voicings. */
const CHORDS = [
  [45, 52, 57, 60, 64, 69],
  [41, 48, 57, 60, 65, 72],
  [43, 50, 55, 62, 67, 71],
  [40, 52, 56, 59, 64, 68],
  [45, 52, 60, 64, 69, 76],
];

/** Three voices playing a slow chord progression with glides, for one timbre. */
export function presetScore(timbre: string): CompiledScore {
  const specs: VoiceSpec[] = [0, 1, 2].map((v) => ({
    start: CHORDS[0][v + 2],
    moves: [1, 2, 3, 4].map((c) => ({ at: c * 2.5, to: CHORDS[c][v + 2], len: 0.8 })),
    timbre,
  }));
  return makeScore(specs, 13);
}

/**
 * Stress fixture: `n` voices changing chords every `every` seconds with varied glide lengths,
 * some interrupted (m0 ≠ 0), a level dip, and two timbres. Deterministic from `seed`.
 */
export function stressScore(
  n = 12,
  seconds = 30,
  every = 1.2,
  seed = 11,
  timbres = ['sine', 'organ'],
): CompiledScore {
  const rng = new Prng(seed);
  const specs: VoiceSpec[] = [];
  for (let v = 0; v < n; v++) {
    const moves: Move[] = [];
    let t = 0.3 + rng.next() * 0.3;
    while (t < seconds - 2) {
      const chord = CHORDS[Math.floor(rng.next() * CHORDS.length)];
      const to = chord[v % chord.length] + 12 * (Math.floor(v / chord.length) - 1);
      const len = 0.15 + rng.next() * 1.2;
      const interrupted = rng.next() < 0.2;
      moves.push({ at: t, to, len, m0: interrupted ? (rng.next() - 0.5) * 4 : undefined });
      t += len + every * (0.3 + rng.next());
    }
    specs.push({
      start: CHORDS[0][v % 6] + 12 * (Math.floor(v / 6) - 1),
      moves,
      timbre: timbres[v % timbres.length],
      level:
        v % 4 === 0
          ? [
              { t: 8, gain: 0.3, over: 2 },
              { t: 14, gain: 1, over: 1 },
            ]
          : [],
    });
  }
  return makeScore(specs, seconds, seed);
}

/** The eases whose evaluation is allocation-free on the audio thread (see docs/build-log.md, M2). */
export const PLAIN_EASES: EaseRef[] = [
  'smootherstep',
  'smootherstep',
  'linear',
  'smoothstep',
  'cosine',
];

/** Every ease kind, including the solver-based expo and bézier. */
export const ALL_EASES: EaseRef[] = [
  ...PLAIN_EASES,
  'expo',
  { kind: 'bezier', x1: 0.3, y1: 0, x2: 0.2, y2: 1.15 },
];

/** The M2 presets, which `denseScore` cycles through by default. */
export const M2_PRESETS = ['sine', 'glass', 'organ', 'reed', 'choir', 'pluck'];

/**
 * M6 workload timbres (RTF and no-GC): the bell (additive + FM + noise), FM on a wavetable carrier
 * at a non-integer ratio, and breath noise over a reed. Pass as the render's piece timbres.
 */
export const M6_WORKLOAD_TIMBRES: Record<string, Timbre> = {
  fmreed: {
    harmonics: [1, 0.04, 0.62, 0.05, 0.42, 0.05, 0.3],
    stretch: 0,
    fm: { ratio: 2.71, index: 1.8, indexTrack: 0.5 },
    brightness: { tilt: -2, track: 0.5 },
    detuneSpread: 1,
    accent: 0.2,
    articulation: { amount: 0.3, attack: 0.01, decay: 0.4 },
    vibrato: { rate: 5, depthCents: 6, delay: 0.4, jitter: 0.4 },
  },
  breath: {
    harmonics: [1, 0.3, 0.12, 0.05],
    stretch: 0,
    noise: { level: 0.3, bandwidth: 0.8 },
    brightness: { tilt: -2, track: 0 },
    detuneSpread: 1,
    accent: 0.2,
    articulation: { amount: 0.2, attack: 0.02, decay: 0.3 },
    vibrato: { rate: 5, depthCents: 5, delay: 0.5 },
  },
};

/** `n` voices that glide continuously (a new target every ~0.6–1.4 s): the RTF/GC workload. */
export function denseScore(
  n = 24,
  seconds = 70,
  seed = 5,
  eases: EaseRef[] = ALL_EASES,
  timbres: string[] = M2_PRESETS,
): CompiledScore {
  const rng = new Prng(seed);
  const specs: VoiceSpec[] = [];
  for (let v = 0; v < n; v++) {
    const moves: Move[] = [];
    let t = 0.1 + rng.next() * 0.2;
    let p = 40 + Math.floor(rng.next() * 40);
    while (t < seconds) {
      const len = 0.4 + rng.next() * 0.6;
      p = Math.min(88, Math.max(33, p + Math.floor(rng.next() * 15) - 7));
      moves.push({ at: t, to: p, len, ease: eases[Math.floor(rng.next() * eases.length)] });
      t += len + 0.2 + rng.next() * 0.4;
    }
    specs.push({ start: 40 + v * 2, moves, timbre: timbres[v % timbres.length] });
  }
  return makeScore(specs, seconds, seed);
}

/**
 * A pair of scores for hot-swap tests: B moves some voices by a semitone or more (crossfade),
 * some by a quarter tone (slew), removes voice 6 and adds voice 7, all from `swapAt` on.
 */
export function swapPair(swapAt = 3, timbre = 'sine'): { a: CompiledScore; b: CompiledScore } {
  const base = [48, 52, 55, 59, 62, 64];
  const end = 10;
  const a = makeScore(
    base.map((p) => ({ start: p, timbre })),
    end,
    21,
  );
  const shift = [0, 0.25, 2, -0.3, 5, 0];
  const specs: VoiceSpec[] = base.map((p, i) => ({
    start: p,
    moves:
      shift[i] !== 0 ? [{ at: swapAt - 0.001, to: p + shift[i], len: 0.001, ease: 'linear' }] : [],
    timbre,
  }));
  specs[5] = { start: base[5], died: swapAt, fadeOut: 0, timbre };
  specs.push({ start: 67, born: swapAt, fadeIn: 0, timbre });
  return { a, b: makeScore(specs, end, 21) };
}

/**
 * Unison-lock workload (no-GC test): `n` voices that keep gathering into unisons (all on one
 * pitch, or in pairs) and opening into chords, with glides of 0.6–2 s, plus four voices born late
 * into a held unison. Deterministic from `seed`.
 */
export function lockStressScore(n = 12, seconds = 80, seed = 17): CompiledScore {
  const rng = new Prng(seed);
  const specs: VoiceSpec[] = Array.from({ length: n }, (_, v) => ({
    start: CHORDS[0][v % 6] + 12 * (Math.floor(v / 6) - 1),
    moves: [] as Move[],
    timbre: ['sine', 'glass', 'choir'][v % 3],
  }));
  let t = 1;
  let step = 0;
  const unisons: { at: number; pitch: number }[] = [];
  while (t < seconds - 4) {
    const len = 0.6 + rng.next() * 1.4;
    const kind = step % 3;
    const chord = CHORDS[Math.floor(rng.next() * CHORDS.length)];
    const pitch = 50 + Math.floor(rng.next() * 14);
    for (let v = 0; v < n; v++) {
      const to =
        kind === 0
          ? pitch
          : kind === 1
            ? chord[(v >> 1) % 6] + 12 * (Math.floor(v / 12) - 1)
            : chord[v % 6] + 12 * (Math.floor(v / 6) - 1);
      specs[v].moves?.push({ at: t, to, len });
    }
    if (kind === 0) unisons.push({ at: t + len + 0.5, pitch });
    t += len + 1.5 + rng.next() * 2;
    step++;
  }
  for (let k = 0; k < 4 && k < unisons.length; k++) {
    const u = unisons[k * 2 < unisons.length ? k * 2 : k];
    specs.push({ start: u.pitch, born: u.at, died: u.at + 3, fadeIn: 0.3, fadeOut: 0.5 });
  }
  return makeScore(specs, seconds, seed);
}

/**
 * Adds timbre changes (M6-b timbre moments) to every voice, in place: from 1 s, a change every
 * ~`every` seconds (varied per voice, so locked voices change at different times) through
 * `presets` in turn, with fades of 0.4–2.4 s that often overlap the next change. For the no-GC
 * workload and the click tests. Deterministic from `seed`.
 */
export function withTimbreChanges(
  score: CompiledScore,
  presets: string[],
  every = 1.5,
  seed = 29,
): CompiledScore {
  const rng = new Prng(seed);
  score.voices.forEach((v, i) => {
    const own = v.timbre[0]?.preset ?? 'sine';
    const recs: TimbreChange[] = [{ t: 0, preset: own, fade: 0 }];
    let t = 1 + rng.next() * every;
    let k = i;
    while (t < score.duration - 1) {
      let preset = presets[k++ % presets.length];
      if (preset === recs[recs.length - 1].preset) preset = presets[k++ % presets.length];
      const fade = Math.round((0.4 + rng.next() * 2) * 1000) / 1000;
      recs.push({ t: Math.round(t * 1000) / 1000, preset, fade });
      t += every * (0.5 + rng.next());
    }
    v.timbre = recs;
  });
  return score;
}

/**
 * Timbre moments (M6-b): a glass chord and a glass unison pair whose voices change timbre at
 * different times, across every synthesis path (wavetable, additive + FM + noise in `bell`, FM in
 * `epiano`, noise in `flute`, formants in `choir`), with fades that overlap (a change arriving
 * mid-fade) and one locked voice changing while its partner keeps glass.
 */
export function timbreMomentScore(): CompiledScore {
  const glass = (changes: TimbreChange[]): TimbreChange[] => [
    { t: 0, preset: 'glass', fade: 0 },
    ...changes,
  ];
  const specs: VoiceSpec[] = [
    {
      start: 60,
      moves: [{ at: 3.2, to: 62, len: 0.6 }],
      timbre: glass([
        { t: 1, preset: 'bell', fade: 1.5 },
        { t: 1.8, preset: 'sine', fade: 1 },
        { t: 4, preset: 'glass', fade: 0.6 },
      ]),
    },
    {
      start: 64,
      timbre: glass([
        { t: 1.2, preset: 'bell', fade: 1.5 },
        { t: 3, preset: 'epiano', fade: 0.5 },
      ]),
    },
    {
      start: 67,
      moves: [{ at: 2.5, to: 69, len: 0.4 }],
      timbre: glass([{ t: 0.8, preset: 'choir', fade: 2 }]),
    },
    {
      start: 55,
      moves: [{ at: 0.3, to: 57, len: 0.8 }],
      timbre: glass([
        { t: 2, preset: 'flute', fade: 1 },
        { t: 3.5, preset: 'epiano', fade: 1 },
      ]),
    },
    { start: 59, moves: [{ at: 0.3, to: 57, len: 0.8 }], timbre: 'glass' },
  ];
  return makeScore(specs, 8, 31);
}

/** Names of the fixtures the hidden page offers. */
export const FIXTURE_NAMES = [
  'a4-sine',
  'unison-8',
  'unison-split-8',
  'unison-chord',
  'merge',
  'long-glide',
  'stress',
  'preset-sine',
  'preset-glass',
  'preset-organ',
  'preset-reed',
  'preset-choir',
  'preset-pluck',
  'preset-wobble',
  'preset-bell',
  'dense-24',
  'timbre-moments',
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** A fixture by name. */
export function fixtureScore(name: FixtureName): CompiledScore {
  switch (name) {
    case 'a4-sine':
      return makeScore([{ id: 'a4', start: 69, timbre: 'sine' }], 10);
    case 'unison-8':
      return unisonScore(8);
    case 'unison-split-8':
      return unisonSplitScore(8);
    case 'unison-chord':
      return unisonChordScore();
    case 'merge':
      return mergeScore();
    case 'long-glide':
      return longGlideScore();
    case 'stress':
      return stressScore();
    case 'dense-24':
      return denseScore(24, 30);
    case 'timbre-moments':
      return timbreMomentScore();
    default:
      return presetScore(name.slice('preset-'.length));
  }
}
