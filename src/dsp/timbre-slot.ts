/**
 * A named timbre held by the graph: its wavetables and scalar params (PLAN.md §8.11).
 *
 * When new tables arrive for a name that already has some (a timbre edit during playback), the
 * slot keeps the old tables and crossfades from them to the new ones over a short fade, so the
 * change cannot click. Until a slot's first tables arrive it is silent.
 */

import type { WavetableSet } from './wavetable';

export class TimbreSlot {
  /** Timbre name, '' when unused. */
  name = '';
  /** Current mip tables, or null before the first tables arrive. */
  data: Float32Array | null = null;
  /** sameAsNext flags of `data`. */
  same: Uint8Array | null = null;
  /** Mip spacing of `data` (mips per octave). */
  mipsPerOctave = 1;
  /** Tables being faded out after a replacement (null when none). */
  prevData: Float32Array | null = null;
  /** sameAsNext flags of `prevData`. */
  prevSame: Uint8Array | null = null;
  /** Mip spacing of `prevData`. */
  prevMipsPerOctave = 1;
  /** Render frame at which the replacement fade started. */
  fadeStart = 0;
  /** Length of the replacement fade in frames (0 = none running). */
  fadeLen = 0;

  detuneSpread = 0;
  accent = 0;
  artAmount = 0;
  artAttack = 0.01;
  artDecay = 0.2;
  vibRate = 5;
  vibDepthCents = 0;
  vibDelay = 0;
  vibJitter = 0;
  driftCents = 0;
  driftRate = 0;
  driftAmp = 0;
  /** Unison wobble in cents (0 = lock converged voices). */
  wobble = 0;

  /** Installs new tables, fading from the old ones (or from silence) over `fadeFrames`. */
  install(set: WavetableSet, renderFrame: number, fadeFrames: number): void {
    this.prevData = this.data;
    this.prevSame = this.same;
    this.prevMipsPerOctave = this.mipsPerOctave;
    this.data = set.data;
    this.same = set.sameAsNext;
    this.mipsPerOctave = set.mipsPerOctave;
    this.fadeStart = renderFrame;
    this.fadeLen = fadeFrames;
    const p = set.params;
    this.detuneSpread = p.detuneSpread;
    this.accent = p.accent;
    this.artAmount = p.artAmount;
    this.artAttack = p.artAttack;
    this.artDecay = p.artDecay;
    this.vibRate = p.vibRate;
    this.vibDepthCents = p.vibDepthCents;
    this.vibDelay = p.vibDelay;
    this.vibJitter = p.vibJitter;
    this.driftCents = p.driftCents;
    this.driftRate = p.driftRate;
    this.driftAmp = p.driftAmp;
    this.wobble = p.wobble;
  }

  /** Weight of `data` (vs `prevData`) at a render frame: 1 once any fade is over. Pure. */
  weight(renderFrame: number): number {
    if (this.fadeLen <= 0) return 1;
    const u = (renderFrame - this.fadeStart) / this.fadeLen;
    return u >= 1 ? 1 : u <= 0 ? 0 : u;
  }

  /** Drops the old tables once the fade is over at `renderFrame` (called at block starts). */
  settle(renderFrame: number): void {
    if (this.fadeLen > 0 && renderFrame - this.fadeStart >= this.fadeLen) {
      this.fadeLen = 0;
      this.prevData = null;
      this.prevSame = null;
    }
  }

  /** Forgets everything (on graph reset). */
  clear(): void {
    this.name = '';
    this.data = null;
    this.same = null;
    this.prevData = null;
    this.prevSame = null;
    this.fadeLen = 0;
  }
}
