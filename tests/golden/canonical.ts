/**
 * Canonical serialisation and hash of a compiled score, for the golden tests (PLAN.md §7.11, §14).
 *
 * JSON.stringify is canonical here: the compiler builds every object with the same key order on
 * every engine, and ECMAScript specifies Number-to-string exactly (the shortest decimal that
 * round-trips), so two engines produce the same string iff they computed the same doubles.
 * The hash is FNV-1a over UTF-16 code units in two independent 32-bit lanes (integer ops only).
 */
import type { CompiledScore } from '../../src/core/types';

export function canonicalJson(score: CompiledScore): string {
  return JSON.stringify(score);
}

/** 64-bit (two-lane FNV-1a) hex hash of a string. */
export function hashString(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** A short human-readable summary next to the hash, so a golden diff says what moved. */
export interface ScoreSummary {
  hash: string;
  duration: number;
  voices: { id: string; lives: number; segments: number; lastPitch: number | null }[];
  diagnostics: string[];
  spans: number;
}

export function summarize(score: CompiledScore): ScoreSummary {
  return {
    hash: hashString(canonicalJson(score)),
    duration: score.duration,
    voices: score.voices.map((v) => ({
      id: v.id,
      lives: v.lives.length,
      segments: v.segments.length,
      lastPitch: v.segments.length ? v.segments[v.segments.length - 1].p1 : null,
    })),
    diagnostics: score.diagnostics.map((d) => `${d.level}:${d.code}`),
    spans: score.momentSpans.length,
  };
}

/**
 * What is heard (M4.5-27 migration test): the score without its editor-only parts (moment spans,
 * the HUD harmony, diagnostics) and without the segments' moment ids. Two scores that agree here
 * sound and export (WAV, stems, MIDI) the same.
 */
export function audibleJson(score: CompiledScore): string {
  return JSON.stringify({
    duration: score.duration,
    voices: score.voices.map((v) => ({
      ...v,
      segments: v.segments.map((g) => {
        const { momentId: _, ...rest } = g;
        return rest;
      }),
    })),
    walkSteps: score.walkSteps,
    keys: score.keys,
    referenceHz: score.referenceHz,
    seed: score.seed,
  });
}
