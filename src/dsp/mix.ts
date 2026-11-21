/**
 * Mix parameters as plain numbers (PLAN.md §8.6), and the `param { path, value }` paths of §8.2.
 *
 * Paths:
 * - reverb.size | reverb.decay | reverb.damping | reverb.preDelay | reverb.returnLevel
 * - delay.time | delay.feedback | delay.returnLevel
 * - sends.reverb | sends.delay
 * - tone.tilt | tone.lowpassHz
 * - limiter.ceilingDb
 * - panAuto ('index' | 'pitch')
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

  /** Copies every field of a MixSettings. */
  set(mix: MixSettings): void {
    this.reverbSize = num(mix.reverb.size, this.reverbSize);
    this.reverbDecay = num(mix.reverb.decay, this.reverbDecay);
    this.reverbDamping = num(mix.reverb.damping, this.reverbDamping);
    this.reverbPreDelay = num(mix.reverb.preDelay, this.reverbPreDelay);
    this.reverbReturn = num(mix.reverb.returnLevel, this.reverbReturn);
    this.delayTime = num(mix.delay.time, this.delayTime);
    this.delayFeedback = num(mix.delay.feedback, this.delayFeedback);
    this.delayReturn = num(mix.delay.returnLevel, this.delayReturn);
    this.sendReverb = num(mix.sends.reverb, this.sendReverb);
    this.sendDelay = num(mix.sends.delay, this.sendDelay);
    this.toneTilt = num(mix.tone.tilt, this.toneTilt);
    this.toneLowpassHz = num(mix.tone.lowpassHz, this.toneLowpassHz);
    this.ceilingDb = num(mix.limiter.ceilingDb, this.ceilingDb);
    this.panByPitch = mix.panAuto === 'pitch';
  }

  /** Applies one mix path; returns false if the path is not a mix path or the value is invalid. */
  setPath(path: string, value: ParamValue): boolean {
    if (path === 'panAuto') {
      if (value !== 'index' && value !== 'pitch') return false;
      this.panByPitch = value === 'pitch';
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
      default:
        return false;
    }
  }
}

function num(x: number, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
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
