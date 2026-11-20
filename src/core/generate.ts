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
   * Target length in seconds. From 100 s up, the Drift section gets more or fewer chords and the
   * Walk more or fewer ticks, and every section is kept. Below 100 s (floored at 30 s) the piece
   * is a short form: sections are dropped and the timing tightened (see `shortPlan`). Absent: the
   * prototype's proportions (6 drift chords, 24 walk ticks, about 2.5 minutes).
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

/** Below this target length `generate` uses the short form; at or above, the full form. */
export const SHORT_FORM_BELOW: Seconds = 100;
/** The shortest target the short form aims for; shorter requests are treated as this. */
export const SHORT_FORM_MIN: Seconds = 30;
/** The short form's tightest time scale (at 30 s); it rises linearly to 1 at 100 s. */
const SHORT_SCALE_MIN = 0.75;
/** Walk ticks in a short form's development. */
const SHORT_TICKS = 4;

/** What a piece contains and how tightly it is timed. */
interface FormPlan {
  /** Indices into splitStages(n), ascending. */
  splits: number[];
  drifts: number;
  /** Gather, Burst and Walk. */
  development: boolean;
  ticks: number;
  thins: number;
  /** Multiplies every section gap and every glide's length and stagger (not the walk's ticks). */
  scale: number;
}

/**
 * The short form for `length` < SHORT_FORM_BELOW. Seed, Split (to the full voice count) and Home
 * are always there; then, while they fit at the target scale, in this order: a Drift chord, a
 * middle split stage, a Thin chord, the Gather–Burst–Walk development (4 ticks), more split
 * stages, Drift and Thin chords, then extra Drift chords. The time scale is then solved so the
 * piece ends exactly at the target. Gaps are at least 5.8 s × 0.75 ≈ 4.35 s.
 */
function shortPlan(
  length: Seconds,
  stageCount: number,
  draw: (stream: string, i: number, purpose: Purpose) => number,
): FormPlan {
  const L = Math.max(SHORT_FORM_MIN, length);
  const target =
    SHORT_SCALE_MIN +
    (1 - SHORT_SCALE_MIN) * Math.min(1, (L - SHORT_FORM_MIN) / (SHORT_FORM_BELOW - SHORT_FORM_MIN));
  const splitGap = (j: number): Seconds => 7 + draw('split', j, Purpose.GenTiming) * 1.5;
  const driftGap = (i: number): Seconds => 5.8 + draw('drift', i, Purpose.GenTiming) * 2.2;

  // Split stages join in this order: the last (the full count), then middle-out.
  const last = stageCount - 1;
  const stageOrder = [
    last,
    ...Array.from({ length: last }, (_, i) => i).sort(
      (a, b) => Math.abs(a - (last - 1) / 2) - Math.abs(b - (last - 1) / 2) || a - b,
    ),
  ];
  const plan: FormPlan = {
    splits: [last],
    drifts: 0,
    development: false,
    ticks: SHORT_TICKS,
    thins: 0,
    scale: 1,
  };
  let raw = 8 + draw('seed', 0, Purpose.GenTiming) * 2 + splitGap(last) + 13.5;
  let fixed = 0;
  const fits = (r: Seconds, f = 0): boolean => (raw + r) * target + fixed + f <= L;

  const tryDrift = (): boolean => {
    const r = driftGap(plan.drifts);
    if (!fits(r)) return false;
    raw += r;
    plan.drifts++;
    return true;
  };
  const trySplit = (): void => {
    const j = stageOrder[plan.splits.length];
    if (j === undefined || !fits(splitGap(j))) return;
    raw += splitGap(j);
    plan.splits.push(j);
  };
  const tryThin = (): void => {
    if (plan.thins < 2 && fits(9)) {
      raw += 9;
      plan.thins++;
    }
  };
  const tryDevelopment = (): void => {
    const r = 9.5 + 7 + 1.5;
    if (!fits(r, SHORT_TICKS * WALK_GRID)) return;
    raw += r;
    fixed += SHORT_TICKS * WALK_GRID;
    plan.development = true;
  };

  tryDrift();
  trySplit();
  tryThin();
  tryDevelopment();
  trySplit();
  tryDrift();
  tryThin();
  trySplit();
  while (tryDrift());

  plan.splits.sort((a, b) => a - b);
  plan.scale = (L - fixed) / raw;
  return plan;
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
  /** A keyed draw in [0, 1): stream and index name the decision. */
  const draw = (stream: string, i: number, purpose: Purpose): number =>
    rand(pieceSeed, stream, i, purpose);

  const stages = splitStages(n);
  const short = opts.length !== undefined && opts.length < SHORT_FORM_BELOW;
  const plan: FormPlan = short
    ? shortPlan(opts.length ?? SHORT_FORM_MIN, stages.length, draw)
    : {
        splits: stages.map((_, j) => j),
        ...sectionSizes(opts.length),
        development: true,
        thins: 2,
        scale: 1,
      };
  const { drifts, ticks, scale: s } = plan;
  /** glideOf with the plan's time scale (exact at scale 1). */
  const glide = (stagger: Seconds, a: Seconds, b: Seconds): Partial<Glide> =>
    glideOf(stagger * s, a * s, b * s);

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

  let c = 0;

  mark('Seed', 0);
  let t = (8 + draw('seed', 0, Purpose.GenTiming) * 2) * s;

  mark('Split', t);
  for (const j of plan.splits) {
    const k = stages[j];
    add({
      type: 'split',
      at: t,
      count: k,
      notes: { kind: 'pitches', pitches: voicing(c, k, CENTER) },
      voicing: 'even',
      glide: glide(0.5, 2.6, 3.8),
    });
    t += (7 + draw('split', j, Purpose.GenTiming) * 1.5) * s;
    c = nextChord(c);
  }

  if (drifts > 0) mark('Drift', t);
  for (let i = 0; i < drifts; i++) {
    const center = CENTER + Math.round((draw('drift', i, Purpose.GenRegister) - 0.5) * 6);
    add({
      type: 'chord',
      at: t,
      notes: { kind: 'degrees', degrees: chordDegrees(c) },
      voicing: 'even',
      register: registerFor(c, n, center),
      assign: 'ordered',
      glide: glide(1.4, 2.2, 4),
    });
    t += (5.8 + draw('drift', i, Purpose.GenTiming) * 2.2) * s;
    c = nextChord(c);
  }

  if (plan.development) {
    mark('Gather', t);
    add({
      type: 'unison',
      at: t,
      pitch: nearestIn(chordPool(c), CENTER),
      octaves: false,
      glide: glide(0.9, 3.6, 5),
    });
    t += 9.5 * s;

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
      glide: glide(0.25, 1.1, 1.9),
    });
    t += 7 * s;

    // Each tick a random subset of voices steps one or two scale tones, never touching or
    // crossing; the lowest voice leaps 5–12 semitones instead. Steps last 0.22–0.32 s and start
    // up to 0.1 s into the tick. The walk's own timing is never scaled.
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
    t += ticks * WALK_GRID + 1.5 * s;
  }

  // Three-note chords, the voices split into three equal groups (low, middle, high).
  if (plan.thins > 0) mark('Thin', t);
  for (let i = 0; i < plan.thins; i++) {
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
      glide: glide(1.3, 3, 5),
    });
    t += 9 * s;
  }

  mark('Home', t);
  add({ type: 'unison', at: t, pitch: ROOT, octaves: false, glide: glide(1, 4, 6.5) });
  t += 13.5 * s;

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
