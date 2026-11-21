/**
 * Counter-based randomness (PLAN.md §7.7).
 *
 * There are no streams. Every random value is computed directly from its key:
 *
 *   rand(momentSeed, voiceId, step, purpose) = toUnit(mix32(momentSeed, hash32(voiceId), step, purpose))
 *
 * so editing one moment never shifts another moment's draws, and a voice's draw at walk tick 12
 * depends only on that voice, that tick and that purpose.
 *
 * Integer operations only (Math.imul, shifts, `>>> 0`, `| 0`) plus one exact division in
 * `toUnit`, so every engine gives bit-identical results (§7.11).
 */

/**
 * What a draw is for. Part of the key, so two draws for different purposes are independent.
 * Never renumber: the codes are baked into every saved piece's behaviour. Append new ones.
 */
export const enum Purpose {
  /** Start-time offset within a moment's stagger. */
  Stagger = 1,
  /** Glide-length jitter. */
  Jitter = 2,
  /** Shuffle for `order: 'random'`. */
  Order = 3,
  /** Walk: does this voice step on this tick? */
  WalkPick = 4,
  /** Walk: which step size. */
  WalkStep = 5,
  /** Walk: bass leap choice. */
  BassLeap = 6,
  /** Births: stagger of newborns whose parent does not move. */
  Birth = 7,
  /** Merge with `which: 'random'`. */
  MergeWhich = 8,
  /** DSP: oscillator starting phase. */
  Phase = 9,
  /** DSP: always-on detune. */
  Detune = 10,
  /** generate(): section timing. */
  GenTiming = 11,
  /** generate(): chord progression. */
  GenChord = 12,
  /** generate(): register drift. */
  GenRegister = 13,
  /** generate(): moment ids. */
  GenId = 14,
  /** suggestNext(): choices among next moves. */
  Suggest = 15,
  /** Pulse with `mode: 'random'`: which voice a step hits. */
  PulsePick = 16,
}

// ---------------------------------------------------------------------------------------------
// murmur3 building blocks (x86_32 variant)
// ---------------------------------------------------------------------------------------------

const C1 = 0xcc9e2d51 | 0;
const C2 = 0x1b873593 | 0;

/** One murmur3 block round: absorbs the 32-bit word `k` into the state `h`. */
function round(h: number, k: number): number {
  k = Math.imul(k | 0, C1);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, C2);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** The murmur3 finaliser (fmix32): full avalanche of a 32-bit state. Returns a uint32. */
export function fmix32(h: number): number {
  h |= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hashes four 32-bit words (murmur3_32 over a 16-byte message, seed 0). Each argument is taken
 * modulo 2³² (ToInt32), so pass integers; fractions are truncated and NaN counts as 0.
 * Returns a uint32.
 */
export function mix32(a: number, b: number, c: number, d: number): number {
  let h = 0;
  h = round(h, a);
  h = round(h, b);
  h = round(h, c);
  h = round(h, d);
  return fmix32(h ^ 16);
}

// ---------------------------------------------------------------------------------------------
// hash32: arbitrary keys
// ---------------------------------------------------------------------------------------------

/** Type tags keep parts of different kinds apart: hash32('a') ≠ hash32(97). */
const TAG_STRING = 0x5354_5200 | 0;
const TAG_UINT = 0x5549_4e00 | 0;
const TAG_INT = 0x494e_5400 | 0;
const TAG_FLOAT = 0x464c_5400 | 0;
const HASH_SEED = 0x9e3779b9 | 0;

/** Scratch view for reading a double's bits; DataView fixes the byte order on every platform. */
const F64_VIEW = new DataView(new ArrayBuffer(8));

/**
 * Stable 32-bit hash of a sequence of numbers and strings. The same parts give the same uint32 on
 * every engine. Part boundaries and kinds are part of the hash, so hash32('ab', 'c') ≠
 * hash32('a', 'bc') and hash32(1) ≠ hash32('1').
 *
 * - Strings hash their UTF-16 code units.
 * - Integers in [−2³¹, 2³²) hash as one 32-bit word; other numbers hash their IEEE 754 bits
 *   (−0 counts as 0; every NaN is the same).
 */
export function hash32(...parts: (number | string)[]): number {
  let h = HASH_SEED;
  let words = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      h = round(h, TAG_STRING ^ part.length);
      words++;
      let i = 0;
      for (; i + 1 < part.length; i += 2) {
        h = round(h, part.charCodeAt(i) | (part.charCodeAt(i + 1) << 16));
        words++;
      }
      if (i < part.length) {
        h = round(h, part.charCodeAt(i));
        words++;
      }
    } else if (Number.isInteger(part) && part >= 0 && part <= 0xffffffff) {
      h = round(round(h, TAG_UINT), part);
      words += 2;
    } else if (Number.isInteger(part) && part < 0 && part >= -0x80000000) {
      h = round(round(h, TAG_INT), part);
      words += 2;
    } else if (part !== part) {
      // NaN: setFloat64 may write any NaN bit pattern, so hash a fixed word instead.
      h = round(round(h, TAG_FLOAT), 0x7ff8_0000);
      words += 2;
    } else {
      F64_VIEW.setFloat64(0, part + 0, true); // + 0 turns −0 into 0
      h = round(h, TAG_FLOAT);
      h = round(h, F64_VIEW.getUint32(0, true));
      h = round(h, F64_VIEW.getUint32(4, true));
      words += 3;
    }
  }
  return fmix32(h ^ (words << 2));
}

// ---------------------------------------------------------------------------------------------
// Draws
// ---------------------------------------------------------------------------------------------

/** Maps a uint32 to [0, 1): u / 2³². Exact (a power-of-two division). */
export function toUnit(u32: number): number {
  return (u32 >>> 0) / 4294967296;
}

/**
 * A moment's effective seed (§7.7): the explicit `override` if given, otherwise
 * hash32(pieceSeed, momentId). Always a uint32.
 */
export function momentSeed(pieceSeed: number, momentId: string, override?: number): number {
  return override !== undefined ? override >>> 0 : hash32(pieceSeed, momentId);
}

/**
 * A keyed draw in [0, 1): toUnit(mix32(momentSeed, hash32(voiceId), step, purpose)).
 * `step` is the walk tick index, or 0. Use `''` as `voiceId` for moment-level draws.
 */
export function rand(momentSeed: number, voiceId: string, step: number, purpose: Purpose): number {
  return toUnit(mix32(momentSeed, hash32(voiceId), step, purpose));
}

/** `rand` with the voice id already hashed (hash32(voiceId)), for hot loops. */
export function randHashed(
  momentSeed: number,
  voiceHash: number,
  step: number,
  purpose: Purpose,
): number {
  return toUnit(mix32(momentSeed, voiceHash, step, purpose));
}

/** A keyed integer draw in [0, n), for n ≥ 1. */
export function randInt(
  momentSeed: number,
  voiceId: string,
  step: number,
  purpose: Purpose,
  n: number,
): number {
  return Math.floor(rand(momentSeed, voiceId, step, purpose) * n);
}

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A deterministic 6-character base62 id (the MomentId format) from a 32-bit key. Each character
 * is drawn separately, so all six are uniform; distinct keys can still collide (about 1 in 5.7e10
 * per pair), so callers that need uniqueness must check.
 */
export function base62Id(key: number): string {
  let id = '';
  for (let i = 0; i < 6; i++) id += BASE62[mix32(key, i, 0x62, 0x1d) % 62];
  return id;
}
