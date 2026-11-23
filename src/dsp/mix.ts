/**
 * Mix parameters as plain numbers (PLAN.md §8.6), and the `param { path, value }` paths of §8.2.
 *
 * Paths:
 * - reverb.size | reverb.decay | reverb.damping | reverb.preDelay | reverb.returnLevel
 * - delay.time | delay.feedback | delay.returnLevel
 * - sends.reverb | sends.delay
 * - tone.tilt | tone.lowpassHz
 * - limiter.ceilingDb
 * - glue (0..1) | width (0..2) (§12 "Ready for YouTube"; absent: 0 and 1)
 * - panAuto ('index' | 'pitch')
 * - normalise ('all' | 'part'; §8.4 revision 10)
 * - voices.<id or pool index>.gain | .pan ('auto' or −1..1) | .mute | .solo
 *   | .sends.reverb | .sends.delay (null resets to the mix default)
 */

import type { MixSettings } from '../core/types';
import * as pmath from './pmath';

/** A param value as posted from the main thread. */
export type ParamValue = number | string | boolean | null;

export class MixState {
  reverbSize = 0.5;
  reverbDecay = 2.5;
  reverbDamping = 0.4;
  reverbPreDelay = 0.02;
  reverbReturn = 0.3;
  delayTime = 0.375;
  delayFeedback = 0.3;
  delayReturn = 0.2;
  sendReverb = 0.3;
  sendDelay = 0;
  toneTilt = 0;
  toneLowpassHz = 20000;
  ceilingDb = -1;
  panByPitch = false;
  /** `mix.normalise` is 'part' (absent means 'part'). */
  normPart = true;
  /** Master glue 0..1 and stereo width 0..2 (absent: 0 and 1). */
  glue = 0;
  width = 1;

  /**
   * Copies every field of a MixSettings (a non-finite value keeps the old one). Written out, not
   * through a helper: a helper that V8 does not inline returns boxed doubles (160 B per edit in
   * some no-GC 'fx' runs).
   */
  set(mix: MixSettings): void {
    let x = mix.reverb.size;
    if (Number.isFinite(x)) this.reverbSize = x;
    x = mix.reverb.decay;
    if (Number.isFinite(x)) this.reverbDecay = x;
    x = mix.reverb.damping;
    if (Number.isFinite(x)) this.reverbDamping = x;
    x = mix.reverb.preDelay;
    if (Number.isFinite(x)) this.reverbPreDelay = x;
    x = mix.reverb.returnLevel;
    if (Number.isFinite(x)) this.reverbReturn = x;
    x = mix.delay.time;
    if (Number.isFinite(x)) this.delayTime = x;
    x = mix.delay.feedback;
    if (Number.isFinite(x)) this.delayFeedback = x;
    x = mix.delay.returnLevel;
    if (Number.isFinite(x)) this.delayReturn = x;
    x = mix.sends.reverb;
    if (Number.isFinite(x)) this.sendReverb = x;
    x = mix.sends.delay;
    if (Number.isFinite(x)) this.sendDelay = x;
    x = mix.tone.tilt;
    if (Number.isFinite(x)) this.toneTilt = x;
    x = mix.tone.lowpassHz;
    if (Number.isFinite(x)) this.toneLowpassHz = x;
    x = mix.limiter.ceilingDb;
    if (Number.isFinite(x)) this.ceilingDb = x;
    this.panByPitch = mix.panAuto === 'pitch';
    this.normPart = mix.normalise !== 'all';
    x = mix.glue ?? 0;
    if (Number.isFinite(x)) this.glue = x < 0 ? 0 : x > 1 ? 1 : x;
    x = mix.width ?? 1;
    if (Number.isFinite(x)) this.width = x < 0 ? 0 : x > 2 ? 2 : x;
  }

  /** Applies one mix path; returns false if the path is not a mix path or the value is invalid. */
  setPath(path: string, value: ParamValue): boolean {
    if (path === 'panAuto') {
      if (value !== 'index' && value !== 'pitch') return false;
      this.panByPitch = value === 'pitch';
      return true;
    }
    if (path === 'normalise') {
      if (value !== 'all' && value !== 'part') return false;
      this.normPart = value === 'part';
      return true;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    switch (path) {
      case 'reverb.size':
        this.reverbSize = value;
        return true;
      case 'reverb.decay':
        this.reverbDecay = value;
        return true;
      case 'reverb.damping':
        this.reverbDamping = value;
        return true;
      case 'reverb.preDelay':
        this.reverbPreDelay = value;
        return true;
      case 'reverb.returnLevel':
        this.reverbReturn = value;
        return true;
      case 'delay.time':
        this.delayTime = value;
        return true;
      case 'delay.feedback':
        this.delayFeedback = value;
        return true;
      case 'delay.returnLevel':
        this.delayReturn = value;
        return true;
      case 'sends.reverb':
        this.sendReverb = value;
        return true;
      case 'sends.delay':
        this.sendDelay = value;
        return true;
      case 'tone.tilt':
        this.toneTilt = value;
        return true;
      case 'tone.lowpassHz':
        this.toneLowpassHz = value;
        return true;
      case 'limiter.ceilingDb':
        this.ceilingDb = value;
        return true;
      case 'glue':
        this.glue = value < 0 ? 0 : value > 1 ? 1 : value;
        return true;
      case 'width':
        this.width = value < 0 ? 0 : value > 2 ? 2 : value;
        return true;
      default:
        return false;
    }
  }
}

/**
 * Seconds of FX tail after the last voice dies: the reverb's RT60 plus pre-delay, or the time for
 * the delay's repeats to fall by 60 dB, whichever is longer (capped at 20 s).
 */
export function fxTailSeconds(mix: MixSettings): number {
  const reverb = mix.reverb.returnLevel > 0 ? mix.reverb.decay + mix.reverb.preDelay : 0;
  let delay = 0;
  if (mix.delay.returnLevel > 0 && mix.delay.feedback > 0 && mix.delay.feedback < 1) {
    const repeats = pmath.ln(1e-3) / pmath.ln(mix.delay.feedback);
    delay = mix.delay.time * 2 * (repeats + 1);
  } else if (mix.delay.returnLevel > 0) delay = mix.delay.time * 2;
  const tail = Math.max(reverb, delay);
  return Number.isFinite(tail) ? Math.min(20, Math.max(0, tail)) : 0;
}
