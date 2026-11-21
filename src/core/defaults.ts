/**
 * Default values for pieces (PLAN.md §5, §8.6, §10), and the empty template.
 *
 * Every value the schema (core/schema.ts) fills in for an omitted field is defined here, so the
 * schema, `newPiece`, `generate` and share-link default stripping (§11.4, M5) all agree. The
 * exported constants are deeply frozen; use the `default…()` factories or `newPiece` for copies
 * you can edit.
 *
 * core/ has no clock (§8.10), so timestamps are passed in; `DEFAULT_TIMESTAMP` stands in when
 * none is given.
 */

import { BUILTIN_TIMBRES } from './timbres';
import { DEFAULT_REFERENCE_HZ } from './tuning';
import {
  MAX_VOICES,
  PIECE_FORMAT,
  PIECE_VERSION,
  type ChordMoment,
  type Glide,
  type Key,
  type MixSettings,
  type MomentType,
  type Piece,
  type Pitch,
  type Timbre,
  type VoiceDef,
  type ViewSettings,
} from './types';

/** Recursively read-only. */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/**
 * Sets an own, enumerable data property, even for keys like `__proto__` (where plain assignment
 * would change the prototype instead).
 */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A deep copy of plain JSON data (objects, arrays, strings, numbers, booleans, null). */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) setOwn(out, k, cloneJson(v));
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Piece-level defaults
// ---------------------------------------------------------------------------------------------

/** Stands in for `meta.created`/`modified` when no timestamp is given (core has no clock). */
export const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
/** `meta.title` when a file omits it. */
export const DEFAULT_TITLE = 'Untitled';
/** Voices in the default pool (§5 example: v1–v12). */
export const DEFAULT_POOL_SIZE = 12;
/** Default voice range: the prototype's 38..84 (D2..C6). */
export const DEFAULT_RANGE: readonly [Pitch, Pitch] = Object.freeze([38, 84]) as readonly [
  Pitch,
  Pitch,
];
/** Default timbre preset for new voices (a built-in, §8.5). */
export const DEFAULT_TIMBRE = 'glass';
/** The initial key of a new piece: A dorian, as in the prototype. */
export const DEFAULT_KEY: DeepReadonly<Key> = deepFreeze({ tonic: 'A', scale: 'dorian' });
/** Where the first voice starts: A3, the prototype's root. */
export const DEFAULT_START_PITCH: Pitch = 57;
/** The closing fade (`end.fade`), as in the prototype. */
export const DEFAULT_END_FADE = 6;

/** Default glide (§5 example). Moments' partial glides are merged over it at compile time. */
export const DEFAULT_GLIDE: DeepReadonly<Glide> = deepFreeze({
  length: 3,
  jitter: 0.2,
  stagger: 0.8,
  arrive: 'together',
  order: 'random',
  ease: 'smootherstep',
});

/**
 * Default master FX (§8.6): a moderate reverb, the delay off (return 0), the tone stage neutral
 * (no tilt; a 20 kHz low-pass is inaudible) and the limiter at −1 dBFS. M2 may retune the reverb
 * by ear; changing these values changes how files that omit them sound.
 */
export const DEFAULT_MIX: DeepReadonly<MixSettings> = deepFreeze({
  reverb: { size: 0.7, decay: 3.2, damping: 0.45, preDelay: 0.02, returnLevel: 0.35 },
  delay: { time: 0.375, feedback: 0.35, returnLevel: 0 },
  sends: { reverb: 0.5, delay: 0.25 },
  tone: { tilt: 0, lowpassHz: 20000 },
  limiter: { ceilingDb: -1 },
  panAuto: 'index',
});

/** Default view (§10): a 20 s window (the prototype's), colour by pitch, HUD on. */
export const DEFAULT_VIEW: DeepReadonly<ViewSettings> = deepFreeze({
  window: 20,
  colors: 'pitch',
  hud: true,
});

/**
 * Neutral values for timbre fields a file omits. Only `harmonics` is required in a timbre;
 * the rest default to "off" (no stretch, tilt, detune spread, accent, articulation or vibrato).
 */
export const TIMBRE_DEFAULTS: DeepReadonly<Omit<Timbre, 'harmonics' | 'fm' | 'noise'>> = deepFreeze(
  {
    stretch: 0,
    brightness: { tilt: 0, track: 0 },
    detuneSpread: 0,
    accent: 0,
    articulation: { amount: 0, attack: 0.01, decay: 0.2 },
    vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
  },
);

/**
 * Values the schema fills for omitted moment fields, by moment type (§6.2). Fields not listed are
 * required (e.g. `split.count`) or stay optional (e.g. `chord.register`, `split.notes`).
 */
export const MOMENT_DEFAULTS = deepFreeze({
  chord: { voicing: 'even', assign: 'ordered' },
  unison: { pitch: 'center', octaves: false },
  split: { voicing: 'even' },
  merge: { which: 'top', fade: 2 },
  shift: { unit: 'semitones' },
  spread: { around: 'mean', snap: 'scale' },
  walk: { grid: 1, density: 0.45, steps: [-2, -1, 1, 2], stepGlide: 0.3 },
  note: {},
  pin: {},
  key: {},
  level: { over: 1 },
  pulse: { step: 0.5, pattern: [1], decay: 0.3, floor: 0, mode: 'together' },
  tune: { notes: [] },
  timbre: { fade: 2 },
} as const) satisfies Record<MomentType, object>;

/**
 * A tune's own glide defaults (revision 9: per-note portamento), merged over the piece's default
 * glide before the moment's own `glide`: one line, so no stagger or jitter.
 */
export const TUNE_GLIDE = deepFreeze({ length: 0.1, stagger: 0, jitter: 0 } as const);

// ---------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------

/** A fresh, editable copy of `DEFAULT_GLIDE`. */
export function defaultGlide(): Glide {
  return cloneJson(DEFAULT_GLIDE) as Glide;
}

/** A fresh, editable copy of `DEFAULT_MIX`. */
export function defaultMix(): MixSettings {
  return cloneJson(DEFAULT_MIX) as MixSettings;
}

/** A fresh, editable copy of `DEFAULT_VIEW`. */
export function defaultView(): ViewSettings {
  return cloneJson(DEFAULT_VIEW) as ViewSettings;
}

/** Pool voice `index` (0-based) with default settings: id `v<index + 1>`. */
export function defaultVoice(index: number, timbre: string = DEFAULT_TIMBRE): VoiceDef {
  return {
    id: `v${index + 1}`,
    timbre,
    pan: 'auto',
    gain: 1,
    range: [DEFAULT_RANGE[0], DEFAULT_RANGE[1]],
  };
}

/** The default pool: `size` voices v1..v<size>. */
export function defaultVoices(
  size: number = DEFAULT_POOL_SIZE,
  timbre: string = DEFAULT_TIMBRE,
): VoiceDef[] {
  return Array.from({ length: size }, (_, i) => defaultVoice(i, timbre));
}

/** Copies of the built-in presets that `voices` reference (unknown names are skipped). */
export function builtinTimbresFor(voices: readonly VoiceDef[]): Record<string, Timbre> {
  const out: Record<string, Timbre> = {};
  for (const v of voices) {
    const preset = BUILTIN_TIMBRES[v.timbre];
    if (preset && !(v.timbre in out)) out[v.timbre] = cloneJson(preset);
  }
  return out;
}

/** Id of a migrated version 1 `start` chord (M4.5-27). */
export const OPENING_ID = 'start0';

/** A one-note opening: a chord at t = 0 with the single note `pitch`. */
export function openingNote(pitch: Pitch): ChordMoment {
  return {
    id: OPENING_ID,
    type: 'chord',
    at: 0,
    notes: { kind: 'pitches', pitches: [pitch] },
    voicing: 'even',
    assign: 'ordered',
  };
}

/** Options for `newPiece`. */
export interface NewPieceOptions {
  /** The piece seed (§7.7). */
  seed: number;
  /** `meta.title`. @default 'Untitled' */
  title?: string;
  /** ISO 8601 time for `meta.created` and `meta.modified`; core has no clock, so pass it in. */
  now?: string;
  /** Pool size, 1..32. @default 12 */
  poolSize?: number;
  /** Initial key. @default A dorian */
  key?: Key;
  /** Timbre preset of every voice. @default 'glass' */
  timbre?: string;
}

/**
 * The empty template (§11.3 M4 acceptance: "build a piece from the empty template"): a pool of
 * 12 voices v1–v12, A dorian, default glide, mix and view, and no moments: it is silent until the
 * first one, which the editor adds at 0:00 (owner 2026-11-21; the key shows as the piece key at
 * 0:00). The voices' built-in timbre is copied into `timbres`, so the file is self-contained.
 */
export function newPiece(opts: NewPieceOptions): Piece {
  const size = Math.max(1, Math.min(MAX_VOICES, Math.floor(opts.poolSize ?? DEFAULT_POOL_SIZE)));
  const voices = defaultVoices(size, opts.timbre ?? DEFAULT_TIMBRE);
  const now = opts.now ?? DEFAULT_TIMESTAMP;
  return {
    format: PIECE_FORMAT,
    version: PIECE_VERSION,
    meta: { title: opts.title ?? DEFAULT_TITLE, created: now, modified: now },
    seed: opts.seed,
    tuning: { referenceHz: DEFAULT_REFERENCE_HZ, system: { kind: '12tet' } },
    key: cloneJson((opts.key ?? DEFAULT_KEY) as Key),
    defaults: { glide: defaultGlide() },
    voices,
    moments: [],
    timbres: builtinTimbresFor(voices),
    mix: defaultMix(),
    end: { fade: DEFAULT_END_FADE },
    view: defaultView(),
  };
}
