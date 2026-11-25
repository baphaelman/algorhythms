/**
 * Canonical numbers in a piece (PLAN.md §11.4, M5 share links).
 *
 * Stored numbers are rounded to what is audible, so pieces stay small and share links round-trip
 * exactly: the app canonicalises every piece it loads or edits, and a decoded link is already
 * canonical. Rules (by field):
 * - **times** (`at`, `until`, glide length and stagger, ramps, fades, the end, the loop, camera
 *   key times and windows): 1 ms;
 * - **step durations** (tune `len`, pulse `step`, walk `grid`): 1 µs, since they add up over
 *   many steps;
 * - **levels** (gains, pan, sends, pulse accents and floor, weights, jitter, density, a camera
 *   key's playhead place): 3
 *   significant digits;
 * - **other known numbers** (pitches, factors, ticks, béziers, Hz): 12 significant digits, which
 *   only removes float noise such as 0.30000000000000004;
 * - **the poster** (M14): boxes, margins and nudges (fractions of the artboard) to 4 significant
 *   digits; style factors, opacities and the picture's position and dimming as levels; its
 *   section as times.
 *
 * Only the fields listed here change: unknown fields (and timbres and the mix, which have no
 * editor yet) are kept as written. Rounding is idempotent and copy-on-write: unchanged objects
 * keep their identity, so the incremental compiler still reuses them. A positive time never rounds
 * to 0 (it becomes one quantum), so `len > 0`-style rules still hold.
 */

import type { Moment, Piece } from './types';

type Rec = Record<string, unknown>;
type Rule = (x: number) => number;

function isRec(x: unknown): x is Rec {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** `x` to `digits` significant digits (exact decimal rounding, the same on every engine). */
function sig(x: number, digits: number): number {
  if (!Number.isFinite(x) || Number.isInteger(x)) return x;
  return Number(x.toPrecision(digits));
}

/** `x` to a multiple of 1/`per` (per = 1000: milliseconds); a non-zero value stays non-zero. */
function grid(x: number, per: number): number {
  if (!Number.isFinite(x) || Number.isInteger(x)) return x;
  const r = Math.round(x * per) / per;
  return r === 0 && x !== 0 ? (x > 0 ? 1 : -1) / per : r;
}

/** Seconds to 1 ms. */
export const roundTime: Rule = (x) => grid(x, 1000);
/** Step durations (tune notes, pulse steps, walk grids) to 1 µs. */
export const roundStep: Rule = (x) => grid(x, 1_000_000);
/** Levels and gains to 3 significant digits. */
export const roundLevel: Rule = (x) => sig(x, 3);
/** Other known numbers: 12 significant digits. */
export const roundOther: Rule = (x) => sig(x, 12);
/** Poster positions and sizes (fractions of the artboard): 4 significant digits. */
export const roundPlace: Rule = (x) => sig(x, 4);

/**
 * Where the rules apply: a number rule, the listed fields of an object, each element of an array,
 * or a spec chosen by the value itself (moments, by type).
 */
type Spec =
  | Rule
  | { readonly fields: Readonly<Record<string, Spec>> }
  | { readonly each: Spec }
  | { readonly pick: (v: Rec) => Spec };

const obj = (fields: Record<string, Spec>): Spec => ({ fields });
const each = (spec: Spec): Spec => ({ each: spec });

function apply(spec: Spec, v: unknown): unknown {
  if (typeof spec === 'function') return typeof v === 'number' ? spec(v) : v;
  if ('each' in spec) {
    if (!Array.isArray(v)) return v;
    let out: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const x = apply(spec.each, v[i]);
      if (x !== v[i]) (out ??= v.slice())[i] = x;
    }
    return out ?? v;
  }
  if (!isRec(v)) return v;
  if ('pick' in spec) return apply(spec.pick(v), v);
  let out: Rec | null = null;
  for (const k of Object.keys(spec.fields)) {
    if (!Object.hasOwn(v, k)) continue;
    const x = apply(spec.fields[k], v[k]);
    if (x !== v[k]) (out ??= { ...v })[k] = x;
  }
  return out ?? v;
}

const pitches = each(roundOther);
const noteSet = obj({ pitches });
const ease = obj({ x1: roundOther, y1: roundOther, x2: roundOther, y2: roundOther });
const glide = obj({ length: roundTime, stagger: roundTime, jitter: roundLevel, ease });
const fromTo = obj({ from: roundOther, to: roundOther });

const COMMON: Record<string, Spec> = {
  at: roundTime,
  glide,
  overrides: each(obj({ pitch: roundOther, end: roundTime, weight: roundLevel })),
};

/** Field specs by moment type, on top of `COMMON`. */
const MOMENTS: Record<string, Record<string, Spec>> = {
  chord: { notes: noteSet, register: pitches },
  unison: { pitch: roundOther },
  split: { notes: noteSet },
  merge: { fade: roundTime },
  shift: { by: roundOther },
  spread: { factor: roundOther, around: roundOther },
  walk: {
    until: roundTime,
    grid: roundStep,
    density: roundLevel,
    stepGlide: roundTime,
    bass: obj({ leap: pitches }),
    fixed: each(obj({ tick: roundOther, pitch: roundOther })),
  },
  note: { from: roundOther, to: roundOther, changes: each(fromTo), back: roundTime },
  pin: { pitch: roundOther },
  level: { gain: roundLevel, over: roundTime },
  pulse: {
    until: roundTime,
    step: roundStep,
    pattern: each(roundLevel),
    decay: roundTime,
    floor: roundLevel,
    restart: roundStep,
  },
  tune: { notes: each(obj({ pitch: roundOther, len: roundStep })) },
  progression: { chords: each(obj({ len: roundStep })), register: pitches },
  timbre: { fade: roundTime },
};

const MOMENT_SPECS = new Map(
  Object.entries(MOMENTS).map(([type, fields]) => [type, obj({ ...COMMON, ...fields })]),
);
const UNKNOWN_MOMENT = obj(COMMON);

const posterBox = obj({ x: roundPlace, y: roundPlace, w: roundPlace, h: roundPlace });
const posterStyle = obj({
  size: roundLevel,
  opacity: roundLevel,
  offset: roundLevel,
  width: roundLevel,
  dx: roundPlace,
  dy: roundPlace,
});

const PIECE: Spec = obj({
  tuning: obj({ referenceHz: roundOther }),
  defaults: obj({ glide }),
  voices: each(
    obj({
      pan: roundLevel,
      gain: roundLevel,
      range: pitches,
      sends: obj({ reverb: roundLevel, delay: roundLevel }),
    }),
  ),
  moments: each({
    pick: (m) => (typeof m.type === 'string' && MOMENT_SPECS.get(m.type)) || UNKNOWN_MOMENT,
  }),
  end: obj({ at: roundTime, fade: roundTime }),
  camera: obj({
    keys: each(
      obj({
        at: roundTime,
        window: roundTime,
        place: roundLevel,
        pitch: roundOther,
        range: roundOther,
        ease,
      }),
    ),
  }),
  poster: obj({
    section: obj({ start: roundTime, end: roundTime }),
    margins: obj({ top: roundPlace, right: roundPlace, bottom: roundPlace, left: roundPlace }),
    layers: each(obj({ box: posterBox })),
    picture: obj({ x: roundLevel, y: roundLevel, dim: roundLevel }),
    texts: each(obj({ box: posterBox, style: obj({ size: roundPlace, opacity: roundLevel }) })),
    groups: { pick: (g) => obj(Object.fromEntries(Object.keys(g).map((k) => [k, posterStyle]))) },
    members: {
      pick: (g) =>
        obj(
          Object.fromEntries(
            Object.keys(g).map((k) => [
              k,
              {
                pick: (m: Rec) =>
                  obj(Object.fromEntries(Object.keys(m).map((id) => [id, posterStyle]))),
              },
            ]),
          ),
        ),
    },
  }),
  view: obj({
    window: roundOther,
    gridBpm: roundOther,
    loop: obj({ start: roundTime, end: roundTime }),
  }),
});

/**
 * The canonical form of a piece's numbers (see the module comment). Returns `piece` itself when
 * nothing changes, and shares every unchanged object with it.
 */
export function canonicalPiece<P extends Piece>(piece: P): P {
  return apply(PIECE, piece) as P;
}

/** The canonical form of one moment's numbers (as `canonicalPiece` stores it). */
export function canonicalMoment<M extends Moment>(m: M): M {
  return (apply(PIECE, { moments: [m] }) as { moments: M[] }).moments[0];
}
