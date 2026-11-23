/**
 * Line opacity by audible level (PLAN.md §10 "Silent lines vanish", revision 9): a line is drawn
 * with its opacity multiplied by level moments × life fades × pulse, clamped to 0..1. Voice gain
 * (`VoiceDef.gain`) is not part of it. Pure; reads the compiled score only.
 *
 * Revision 10: during a pulse region the pulse factor is drawn no lower than PULSE_DRAW_FLOOR, so
 * a floor-0 pulse reads as a line (its hits are marked by draw.ts), not as specks.
 *
 * Breakpoints (times where the curve changes shape) are precomputed once per compiled voice, so a
 * frame only binary-searches them.
 */

import { pulseBreaks, pulseGainAt, pulseIndexAt } from '../core/pulse';
import { lifeAt } from '../core/query';
import type { CompiledVoice, Life, Seconds } from '../core/types';

/** Opacities below this are not drawn. */
export const OPACITY_EPS = 0.01;
/** Life fades this short (the DSP's declick minimum) are drawn as steps. */
const MIN_LIFE_FADE = 0.005;

/** 6x⁵ − 15x⁴ + 10x³ on [0, 1]: zero slope and curvature at both ends. */
export function smootherstep(x: number): number {
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Life gain at t: 0 outside [born, died), smootherstep fades in and out (as the DSP). */
export function lifeLevel(life: Life, t: Seconds): number {
  const end = life.died ?? Infinity;
  if (t < life.born || t >= end) return 0;
  let w = 1;
  if (life.fadeIn > MIN_LIFE_FADE) {
    const u = (t - life.born) / life.fadeIn;
    if (u < 1) w = smootherstep(u);
  }
  const fo = life.fadeOut ?? 0;
  if (fo > MIN_LIFE_FADE) {
    const u = (end - t) / fo;
    if (u < 1) w *= smootherstep(u);
  }
  return w;
}

/** The level timeline at t: 1 before the first change; linear ramps from the level in effect. */
export function levelAt(voice: CompiledVoice, t: Seconds): number {
  const L = voice.level;
  let start = 1;
  let k = -1;
  for (let i = 0; i < L.length; i++) {
    if (L[i].t > t) break;
    if (k >= 0) start = ramp(start, k, voice, L[i].t);
    k = i;
  }
  return k < 0 ? 1 : ramp(start, k, voice, t);
}

function ramp(start: number, k: number, voice: CompiledVoice, t: Seconds): number {
  const c = voice.level[k];
  return c.over > 0 && t < c.t + c.over ? start + ((c.gain - start) * (t - c.t)) / c.over : c.gain;
}

/** The lowest pulse factor drawn inside a pulse region (revision 10). */
export const PULSE_DRAW_FLOOR = 0.15;

/** Pulse envelope at t (core/pulse): 1 outside any pulse. The audible value. */
export function pulseLevel(voice: CompiledVoice, t: Seconds): number {
  return pulseGainAt(voice, t);
}

/**
 * The pulse factor as drawn (revision 10): the envelope, but at least PULSE_DRAW_FLOOR while a
 * pulse record is in force (a region's last boundary has floor 1, so this ends with it).
 */
export function pulseDrawLevel(voice: CompiledVoice, t: Seconds): number {
  if (pulseIndexAt(voice, t) < 0) return 1;
  const g = pulseGainAt(voice, t);
  return g > PULSE_DRAW_FLOOR ? g : PULSE_DRAW_FLOOR;
}

/** Opacity factor of voice `v` at t: level × life × pulse, clamped to 0..1. */
export function opacityAt(voice: CompiledVoice, t: Seconds): number {
  return opacityIn(voice, voice.lives, t);
}

/** The life of `lives` (sorted, disjoint) containing t, or null. */
function lifeIn(lives: readonly Life[], t: Seconds): Life | null {
  let lo = 0;
  let hi = lives.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lives[mid];
    if (t < l.born) hi = mid - 1;
    else if (l.died !== undefined && t >= l.died) lo = mid + 1;
    else return l;
  }
  return null;
}

/**
 * `opacityAt` with `lives` in place of the voice's own: the drawing's lives, where a line that
 * bundles into another ends at the meeting and a strand peeling off a rope starts without a fade
 * (strands.ts).
 */
export function opacityIn(
  voice: CompiledVoice,
  lives: readonly Life[],
  t: Seconds,
  floor = 0,
): number {
  const life = lives === voice.lives ? lifeAt(voice, t) : lifeIn(lives, t);
  if (!life) return 0;
  const level = levelAt(voice, t);
  let f = level * pulseDrawLevel(voice, t);
  if (floor > 0) {
    const m = floor * (level >= SOUNDING ? 1 : level > 0 ? level / SOUNDING : 0);
    if (f < m) f = m;
  }
  const o = f * lifeLevel(life, t);
  return o > 1 ? 1 : o > 0 ? o : 0;
}

/**
 * Minimum line opacity (§12 "Ready for YouTube", revision 17): `opacityIn`'s `floor` lifts
 * level × pulse to at least the floor while the line sounds, so gated or pulsed parts stay bold
 * between hits. Life fades still apply; below this level the floor scales down with it, so a line
 * silenced by its level still fades out and vanishes.
 */
export const SOUNDING = 0.05;

/** `opacityIn` without the pulse factor: the strength of a hit mark at t (draw.ts). */
export function baseOpacityIn(voice: CompiledVoice, lives: readonly Life[], t: Seconds): number {
  const life = lives === voice.lives ? lifeAt(voice, t) : lifeIn(lives, t);
  if (!life) return 0;
  const o = levelAt(voice, t) * lifeLevel(life, t);
  return o > 1 ? 1 : o > 0 ? o : 0;
}

/** Hit times and accents of a voice's pulse records, interleaved [t, accent, …]; cached. */
export function pulseHits(voice: CompiledVoice): Float64Array | null {
  const r = voice.pulse;
  if (!r || r.length === 0) return null;
  const hit = hitCache.get(r);
  if (hit && hit.n === r.length) return hit.out;
  let n = 0;
  for (const p of r) if (p.hit) n++;
  const out = n > 0 ? new Float64Array(n * 2) : null;
  if (out) {
    let k = 0;
    for (const p of r) {
      if (!p.hit) continue;
      out[k++] = p.t;
      out[k++] = p.accent;
    }
  }
  hitCache.set(r, { n: r.length, out });
  return out;
}
const hitCache = new WeakMap<readonly unknown[], { n: number; out: Float64Array | null }>();

interface Breaks {
  level: CompiledVoice['level'];
  levels: number;
  lifeCount: number;
  pulse: CompiledVoice['pulse'];
  out: Float64Array | null;
}
const cache = new WeakMap<readonly Life[], Breaks>();

/**
 * Sorted times where the voice's opacity curve changes shape (births, deaths, fade ends, level
 * ramp ends), or null when it is 1 wherever the voice sounds (no level changes, no fades): the
 * drawing fast path. Cached per compiled voice.
 */
export function opacityBreaks(voice: CompiledVoice): Float64Array | null {
  return breaksIn(voice, voice.lives);
}

/** `opacityBreaks` over `lives` in place of the voice's own (see `opacityIn`); cached per array. */
export function breaksIn(voice: CompiledVoice, lives: readonly Life[]): Float64Array | null {
  const hit = cache.get(lives);
  if (
    hit &&
    hit.level === voice.level &&
    hit.levels === voice.level.length &&
    hit.lifeCount === lives.length &&
    hit.pulse === voice.pulse
  ) {
    return hit.out;
  }
  const ts: number[] = [];
  let flat = voice.level.length === 0;
  for (const c of voice.level) {
    ts.push(c.t);
    if (c.over > 0) ts.push(c.t + c.over);
  }
  if (voice.pulse && voice.pulse.length > 0) {
    flat = false;
    ts.push(...pulseBreaks(voice));
  }
  for (const l of lives) {
    ts.push(l.born);
    if (l.fadeIn > MIN_LIFE_FADE) {
      ts.push(l.born + l.fadeIn);
      flat = false;
    }
    if (l.died !== undefined) {
      ts.push(l.died);
      const fo = l.fadeOut ?? 0;
      if (fo > MIN_LIFE_FADE) {
        ts.push(l.died - fo);
        flat = false;
      }
    }
  }
  const out = flat ? null : Float64Array.from(ts).sort();
  cache.set(lives, {
    level: voice.level,
    levels: voice.level.length,
    lifeCount: lives.length,
    pulse: voice.pulse,
    out,
  });
  return out;
}
