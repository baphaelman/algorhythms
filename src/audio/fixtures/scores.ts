/**
 * Hand-written CompiledScore fixtures for the DSP tests and the hidden fixture page (M2). They
 * stand in for compiler output until M1's compiler exists, and follow the CompiledScore contract
 * (core/types.ts): contiguous segments within each life, born = t0 of the first segment, died =
 * end of the fade-out.
 */

import type {
  CompiledScore,
  CompiledVoice,
  EaseRef,
  LevelChange,
  MixSettings,
  Segment,
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
    const seg: Segment = { t0: at, t1: at + m.len, p0: p, p1: m.to, ease: m.ease ?? 'smootherstep' };
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
    typeof spec.timbre === 'object' ? spec.timbre : [{ t: 0, preset: spec.timbre ?? 'sine', fade: 0 }];
  return {
    id: spec.id ?? `v${index + 1}`,
    index,
    lives: [{ born, died, fadeIn: spec.fadeIn ?? (born > 0 ? 0.5 : 0), fadeOut: spec.fadeOut ?? 0.5 }],
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

/** Builds a score from voice specs; duration = the last death. */
export function makeScore(specs: VoiceSpec[], end: number, seed = 1): CompiledScore {
  const voices = specs.map((s, i) => makeVoice(i, s, end));
  const duration = Math.max(0, ...voices.flatMap((v) => v.lives.map((l) => l.died ?? end)));
  return {
    duration,
    voices,
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
export function unisonScore(n: number, opts: { pitch?: number; hold?: number; timbre?: string; seed?: number } = {}): CompiledScore {
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
export function stressScore(n = 12, seconds = 30, every = 1.2, seed = 11, timbres = ['sine', 'organ']): CompiledScore {
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
      level: v % 4 === 0 ? [{ t: 8, gain: 0.3, over: 2 }, { t: 14, gain: 1, over: 1 }] : [],
    });
  }
  return makeScore(specs, seconds, seed);
}

/** The eases whose evaluation is allocation-free on the audio thread (see docs/build-log.md, M2). */
export const PLAIN_EASES: EaseRef[] = ['smootherstep', 'smootherstep', 'linear', 'smoothstep', 'cosine'];

/** Every ease kind, including the solver-based expo and bézier. */
export const ALL_EASES: EaseRef[] = [
  ...PLAIN_EASES,
  'expo',
  { kind: 'bezier', x1: 0.3, y1: 0, x2: 0.2, y2: 1.15 },
];

/** `n` voices that glide continuously (a new target every ~0.6–1.4 s): the RTF/GC workload. */
export function denseScore(n = 24, seconds = 70, seed = 5, eases: EaseRef[] = ALL_EASES): CompiledScore {
  const rng = new Prng(seed);
  const specs: VoiceSpec[] = [];
  const timbres = ['sine', 'glass', 'organ', 'reed', 'choir', 'pluck'];
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
    moves: shift[i] !== 0 ? [{ at: swapAt - 0.001, to: p + shift[i], len: 0.001, ease: 'linear' }] : [],
    timbre,
  }));
  specs[5] = { start: base[5], died: swapAt, fadeOut: 0, timbre };
  specs.push({ start: 67, born: swapAt, fadeIn: 0, timbre });
  return { a, b: makeScore(specs, end, 21) };
}

/** Names of the fixtures the hidden page offers. */
export const FIXTURE_NAMES = [
  'a4-sine',
  'unison-8',
  'merge',
  'long-glide',
  'stress',
  'preset-sine',
  'preset-glass',
  'preset-organ',
  'preset-reed',
  'preset-choir',
  'preset-pluck',
  'dense-24',
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** A fixture by name. */
export function fixtureScore(name: FixtureName): CompiledScore {
  switch (name) {
    case 'a4-sine':
      return makeScore([{ id: 'a4', start: 69, timbre: 'sine' }], 10);
    case 'unison-8':
      return unisonScore(8);
    case 'merge':
      return mergeScore();
    case 'long-glide':
      return longGlideScore();
    case 'stress':
      return stressScore();
    case 'dense-24':
      return denseScore(24, 30);
    default:
      return presetScore(name.slice('preset-'.length));
  }
}
