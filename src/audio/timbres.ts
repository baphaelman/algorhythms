/**
 * Timbre resolution and wavetable caching for the hosts (PLAN.md §8.5, §8.11).
 *
 * A voice names a timbre; `Piece.timbres` adds to or overrides the built-in presets. Unknown
 * names fall back to `sine` (the compiler reports them; the engine just has to make sound).
 */

import { BUILTIN_TIMBRES } from '../core/timbres';
import type { Timbre } from '../core/types';
import { buildWavetables, type WavetableSet } from '../dsp/wavetable';

/** The definition a timbre name resolves to. */
export function resolveTimbre(name: string, timbres?: Record<string, Timbre>): Timbre {
  return timbres?.[name] ?? BUILTIN_TIMBRES[name] ?? BUILTIN_TIMBRES.sine;
}

/** A stable key for a timbre definition at a sample rate. */
export function timbreKey(timbre: Timbre, sampleRate: number): string {
  return `${sampleRate}|${JSON.stringify(timbre)}`;
}

const cache = new Map<string, WavetableSet>();
const CACHE_LIMIT = 64;

/**
 * Builds (or returns cached) wavetables. Cached sets are shared and must be treated as read-only;
 * copy them (see `cloneTables`) before transferring.
 */
export function tablesFor(timbre: Timbre, sampleRate: number): WavetableSet {
  const key = timbreKey(timbre, sampleRate);
  let set = cache.get(key);
  if (!set) {
    set = buildWavetables(timbre, sampleRate);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, set);
  }
  return set;
}

/** A deep copy whose buffers can be transferred. */
export function cloneTables(set: WavetableSet): WavetableSet {
  return {
    sampleRate: set.sampleRate,
    mipsPerOctave: set.mipsPerOctave,
    data: set.data.slice(),
    sameAsNext: set.sameAsNext.slice(),
    params: { ...set.params },
    partialRatio: set.partialRatio.slice(),
    partialAmp: set.partialAmp.slice(),
  };
}
