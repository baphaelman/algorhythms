/**
 * The directed composer's brief (PLAN.md §15 M12, §11.3 "Compose for me, directed"): the user's
 * answers, and `resolveBrief`, which turns them into every setting the composer needs.
 *
 * An answer narrows a *region*; it never picks a template. The seed draws everything inside it.
 * A missing field ("Surprise me") samples the whole continuous range: any mode the theory knows,
 * any tempo and density, any sound mix and energy curve, including blends of two named moods or
 * two shapes.
 *
 * Pure and seeded (`rand`, Purpose.Compose); portable math only (§7.11).
 */

import { clamp, cosPi, exp2, lerp, log2, sinPi } from './math';
import { Purpose, rand } from './rng';
import { SCALES } from './scales';
import { chordOf, theoryOf } from './theory';
import type { ScaleName, Seconds } from './types';

// ---------------------------------------------------------------------------------------------
// The brief (the shape D2 codes the setup screen against: PLAN M12 `ComposeBrief`)
// ---------------------------------------------------------------------------------------------

export type Mood = 'calm' | 'bright' | 'dreamy' | 'dark' | 'driving';
export type ComposeLength = 60 | 120 | 180 | 300;
export type Shape = 'build' | 'arc' | 'steady' | 'journey';
export type ComposePart = 'chords' | 'bass' | 'melody' | 'pulse' | 'bells';

/** A note of a given melody: start and length in seconds (from the melody's own start), MIDI pitch. */
export interface BriefNote {
  at: number;
  pitch: number;
  dur: number;
}

export type ComposeStart =
  { kind: 'none' } | { kind: 'progression'; name: string } | { kind: 'melody'; notes: BriefNote[] };

/** What to compose (PLAN M12). A missing field means Surprise me. */
export interface ComposeBrief {
  seed: number;
  mood?: Mood;
  length?: ComposeLength;
  shape?: Shape;
  parts?: ComposePart[];
  start?: ComposeStart;
  /** Tonic pitch class 0..11 (0 = C) and a scale name (core/scales). */
  key?: { tonic: number; mode: string };
  /** Beats per minute. */
  tempo?: number;
}

/** The answers in setup-screen order, for the UI. */
export const MOODS: readonly Mood[] = ['calm', 'bright', 'dreamy', 'dark', 'driving'];
export const LENGTHS: readonly ComposeLength[] = [60, 120, 180, 300];
export const SHAPES: readonly Shape[] = ['build', 'arc', 'steady', 'journey'];
export const PARTS: readonly ComposePart[] = ['chords', 'bass', 'melody', 'pulse', 'bells'];

export const MOOD_LABEL: Readonly<Record<Mood, string>> = {
  calm: 'Calm',
  bright: 'Bright',
  dreamy: 'Dreamy',
  dark: 'Dark',
  driving: 'Driving',
};
export const SHAPE_LABEL: Readonly<Record<Shape, string>> = {
  build: 'Build up',
  arc: 'Arc',
  steady: 'Steady',
  journey: 'Journey (A–B–A)',
};
export const PART_LABEL: Readonly<Record<ComposePart, string>> = {
  chords: 'Chords',
  bass: 'Bass',
  melody: 'Melody',
  pulse: 'Pulse',
  bells: 'Bells',
};

// ---------------------------------------------------------------------------------------------
// Named progressions
// ---------------------------------------------------------------------------------------------

/** A named chord progression ("Start from"). Numerals are ASCII on the major-scale ruler. */
export interface Progression {
  /** The id `start.name` uses, also shown: numerals with en dashes and ♭. */
  name: string;
  /** A short nickname for a tooltip. */
  nick: string;
  /** ASCII numerals, in order (core/theory). */
  chords: readonly string[];
  family: 'major' | 'minor';
  /** A modal progression's own mode (used when the key isn't given). */
  mode?: ScaleName;
}

export const PROGRESSIONS: readonly Progression[] = [
  { name: 'I–V–vi–IV', nick: 'Pop', chords: ['I', 'V', 'vi', 'IV'], family: 'major' },
  { name: 'vi–IV–I–V', nick: 'Sensitive', chords: ['vi', 'IV', 'I', 'V'], family: 'major' },
  { name: 'I–vi–IV–V', nick: 'Fifties', chords: ['I', 'vi', 'IV', 'V'], family: 'major' },
  { name: 'ii–V–I', nick: 'Jazz cadence', chords: ['ii', 'V', 'I'], family: 'major' },
  {
    name: 'I–V–vi–iii–IV–I–IV–V',
    nick: 'Pachelbel',
    chords: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'],
    family: 'major',
  },
  {
    name: 'i–♭VI–♭III–♭VII',
    nick: 'Epic minor',
    chords: ['i', 'bVI', 'bIII', 'bVII'],
    family: 'minor',
  },
  { name: 'i–iv–v', nick: 'Minor', chords: ['i', 'iv', 'v'], family: 'minor' },
  {
    name: 'i–♭VII–♭VI–V',
    nick: 'Andalusian',
    chords: ['i', 'bVII', 'bVI', 'V'],
    family: 'minor',
  },
  {
    name: 'i–IV',
    nick: 'Dorian vamp',
    chords: ['i', 'IV'],
    family: 'minor',
    mode: 'dorian',
  },
  {
    name: 'I–♭VII–IV–I',
    nick: 'Mixolydian',
    chords: ['I', 'bVII', 'IV', 'I'],
    family: 'major',
    mode: 'mixolydian',
  },
];

/** Folds a progression name for lookup: ♭ → b, any dash or space → '-', case kept (ii ≠ II). */
function foldName(s: string): string {
  return s
    .trim()
    .replace(/♭/g, 'b')
    .replace(/[\s–—-]+/g, '-');
}

/** The progression named `name` (as listed, or typed with b and hyphens), or null. */
export function progressionNamed(name: string): Progression | null {
  const f = foldName(name);
  return PROGRESSIONS.find((p) => foldName(p.name) === f || p.nick === name) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------------------------

/** Every mode the theory knows (core/theory `theoryOf` ≠ null): Surprise draws from these. */
export const COMPOSE_MODES: readonly ScaleName[] = [
  'major',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'aeolian',
  'harmonic-minor',
  'melodic-minor',
  'pentatonic-major',
  'pentatonic-minor',
  'blues',
];

/** Scales without chord theory, mapped to the nearest one that has it. */
const NO_THEORY: Readonly<Record<string, ScaleName>> = {
  locrian: 'phrygian',
  'whole-tone': 'lydian',
  chromatic: 'major',
  ionian: 'major',
  minor: 'aeolian',
};

const MINOR_MODES = new Set<string>([
  'dorian',
  'phrygian',
  'aeolian',
  'harmonic-minor',
  'melodic-minor',
  'pentatonic-minor',
  'blues',
]);

/** 'minor' when the mode's third is minor. */
export function modeFamily(mode: string): 'major' | 'minor' {
  return MINOR_MODES.has(mode) ? 'minor' : 'major';
}

/** One part's sound: the timbres a mood picks from. */
export type Sounds = Readonly<Record<ComposePart, readonly string[]>>;

/** What a mood narrows: the region the seed draws from. */
export interface MoodRegion {
  modes: readonly ScaleName[];
  bpm: readonly [number, number];
  density: readonly [number, number];
  /** Chord-change glide length (s) and the share of it that is stagger. */
  glide: readonly [number, number];
  /** Chance of seventh chords. */
  sevenths: number;
  /** Chance of 3/4. */
  waltz: number;
  /** Centre of the chord register (MIDI). */
  centre: readonly [number, number];
  /** How quick the figures are, 0 (held, unhurried) to 1 (busy). */
  pace: number;
  /** How much the textures lean on arpeggios (a weight among the other textures). */
  arp: number;
  sounds: Sounds;
}

export const MOOD_REGIONS: Readonly<Record<Mood, MoodRegion>> = {
  calm: {
    modes: ['major', 'lydian', 'pentatonic-major', 'mixolydian', 'dorian'],
    bpm: [60, 84],
    density: [0.15, 0.45],
    glide: [0.45, 0.9],
    sevenths: 0.4,
    waltz: 0.25,
    centre: [56, 62],
    pace: 0.2,
    arp: 0.15,
    sounds: {
      chords: ['glass', 'choir', 'organ'],
      bass: ['organ', 'sine'],
      melody: ['flute', 'reed', 'glass'],
      pulse: ['glass', 'bell', 'sine'],
      bells: ['bell', 'glass'],
    },
  },
  bright: {
    modes: ['major', 'lydian', 'mixolydian', 'pentatonic-major'],
    bpm: [96, 126],
    density: [0.45, 0.8],
    glide: [0.18, 0.4],
    sevenths: 0.15,
    waltz: 0.1,
    centre: [58, 65],
    pace: 0.8,
    arp: 0.6,
    sounds: {
      chords: ['epiano', 'glass', 'pluck'],
      bass: ['organ', 'pluck'],
      melody: ['reed', 'flute', 'brass'],
      pulse: ['pluck', 'marimba'],
      bells: ['bell', 'marimba'],
    },
  },
  dreamy: {
    modes: ['lydian', 'dorian', 'pentatonic-major', 'major', 'mixolydian'],
    bpm: [54, 76],
    density: [0.1, 0.4],
    glide: [0.8, 1.5],
    sevenths: 0.6,
    waltz: 0.3,
    centre: [57, 64],
    pace: 0.1,
    arp: 0.2,
    sounds: {
      chords: ['choir', 'glass', 'sine'],
      bass: ['sine', 'organ'],
      melody: ['flute', 'glass', 'sine'],
      pulse: ['glass', 'sine'],
      bells: ['bell', 'glass'],
    },
  },
  dark: {
    modes: ['aeolian', 'dorian', 'phrygian', 'harmonic-minor', 'pentatonic-minor'],
    bpm: [54, 80],
    density: [0.15, 0.45],
    glide: [0.4, 0.9],
    sevenths: 0.35,
    waltz: 0.15,
    centre: [49, 55],
    pace: 0,
    arp: 0.05,
    sounds: {
      chords: ['organ', 'choir', 'brass'],
      bass: ['organ', 'sine'],
      melody: ['reed', 'brass', 'sine'],
      pulse: ['organ', 'bell'],
      bells: ['bell'],
    },
  },
  driving: {
    modes: ['dorian', 'aeolian', 'mixolydian', 'pentatonic-minor', 'melodic-minor'],
    bpm: [112, 140],
    density: [0.6, 0.95],
    glide: [0.12, 0.28],
    sevenths: 0.1,
    waltz: 0,
    centre: [55, 62],
    pace: 1,
    arp: 0.45,
    sounds: {
      chords: ['brass', 'organ', 'epiano'],
      bass: ['organ', 'pluck'],
      melody: ['reed', 'brass', 'pluck'],
      pulse: ['pluck', 'marimba'],
      bells: ['marimba', 'bell'],
    },
  },
};

/** The unhurried moods: held textures, nothing faster than eighths, no bouncy sounds. */
export const SLOW_MOODS: readonly Mood[] = ['calm', 'dreamy', 'dark'];

/** Bouncy sounds: struck and quick to die, never on Chords or Pulse in an unhurried piece. */
export const BOUNCY: readonly string[] = ['pluck', 'marimba', 'epiano'];

/**
 * Moods a Surprise blend may mix (neighbours in mood space): the slow moods with each other,
 * Calm with Bright, Bright with Driving. Never Dark with Driving or Bright.
 */
const NEIGHBOURS: Readonly<Record<Mood, readonly Mood[]>> = {
  calm: ['dreamy', 'dark', 'bright'],
  bright: ['calm', 'driving'],
  dreamy: ['calm', 'dark'],
  dark: ['dreamy', 'calm'],
  driving: ['bright'],
};

/** The full ranges Surprise covers (the union of the moods'). */
export const TEMPO_RANGE: readonly [number, number] = [54, 140];
export const LENGTH_RANGE: readonly [Seconds, Seconds] = [60, 300];

/** Chance each part is in a Surprise piece (owner: frequent bells, a solid bass). */
const PART_CHANCE: Readonly<Record<ComposePart, number>> = {
  chords: 0.9,
  bass: 0.85,
  melody: 0.8,
  pulse: 0.55,
  bells: 0.7,
};

// ---------------------------------------------------------------------------------------------
// The resolved brief
// ---------------------------------------------------------------------------------------------

/** Points the energy curve is sampled at, x = i / (ENERGY_POINTS − 1). */
export const ENERGY_POINTS = 33;

/** Every setting the composer needs, each drawn inside the region its answer gave. */
export interface ResolvedBrief {
  seed: number;
  /** Mood weights (sum 1): one-hot for an answer, a blend of one or two moods for Surprise. */
  mood: Readonly<Record<Mood, number>>;
  /** The strongest mood (for the title). */
  moodName: Mood;
  /** Target length, s. */
  length: Seconds;
  /** Shape weights (sum 1), as for the mood. */
  shape: Readonly<Record<Shape, number>>;
  /** Energy 0..1 over the piece, sampled at ENERGY_POINTS points (see `energyAt`). */
  energy: readonly number[];
  /** The parts, in PARTS order. */
  parts: readonly ComposePart[];
  /** The named progression to build on, or null. */
  progression: Progression | null;
  /** The given melody (start.kind 'melody'), sorted, or null. */
  melody: readonly BriefNote[] | null;
  key: { tonic: number; mode: ScaleName };
  tempo: number;
  /** Beats per bar: 4 or 3. */
  meter: number;
  /** 0..1: how busy the textures are (rhythm, walk density, pulse rate). */
  density: number;
  /** 0..1: how quick the figures are (the mood blend's pace). */
  pace: number;
  /** The textures' lean on arpeggios (the mood blend's weight). */
  arp: number;
  /**
   * True when the slow moods (Calm, Dreamy, Dark) hold most of the blend: held and slow-moving
   * textures, nothing faster than eighths, no bouncy sounds on Chords or Pulse.
   */
  unhurried: boolean;
  /** Timbre per part. */
  sounds: Readonly<Record<ComposePart, string>>;
  /** Chord-change glide length (s) and its stagger (s). */
  glide: number;
  stagger: number;
  sevenths: boolean;
  /** Centre of the chord register (MIDI). */
  centre: number;
  /** Which fields were answered (not Surprise). */
  given: Readonly<
    Record<'mood' | 'length' | 'shape' | 'parts' | 'start' | 'key' | 'tempo', boolean>
  >;
}

/** The energy at x ∈ [0, 1] (linear between the samples). */
export function energyAt(r: Pick<ResolvedBrief, 'energy'>, x: number): number {
  const e = r.energy;
  const u = clamp(x, 0, 1) * (e.length - 1);
  const i = Math.min(e.length - 2, Math.floor(u));
  return lerp(e[i], e[i + 1], u - i);
}

/** x^p for x ≥ 0 (portable). */
function powf(x: number, p: number): number {
  return x <= 0 ? 0 : exp2(p * log2(x));
}

/** Smooth 0 → 1 over [a, b]. */
function smooth(x: number, a: number, b: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** One shape's curve, its parameters drawn by `u` (values in [0, 1)). */
function shapeCurve(shape: Shape, u: (i: number) => number): (x: number) => number {
  switch (shape) {
    case 'build': {
      const lo = 0.12 + 0.18 * u(0);
      const hi = 0.85 + 0.15 * u(1);
      const p = 0.8 + 0.9 * u(2);
      // Rises to the last section; the outro settles a little.
      return (x) => lerp(lo, hi, powf(Math.min(1, x / 0.9), p)) - 0.25 * smooth(x, 0.92, 1);
    }
    case 'arc': {
      const lo = 0.12 + 0.18 * u(0);
      const hi = 0.85 + 0.15 * u(1);
      const c = 0.5 + 0.22 * u(2);
      return (x) => {
        const d = x < c ? (c - x) / c : (x - c) / (1 - c);
        return lerp(lo, hi, (1 + cosPi(d)) / 2);
      };
    }
    case 'steady': {
      const m = 0.45 + 0.25 * u(0);
      const w = 0.04 + 0.06 * u(1);
      const f = 2 + Math.floor(3 * u(2));
      // A gentle in and out, otherwise level.
      return (x) => (m + w * sinPi(2 * f * x)) * (0.75 + 0.25 * smooth(x, 0, 0.12));
    }
    case 'journey': {
      const a = 0.4 + 0.2 * u(0);
      // B contrasts: up or down by 0.25–0.4.
      const dir = u(1) < 0.6 ? 1 : -1;
      const b = clamp(a + dir * (0.25 + 0.15 * u(2)), 0.1, 1);
      const s0 = 0.34 + 0.06 * u(3);
      const s1 = 0.64 + 0.06 * u(4);
      return (x) => {
        const inB = smooth(x, s0 - 0.03, s0 + 0.03) * (1 - smooth(x, s1 - 0.03, s1 + 0.03));
        return lerp(a, b, inB);
      };
    }
  }
}

/** Seeded draws for `resolveBrief`, keyed by decision name. */
function drawer(seed: number): (stream: string, i?: number) => number {
  return (stream, i = 0) => rand(seed, stream, i, Purpose.Compose);
}

/** Index drawn from weights `w` by u ∈ [0, 1). */
export function pickIndex(w: readonly number[], u: number): number {
  let sum = 0;
  for (const x of w) sum += x;
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i] / sum;
    if (u < acc) return i;
  }
  return w.length - 1;
}

function oneHot<T extends string>(all: readonly T[], k: T): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const a of all) out[a] = a === k ? 1 : 0;
  return out;
}

/** One label, or a blend of two (Surprise; `near` limits the second label): weights summing to 1. */
function blend<T extends string>(
  all: readonly T[],
  d: (s: string) => number,
  tag: string,
  near?: Readonly<Record<T, readonly T[]>>,
): Record<T, number> {
  const a = all[Math.floor(d(`${tag}-a`) * all.length)];
  if (d(`${tag}-pure`) < 0.3) return oneHot(all, a);
  let b = all[Math.floor(d(`${tag}-b`) * (all.length - 1))];
  if (b === a) b = all[all.length - 1];
  // Not a neighbour: one of a's neighbours instead.
  if (near && !near[a].includes(b)) b = near[a][Math.floor(d(`${tag}-near`) * near[a].length)];
  const t = d(`${tag}-t`);
  const out = oneHot(all, a);
  out[a] = 1 - t;
  out[b] = t;
  return out;
}

/** The strongest label of a blend. */
function strongest<T extends string>(all: readonly T[], w: Readonly<Record<T, number>>): T {
  let best = all[0];
  for (const a of all) if (w[a] > w[best]) best = a;
  return best;
}

/** A weighted mean of the moods' ranges, then a draw in it. */
function inBlend(
  w: Readonly<Record<Mood, number>>,
  range: (r: MoodRegion) => readonly [number, number],
  u: number,
): number {
  let lo = 0;
  let hi = 0;
  for (const m of MOODS) {
    const [a, b] = range(MOOD_REGIONS[m]);
    lo += w[m] * a;
    hi += w[m] * b;
  }
  return lerp(lo, hi, u);
}

/** A mood drawn from the blend's weights. */
function moodOf(w: Readonly<Record<Mood, number>>, u: number): Mood {
  return MOODS[
    pickIndex(
      MOODS.map((m) => w[m]),
      u,
    )
  ];
}

/** True when every chord of `p` is one of the mode's own (not a borrowed Surprise). */
export function progressionFits(p: Progression, mode: ScaleName): boolean {
  const th = theoryOf({ tonic: 'C', scale: mode });
  // Pentatonic and blues keys are judged against their parent scale (as core/theory does).
  const parent =
    mode === 'pentatonic-major'
      ? 'major'
      : mode === 'pentatonic-minor' || mode === 'blues'
        ? 'aeolian'
        : mode;
  const scale = new Set(SCALES[parent]);
  return (
    th !== null &&
    th.family === p.family &&
    p.chords.every((n) => {
      const c = chordOf(th, n);
      return c !== undefined && c.triad.every((pc) => scale.has(pc));
    })
  );
}

/** A theory mode for `mode` (an unknown or theory-less scale maps to the nearest). */
export function composeMode(mode: string): ScaleName {
  if ((COMPOSE_MODES as readonly string[]).includes(mode)) return mode as ScaleName;
  return NO_THEORY[mode] ?? 'major';
}

/**
 * Every setting, from the answers and the seed. Deterministic. Answered fields are kept (the key's
 * mode mapped to one with chord theory; the tempo clamped to 40–200); the rest are drawn.
 */
export function resolveBrief(brief: ComposeBrief): ResolvedBrief {
  const seed = Math.trunc(Number.isFinite(brief.seed) ? brief.seed : 0) >>> 0;
  const d = drawer(seed);
  const given = {
    mood: brief.mood !== undefined && brief.mood in MOOD_REGIONS,
    length: brief.length !== undefined && Number.isFinite(brief.length) && brief.length > 0,
    shape: brief.shape !== undefined && SHAPES.includes(brief.shape),
    parts: Array.isArray(brief.parts) && brief.parts.some((p) => PARTS.includes(p)),
    start: brief.start !== undefined && brief.start.kind !== 'none',
    key: brief.key !== undefined && Number.isFinite(brief.key.tonic),
    tempo: brief.tempo !== undefined && Number.isFinite(brief.tempo) && brief.tempo > 0,
  };

  // Mood: one region, or a blend of neighbours (one point in mood space, from which the mode,
  // sounds, tempo and pace all follow, so the title's mood is what you hear).
  const mood = given.mood
    ? oneHot(MOODS, brief.mood!)
    : blend(MOODS, (s) => d(s), 'mood', NEIGHBOURS);
  const moodName = strongest(MOODS, mood);
  let slow = 0;
  for (const m of SLOW_MOODS) slow += mood[m];
  const unhurried = slow >= 0.5;

  // Start.
  const progression =
    brief.start?.kind === 'progression' ? progressionNamed(brief.start.name) : null;
  let melody: BriefNote[] | null = null;
  if (brief.start?.kind === 'melody') {
    melody = brief.start.notes
      .filter(
        (n) =>
          Number.isFinite(n.at) && Number.isFinite(n.pitch) && Number.isFinite(n.dur) && n.dur > 0,
      )
      .map((n) => ({ at: n.at, pitch: Math.round(n.pitch), dur: n.dur }))
      .sort((a, b) => a.at - b.at);
    if (melody.length === 0) melody = null;
  }

  // Key: answered, or from the melody, or drawn (mostly from the mood's modes, sometimes any).
  let key: { tonic: number; mode: ScaleName };
  if (given.key) {
    key = {
      tonic: ((Math.round(brief.key!.tonic) % 12) + 12) % 12,
      mode: composeMode(brief.key!.mode),
    };
  } else if (melody) {
    key = keyOfMelody(melody, mood);
  } else {
    let mode: ScaleName;
    const family = progression?.family;
    if (progression?.mode) mode = progression.mode;
    else {
      let pool =
        !given.mood && d('mode-any') < 0.25
          ? COMPOSE_MODES
          : MOOD_REGIONS[moodOf(mood, d('mode-mood'))].modes;
      // Dark is minor and Bright major, whatever the blend drew.
      const fam = moodName === 'dark' ? 'minor' : moodName === 'bright' ? 'major' : null;
      if (fam && !given.mood) {
        const same = pool.filter((m) => modeFamily(m) === fam);
        pool = same.length > 0 ? same : MOOD_REGIONS[moodName].modes;
      }
      // A named progression: a mode whose own chords it uses (Pop in major, not Lydian).
      const fit = progression ? pool.filter((m) => progressionFits(progression, m)) : pool;
      const list =
        fit.length > 0 ? fit : family === 'minor' ? (['aeolian'] as const) : (['major'] as const);
      mode = list[Math.floor(d('mode') * list.length)];
    }
    key = { tonic: Math.floor(d('tonic') * 12), mode };
  }

  const tempo = given.tempo
    ? clamp(brief.tempo!, 40, 200)
    : melody
      ? tempoOfMelody(melody, mood)
      : Math.round(inBlend(mood, (r) => r.bpm, d('tempo')));
  const meter = d('meter') < inBlend(mood, (r) => [r.waltz, r.waltz], 0) ? 3 : 4;
  const density = inBlend(mood, (r) => r.density, d('density'));
  const length = given.length
    ? brief.length!
    : Math.round(LENGTH_RANGE[0] * exp2(d('length') * log2(LENGTH_RANGE[1] / LENGTH_RANGE[0])));

  // Shape → energy curve.
  const shape = given.shape ? oneHot(SHAPES, brief.shape!) : blend(SHAPES, (s) => d(s), 'shape');
  const curves = SHAPES.filter((s) => shape[s] > 0).map((s) => ({
    w: shape[s],
    f: shapeCurve(s, (i) => d(`shape-${s}`, i)),
  }));
  const energy = Array.from({ length: ENERGY_POINTS }, (_, i) => {
    const x = i / (ENERGY_POINTS - 1);
    let e = 0;
    for (const c of curves) e += c.w * c.f(x);
    return Math.round(clamp(e, 0.05, 1) * 1000) / 1000;
  });

  // Parts.
  let parts: ComposePart[];
  if (given.parts) parts = PARTS.filter((p) => brief.parts!.includes(p));
  else {
    parts = PARTS.filter((p) => d(`part-${p}`) < PART_CHANCE[p]);
    // At least two, one of them carrying the harmony.
    if (!parts.some((p) => p === 'chords' || p === 'bass' || p === 'pulse'))
      parts.unshift(d('part-h') < 0.7 ? 'chords' : 'pulse');
    for (const p of ['bass', 'melody', 'bells'] as const)
      if (parts.length < 2 && !parts.includes(p)) parts.push(p);
    parts = PARTS.filter((p) => parts.includes(p));
  }
  // A given melody is kept, so it has its part.
  if (melody && !parts.includes('melody'))
    parts = PARTS.filter((p) => p === 'melody' || parts.includes(p));

  // Sounds: per part, from a mood of the blend (any mood's sounds, sometimes: any slow mood's
  // when the piece is unhurried). No bouncy chords or pulse in an unhurried piece.
  const sounds = {} as Record<ComposePart, string>;
  const anyOf = unhurried ? SLOW_MOODS : MOODS;
  for (const p of PARTS) {
    const m =
      d(`sound-any-${p}`) < 0.2 && !given.mood
        ? anyOf[Math.floor(d(`sound-m-${p}`) * anyOf.length)]
        : moodOf(mood, d(`sound-m-${p}`));
    let list = MOOD_REGIONS[m].sounds[p];
    if (unhurried && (p === 'chords' || p === 'pulse') && list.some((x) => BOUNCY.includes(x)))
      list = MOOD_REGIONS[moodName].sounds[p];
    sounds[p] = list[Math.floor(d(`sound-${p}`) * list.length)];
  }

  const glide = Math.round(inBlend(mood, (r) => r.glide, d('glide')) * 100) / 100;
  const stagger = Math.round(glide * (0.15 + 0.25 * d('stagger')) * 100) / 100;
  const sevenths = d('sevenths') < inBlend(mood, (r) => [r.sevenths, r.sevenths], 0);
  const centre = Math.round(inBlend(mood, (r) => r.centre, d('centre')));
  const pace = inBlend(mood, (r) => [r.pace, r.pace], 0);
  const arp = inBlend(mood, (r) => [r.arp, r.arp], 0);

  return {
    seed,
    mood,
    moodName,
    length,
    shape,
    energy,
    parts,
    progression,
    melody,
    key,
    tempo,
    meter,
    density: Math.round(density * 1000) / 1000,
    pace: Math.round(pace * 1000) / 1000,
    arp: Math.round(arp * 1000) / 1000,
    unhurried,
    sounds,
    glide,
    stagger,
    sevenths,
    centre,
    given,
  };
}

/** The key that best holds a melody: duration-weighted scale fit, plus tonic at the ends. */
function keyOfMelody(
  notes: readonly BriefNote[],
  mood: Readonly<Record<Mood, number>>,
): { tonic: number; mode: ScaleName } {
  const w = new Array<number>(12).fill(0);
  for (const n of notes) w[((n.pitch % 12) + 12) % 12] += n.dur;
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const first = ((notes[0].pitch % 12) + 12) % 12;
  const last = ((notes[notes.length - 1].pitch % 12) + 12) % 12;
  // Seven-note modes first (a pentatonic fits any subset too easily); the mood's modes win ties.
  const modes: ScaleName[] = [
    'major',
    'aeolian',
    'dorian',
    'mixolydian',
    'lydian',
    'phrygian',
    'harmonic-minor',
  ];
  let best = { tonic: 0, mode: 'major' as ScaleName };
  let bestS = -Infinity;
  for (const mode of modes) {
    const iv = SCALES[mode];
    let moodW = 0;
    for (const m of MOODS) if (MOOD_REGIONS[m].modes.includes(mode)) moodW += mood[m];
    for (let tonic = 0; tonic < 12; tonic++) {
      let s = 0;
      for (let pc = 0; pc < 12; pc++) if (iv.includes((pc - tonic + 12) % 12)) s += w[pc];
      s /= total;
      if (last === tonic) s += 0.08;
      if (first === tonic) s += 0.04;
      s += 0.02 * moodW + (mode === 'major' || mode === 'aeolian' ? 0.01 : 0);
      if (s > bestS + 1e-9) {
        bestS = s;
        best = { tonic, mode };
      }
    }
  }
  return best;
}

/** A tempo whose eighth grid the melody's onsets sit on best (inside the mood's range when tied). */
function tempoOfMelody(notes: readonly BriefNote[], mood: Readonly<Record<Mood, number>>): number {
  const t0 = notes[0].at;
  let centre = 0;
  for (const m of MOODS)
    centre += mood[m] * (MOOD_REGIONS[m].bpm[0] + MOOD_REGIONS[m].bpm[1]) * 0.5;
  let best = Math.round(centre);
  let bestCost = Infinity;
  for (let bpm = TEMPO_RANGE[0]; bpm <= TEMPO_RANGE[1]; bpm++) {
    const eighth = 30 / bpm;
    let cost = 0;
    for (const n of notes) {
      for (const t of [n.at - t0, n.at - t0 + n.dur]) {
        const u = t / eighth;
        cost += Math.abs(u - Math.round(u));
      }
    }
    cost = cost / (2 * notes.length) + Math.abs(bpm - centre) / 2000;
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = bpm;
    }
  }
  return best;
}
