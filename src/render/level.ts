/**
 * Line opacity by audible level (PLAN.md §10 "Silent lines vanish", revision 9): a line is drawn
 * with its opacity multiplied by level moments × life fades × pulse, clamped to 0..1. Voice gain
 * (`VoiceDef.gain`) is not part of it. Pure; reads the compiled score only.
 *
 * Breakpoints (times where the curve changes shape) are precomputed once per compiled voice, so a
 * frame only binary-searches them.
 */

import { pulseBreaks, pulseGainAt } from '../core/pulse';
import { lifeAt } from '../core/query';
import type { CompiledVoice, Life, Seconds } from '../core/types';

/** Opacities below this are not drawn. */
export const OPACITY_EPS = 0.01;
/** Life fades this short (the DSP's declick minimum) are drawn as steps. */
const MIN_LIFE_FADE = 0.005;

function smootherstep(x: number): number {
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

/** Pulse envelope at t (core/pulse): 1 outside any pulse. */
export function pulseLevel(voice: CompiledVoice, t: Seconds): number {
  return pulseGainAt(voice, t);
}

/** Opacity factor of voice `v` at t: level × life × pulse, clamped to 0..1. */
export function opacityAt(voice: CompiledVoice, t: Seconds): number {
  const life = lifeAt(voice, t);
  if (!life) return 0;
  const o = levelAt(voice, t) * lifeLevel(life, t) * pulseLevel(voice, t);
  return o > 1 ? 1 : o > 0 ? o : 0;
}

interface Breaks {
  level: CompiledVoice['level'];
  levels: number;
  lives: CompiledVoice['lives'];
  pulse: CompiledVoice['pulse'];
  out: Float64Array | null;
}
const cache = new WeakMap<CompiledVoice, Breaks>();

/**
 * Sorted times where the voice's opacity curve changes shape (births, deaths, fade ends, level
 * ramp ends), or null when it is 1 wherever the voice sounds (no level changes, no fades): the
 * drawing fast path. Cached per compiled voice.
 */
export function opacityBreaks(voice: CompiledVoice): Float64Array | null {
  const hit = cache.get(voice);
  if (
    hit &&
    hit.level === voice.level &&
    hit.levels === voice.level.length &&
    hit.lives === voice.lives &&
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
  for (const l of voice.lives) {
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
  cache.set(voice, {
    level: voice.level,
    levels: voice.level.length,
    lives: voice.lives,
    pulse: voice.pulse,
    out,
  });
  return out;
}
