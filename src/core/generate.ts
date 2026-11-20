/**
 * The prototype composer, ported to emit moments (PLAN.md §11.3 "Generate", §15 M1).
 *
 * `compose()` in prototype/glissando-score.html writes curves directly. This port keeps its
 * eight-section form and its harmony and register logic, but writes *moments*, so a generated
 * piece is fully editable and is realised by the compiler (stagger, jitter, births, walk steps
 * and crossing rules all live there now).
 *
 *   Seed    one voice holds the root (A3)                    start: v1 at 57
 *   Split   1 → 3 → 5 → 8 → 12 voices on changing chords      4 × split (explicit pitches)
 *   Drift   six chord changes, the register wandering         6 × chord (scale degrees + register)
 *   Gather  everyone to one chord tone                        unison
 *   Burst   a low bass note plus a fan of upper voices       chord (explicit pitches)
 *   Walk    independent stepwise lines, bass leaps           walk (24 ticks, 1 s grid)
 *   Thin    the voices collapse onto three-note chords       2 × chord (explicit pitches)
 *   Home    everyone back to the root                        unison
 *
 * Randomness comes from counter-based draws keyed by the seed (core/rng), never Math.random, so
 * the same seed and options always give the same piece. The keys do not include the mode, so
 * switching mode keeps the timing and chord-degree sequence of a 7-note mode, as in the prototype.
 */

import {
  DEFAULT_START_PITCH,
  builtinTimbresFor,
  defaultGlide,
  defaultMix,
  defaultView,
  defaultVoices,
  DEFAULT_END_FADE,
  DEFAULT_TIMESTAMP,
} from './defaults';
import { mod } from './math';
import { Purpose, base62Id, mix32, rand } from './rng';
import { SCALES } from './scales';
import {
  MAX_VOICES,
  PIECE_FORMAT,
  PIECE_VERSION,
  type Glide,
  type Moment,
  type Piece,
  type Pitch,
  type ScaleName,
  type Seconds,
} from './types';

/** The prototype's four modes. */
export type GenerateMode = 'dorian' | 'aeolian' | 'lydian' | 'pentatonic';

/** Options for `generate`. */
export interface GenerateOptions {
  /** Scale on A. */
  mode: GenerateMode;
  /**
   * Target length in seconds. The Drift section gets more or fewer chords and the Walk more or
   * fewer ticks; every section is kept, so the piece is never shorter than about 100 s. Absent:
   * the prototype's proportions (6 drift chords, 24 walk ticks, about 2.5 minutes).
   */
  length?: Seconds;
  /** Pool size and final active-voice count, 2..32. @default 12 */
  voices?: number;
  /** Walk density: probability that a voice steps on a tick, 0..1. @default 0.45 */
  density?: number;
  /** ISO 8601 time for `meta.created`/`modified`; core has no clock (§8.10). */
  now?: string;
}

/** A moment without its id (distributes over the union, unlike a plain Omit). */
type NewMoment = Moment extends infer M ? (M extends Moment ? Omit<M, 'id'> : never) : never;

/** The prototype's section names, in order. */
export const SECTION_NAMES = [
  'Seed',
  'Split',
  'Drift',
  'Gather',
  'Burst',
  'Walk',
  'Thin',
  'Home',
] as const;
/** One of `SECTION_NAMES`. */
export type SectionName = (typeof SECTION_NAMES)[number];

/** Where a section starts. Its first moment (none for Seed) carries the name as its label. */
export interface GeneratedSection {
  name: SectionName;
  at: Seconds;
}

// ---------------------------------------------------------------------------------------------
// The prototype's constants
// ---------------------------------------------------------------------------------------------

/** A3: the tonic and the Seed/Home pitch. */
const ROOT: Pitch = DEFAULT_START_PITCH;
/** The prototype's register, which is also every generated voice's range. */
const LOW: Pitch = 38;
const HIGH: Pitch = 84;
/** Centre of the voicings: a whole tone above the root. */
const CENTER: Pitch = ROOT + 2;
/** The prototype's voice count; the split stages below are for 12 voices. */
const PROTOTYPE_VOICES = 12;
const SPLIT_STAGES = [3, 5, 8, 12];
const DEFAULT_DRIFTS = 6;
const DEFAULT_TICKS = 24;
const WALK_GRID = 1;
const DEFAULT_DENSITY = 0.45;

const MODE_SCALE: Record<GenerateMode, ScaleName> = {
  dorian: 'dorian',
  aeolian: 'aeolian',
  lydian: 'lydian',
  pentatonic: 'pentatonic-major',
};
const MODE_TITLE: Record<GenerateMode, string> = {
  dorian: 'Dorian',
  aeolian: 'Aeolian',
  lydian: 'Lydian',
  pentatonic: 'Pentatonic',
};

/**
 * Each prototype `retarget` drew durations uniformly from [a, b] and start offsets from
 * [0, stagger]; as a glide that is length (a + b)/2, jitter (b − a)/(a + b), and the stagger.
 */
function glideOf(stagger: Seconds, a: Seconds, b: Seconds): Partial<Glide> {
  return { length: round3((a + b) / 2), jitter: round3((b - a) / (a + b)), stagger };
}

/** Rounds to milliseconds (or thousandths), so files stay tidy. Exact and portable. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------------------------

/** The split stages for `n` voices: the prototype's 3, 5, 8, 12 scaled to n, ending at n. */
export function splitStages(n: number): number[] {
  const out: number[] = [];
  for (const k of SPLIT_STAGES) {
    const s = Math.min(n, Math.round((k * n) / PROTOTYPE_VOICES));
    if (s >= 2 && (out.length === 0 || s > out[out.length - 1])) out.push(s);
  }
  if (out[out.length - 1] !== n) out.push(n);
  return out;
}

/** Drift chords and walk ticks for a target length (see GenerateOptions.length). */
function sectionSizes(length: Seconds | undefined): { drifts: number; ticks: number } {
  if (length === undefined || !Number.isFinite(length)) {
    return { drifts: DEFAULT_DRIFTS, ticks: DEFAULT_TICKS };
  }
  // The fixed sections take about 89.5 s; a drift chord about 6.9 s; a walk tick 1 s. The
  // prototype splits the rest 63 : 37 between them.
  const extra = Math.max(0, length - 89.5);
  return {
    drifts: Math.max(1, Math.round((extra * 0.63) / 6.9)),
    ticks: Math.max(4, Math.round(extra * 0.37)),
  };
}

/** `generate`, also returning where each section starts (for tests and the Generate panel). */
export function generateWithSections(
  seed: number,
  opts: GenerateOptions = { mode: 'dorian' },
): { piece: Piece; sections: GeneratedSection[] } {
  const pieceSeed = Math.trunc(Number.isFinite(seed) ? seed : 0) >>> 0;
  const mode: GenerateMode = opts.mode in MODE_SCALE ? opts.mode : 'dorian';
  const n = Math.max(2, Math.min(MAX_VOICES, Math.round(opts.voices ?? PROTOTYPE_VOICES)));
  const density = Math.max(0, Math.min(1, opts.density ?? DEFAULT_DENSITY));
  const { drifts, ticks } = sectionSizes(opts.length);

  /** A keyed draw in [0, 1): stream and index name the decision. */
  const draw = (stream: string, i: number, purpose: Purpose): number =>
    rand(pieceSeed, stream, i, purpose);

  // Harmony, as in the prototype: chords are stacks of thirds on scale degree c.
  const steps = SCALES[MODE_SCALE[mode]];
  const S = steps.length;
  const pcOf = (p: Pitch): number => mod(p - ROOT, 12);
  const tones: Pitch[] = [];
  for (let p = LOW; p <= HIGH; p++) if (steps.includes(pcOf(p))) tones.push(p);
  const deg = (p: Pitch): number => steps.indexOf(pcOf(p));
  const chordDegrees = (c: number): number[] => [c, c + 2, c + 4, c + 6];
  const chordPool = (c: number): Pitch[] => {
    const set = new Set(chordDegrees(c).map((d) => d % S));
    return tones.filter((p) => set.has(deg(p)));
  };
  /** The nearest pool pitch to x; ties keep the lower one (the prototype's reduce). */
  const nearestIn = (pool: Pitch[], x: Pitch): Pitch =>
    pool.reduce((b, p) => (Math.abs(p - x) < Math.abs(b - x) ? p : b), pool[0]);
  /** The register the prototype's voicing() draws k notes from, and whether it fell back. */
  const registerFor = (c: number, k: number, center: Pitch, extra = 0): [Pitch, Pitch] => {
    const span = Math.min(HIGH - LOW, 6 + k * 3.3 + extra);
    let lo = center - span / 2;
    let hi = center + span / 2;
    if (lo < LOW) {
      hi += LOW - lo;
      lo = LOW;
    }
    if (hi > HIGH) {
      lo -= hi - HIGH;
      hi = HIGH;
    }
    const inside = chordPool(c).filter((p) => p >= lo && p <= hi);
    return inside.length < 2 ? [LOW, HIGH] : [Math.ceil(lo), Math.floor(hi)];
  };
  /** The prototype's voicing(): k evenly spaced chord tones in the register around center. */
  const voicing = (c: number, k: number, center: Pitch, extra = 0): Pitch[] => {
    if (k === 1) return [nearestIn(chordPool(c), center)];
    const [lo, hi] = registerFor(c, k, center, extra);
    const pool = chordPool(c).filter((p) => p >= lo && p <= hi);
    return Array.from({ length: k }, (_, i) => pool[Math.round((i * (pool.length - 1)) / (k - 1))]);
  };
  const MOVES = S === 7 ? [3, 4, 3, 4, 5, 2, -2, 1] : [1, 2, 3, -1, -2];
  let chordStep = 0;
  const nextChord = (c: number): number => {
    const step = chordStep++;
    for (let attempt = 0; ; attempt++) {
      const move =
        MOVES[Math.floor(draw('chord', step * 16 + attempt, Purpose.GenChord) * MOVES.length)];
      const next = mod(c + move, S);
      if (next !== c || attempt > 64) return next;
    }
  };

  // Moments, with deterministic, unique 6-character ids.
  const moments: Moment[] = [];
  const usedIds = new Set<string>();
  const nextId = (): string => {
    for (let attempt = 0; ; attempt++) {
      const id = base62Id(mix32(pieceSeed, moments.length, attempt, Purpose.GenId));
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
  };
  const sections: GeneratedSection[] = [];
  let pendingLabel: SectionName | null = null;
  const mark = (name: SectionName, at: Seconds): void => {
    sections.push({ name, at: round3(at) });
    pendingLabel = name;
  };
  /** Adds a moment; the first one of a section is labelled with the section's name. */
  const add = (m: NewMoment): void => {
    const moment = { id: nextId(), ...m } as Moment;
    moment.at = round3(moment.at);
    if (pendingLabel !== null) {
      moment.label = pendingLabel;
      pendingLabel = null;
    }
    moments.push(moment);
  };

  let t = 0;
  let c = 0;

  mark('Seed', 0);
  t = 8 + draw('seed', 0, Purpose.GenTiming) * 2;

  mark('Split', t);
  splitStages(n).forEach((k, j) => {
    add({
      type: 'split',
      at: t,
      count: k,
      notes: { kind: 'pitches', pitches: voicing(c, k, CENTER) },
      voicing: 'even',
      glide: glideOf(0.5, 2.6, 3.8),
    });
    t += 7 + draw('split', j, Purpose.GenTiming) * 1.5;
    c = nextChord(c);
  });

  mark('Drift', t);
  for (let i = 0; i < drifts; i++) {
    const center = CENTER + Math.round((draw('drift', i, Purpose.GenRegister) - 0.5) * 6);
    add({
      type: 'chord',
      at: t,
      notes: { kind: 'degrees', degrees: chordDegrees(c) },
      voicing: 'even',
      register: registerFor(c, n, center),
      assign: 'ordered',
      glide: glideOf(1.4, 2.2, 4),
    });
    t += 5.8 + draw('drift', i, Purpose.GenTiming) * 2.2;
    c = nextChord(c);
  }

  mark('Gather', t);
  add({
    type: 'unison',
    at: t,
    pitch: nearestIn(chordPool(c), CENTER),
    octaves: false,
    glide: glideOf(0.9, 3.6, 5),
  });
  t += 9.5;

  // Burst out to a bass note plus n − 1 upper voices, leaving the bass room to leap.
  mark('Burst', t);
  c = nextChord(c);
  const bass = tones.find((p) => deg(p) === c) ?? tones[0];
  add({
    type: 'chord',
    at: t,
    notes: { kind: 'pitches', pitches: [bass, ...voicing(c, n - 1, CENTER + 6, -10)] },
    voicing: 'even',
    assign: 'ordered',
    glide: glideOf(0.25, 1.1, 1.9),
  });
  t += 7;

  // Each tick a random subset of voices steps one or two scale tones, never touching or crossing;
  // the lowest voice leaps 5–12 semitones instead. Steps last 0.22–0.32 s and start up to 0.1 s
  // into the tick.
  mark('Walk', t);
  add({
    type: 'walk',
    at: t,
    until: round3(t + ticks * WALK_GRID),
    grid: WALK_GRID,
    density,
    steps: [-2, -1, 1, 2],
    stepGlide: 0.27,
    bass: { leap: [5, 12] },
    glide: { stagger: 0.1, jitter: round3(0.05 / 0.27) },
  });
  t += ticks * WALK_GRID + 1.5;

  // Three-note chords, the voices split into three equal groups (low, middle, high).
  mark('Thin', t);
  for (let i = 0; i < 2; i++) {
    c = nextChord(c);
    const pool = chordPool(c);
    const tri = [
      nearestIn(pool, CENTER - 11),
      nearestIn(pool, CENTER),
      nearestIn(pool, CENTER + 10),
    ];
    add({
      type: 'chord',
      at: t,
      notes: {
        kind: 'pitches',
        pitches: Array.from({ length: n }, (_, j) => tri[Math.min(2, Math.floor((j * 3) / n))]),
      },
      voicing: 'even',
      assign: 'ordered',
      glide: glideOf(1.3, 3, 5),
    });
    t += 9;
  }

  mark('Home', t);
  add({ type: 'unison', at: t, pitch: ROOT, octaves: false, glide: glideOf(1, 4, 6.5) });
  t += 13.5;

  const voices = defaultVoices(n);
  for (const v of voices) v.range = [LOW, HIGH];
  const now = opts.now ?? DEFAULT_TIMESTAMP;
  const piece: Piece = {
    format: PIECE_FORMAT,
    version: PIECE_VERSION,
    meta: { title: `${MODE_TITLE[mode]} ${pieceSeed}`, created: now, modified: now },
    seed: pieceSeed,
    tuning: { referenceHz: 440, system: { kind: '12tet' } },
    key: { tonic: 'A', scale: MODE_SCALE[mode] },
    defaults: { glide: defaultGlide() },
    voices,
    start: [{ voice: voices[0].id, pitch: ROOT }],
    moments,
    timbres: builtinTimbresFor(voices),
    mix: defaultMix(),
    end: { at: round3(t), fade: DEFAULT_END_FADE },
    view: defaultView(),
  };
  return { piece, sections };
}

/**
 * Generates a piece made of moments from a seed (§11.3): the prototype composer's eight
 * sections. Deterministic: the same seed and options give the same piece. The seed is taken
 * modulo 2³² and becomes the piece seed.
 */
export function generate(seed: number, opts: GenerateOptions = { mode: 'dorian' }): Piece {
  return generateWithSections(seed, opts).piece;
}
