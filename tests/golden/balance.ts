/**
 * Per-pitch output power of a compiled score at times when every sounding line rests (M4.5-29):
 * the balance check that distinct notes with weights keep each example's loudness per note.
 * Power of a line = (gain · level)² · weight / Σ(life · weight), the DSP's sum normalisation (§8.4).
 */
import { lifeAt, segmentAt } from '../../src/core/query';
import type { CompiledScore, CompiledVoice } from '../../src/core/types';

function levelAt(v: CompiledVoice, t: number): number {
  let level = 1;
  for (const c of v.level) {
    if (c.t > t) break;
    const u = c.over > 0 ? (t - c.t) / c.over : 1;
    level = u >= 1 ? c.gain : level + (c.gain - level) * u;
  }
  return level;
}

/** Weight in effect at t (1 when the score has no weight timeline), and whether it is ramping. */
export function weightAt(v: CompiledVoice, t: number): { w: number; ramp: boolean } {
  let w = 1;
  let ramp = false;
  for (const c of v.weight ?? []) {
    if (c.t > t) break;
    const u = c.over > 0 ? (t - c.t) / c.over : 1;
    ramp = u < 1;
    w = u >= 1 ? c.w : w + (c.w - w) * u;
  }
  return { w, ramp };
}

/**
 * Pitch (6 decimals) → power at t, or null if some sounding line is gliding, fading or changing
 * weight there.
 */
export function restingPower(score: CompiledScore, t: number): Record<string, number> | null {
  const lines: { p: number; pow: number; w: number }[] = [];
  let sumW = 0;
  for (const v of score.voices) {
    const life = lifeAt(v, t);
    if (!life) continue;
    if (t < life.born + life.fadeIn) return null;
    if (life.died !== undefined && t > life.died - (life.fadeOut ?? 0)) return null;
    const s = segmentAt(v, t);
    if (!s || s.p0 !== s.p1 || (s.m0 ?? 0) !== 0 || s.curve) return null;
    const { w, ramp } = weightAt(v, t);
    if (ramp) return null;
    const g = v.gain * levelAt(v, t);
    lines.push({ p: s.p0, pow: g * g * w, w });
    sumW += w;
  }
  const out: Record<string, number> = {};
  for (const l of lines) {
    const k = l.p.toFixed(6);
    out[k] = (out[k] ?? 0) + l.pow / sumW;
  }
  return out;
}
