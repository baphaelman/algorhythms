/**
 * Seeded integer hashing and a small PRNG for the DSP (PLAN.md §8.10). No Math.random: every
 * random value (phases, detune magnitudes, dither) is a pure function of the piece seed and the
 * voice-id hash, so renders repeat exactly.
 */

/** Murmur3's 32-bit finaliser: a fast, well-mixed bijection on uint32. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of two uint32 values (order matters). */
export function hash2(a: number, b: number): number {
  return fmix32((a >>> 0) ^ fmix32((b + 0x9e3779b9) >>> 0));
}

/** Maps a uint32 to [0, 1). */
export function unit(h: number): number {
  return (h >>> 0) / 4294967296;
}

/**
 * mulberry32: a 32-bit-state PRNG. State is held in a number so callers can store it in a field
 * and advance it without allocating.
 */
export class Prng {
  /** Current state (uint32). */
  state: number = 0;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next value in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
