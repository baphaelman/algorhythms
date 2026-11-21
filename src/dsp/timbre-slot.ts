/**
 * A named timbre held by the graph: its wavetables and scalar params (PLAN.md §8.11).
 *
 * When new tables arrive for a name that already has some (a timbre edit during playback), the
 * slot keeps the old tables and crossfades from them to the new ones over a short fade, so the
 * change cannot click. Until a slot's first tables arrive it is silent.
 */

import type { WavetableSet } from './wavetable';

/**
 * A timbre's M6 synthesis (FM, breath noise, the additive path), read by voices on the audio
 * thread. Built when tables are installed; null for timbres that use none of them, so those keep
 * the plain wavetable paths bit for bit.
 */
export class TimbreExt {
  /** Modulator/carrier ratio, 0 = no FM. */
  readonly fmRatio: number;
  /** β at middle C (radians), its pitch tracking, and the top partial multiple for the cap. */
  readonly fmIndex: number;
  readonly fmIndexTrack: number;
  readonly fmTop: number;
  /** Share of β held after a strike rings down (1 = no index envelope). */
  readonly fmHeld: number;
  /** Noise level (0 = none) and relative bandwidth. */
  readonly noiseLevel: number;
  readonly noiseBandwidth: number;
  /** Additive partials (none = wavetable carrier): ratios, per-mip amplitudes and count. */
  readonly partialRatio: Float64Array;
  readonly partialAmp: Float64Array;
  readonly nPartial: number;
  /** Struck partials: ratios, decays (s), per-mip amplitudes and count (0 = none). */
  readonly strikeRatio: Float64Array;
  readonly strikeDecay: Float64Array;
  readonly strikeAmp: Float64Array;
  readonly nStrike: number;

  constructor(set: WavetableSet) {
    const p = set.params;
    this.fmRatio = p.fmRatio;
    this.fmIndex = p.fmIndex;
    this.fmIndexTrack = p.fmIndexTrack;
    this.fmTop = p.fmTop;
    this.noiseLevel = p.noiseLevel;
    this.noiseBandwidth = p.noiseBandwidth;
    this.partialRatio = set.partialRatio;
    this.partialAmp = set.partialAmp;
    this.nPartial = set.partialRatio.length;
    this.fmHeld = p.fmHeld;
    this.strikeRatio = set.strikeRatio;
    this.strikeDecay = set.strikeDecay;
    this.strikeAmp = set.strikeAmp;
    this.nStrike = set.strikeRatio.length;
  }

  /** The ext a set needs, or null when it uses only the wavetable path. */
  static of(set: WavetableSet | null): TimbreExt | null {
    if (set === null) return null;
    const p = set.params;
    if (
      !(p.fmIndex > 0) &&
      !(p.noiseLevel > 0) &&
      set.partialRatio.length === 0 &&
      set.strikeRatio.length === 0
    )
      return null;
    return new TimbreExt(set);
  }
}

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
  /** M6 synthesis of `data` and of `prevData` (null = plain wavetable). */
  ext: TimbreExt | null = null;
  prevExt: TimbreExt | null = null;
  /** Coherence rows of `data` and of `prevData` (WavetableSet.coherence; null = none). */
  coh: Float64Array | null = null;
  prevCoh: Float64Array | null = null;
  /** Render frame at which the replacement fade started. */
  fadeStart = 0;
  /** Length of the replacement fade in frames (0 = none running). */
  fadeLen = 0;
  /** Bumped by every install (voices cache the params they copied). */
  version = 0;

  detuneSpread = 0;
  accent = 0;
  artAmount = 0;
  artAttack = 0.01;
  artCrisp = 0;
  artDecay = 0.2;
  vibRate = 5;
  vibDepthCents = 0;
  vibDelay = 0;
  vibJitter = 0;
  driftCents = 0;
  driftRate = 0;
  driftAmp = 0;
  strikeEnv = 0;

  /** Installs new tables, fading from the old ones (or from silence) over `fadeFrames`. */
  install(set: WavetableSet, renderFrame: number, fadeFrames: number): void {
    this.version++;
    this.prevData = this.data;
    this.prevSame = this.same;
    this.prevMipsPerOctave = this.mipsPerOctave;
    this.prevExt = this.ext;
    this.ext = TimbreExt.of(set);
    this.prevCoh = this.coh;
    this.coh = set.coherence ?? null;
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
    this.artCrisp = p.artCrisp;
    this.artDecay = p.artDecay;
    this.vibRate = p.vibRate;
    this.vibDepthCents = p.vibDepthCents;
    this.vibDelay = p.vibDelay;
    this.vibJitter = p.vibJitter;
    this.driftCents = p.driftCents;
    this.driftRate = p.driftRate;
    this.driftAmp = p.driftAmp;
    this.strikeEnv = p.strikeEnv;
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
      this.prevExt = null;
      this.prevCoh = null;
    }
  }

  /** Forgets everything (on graph reset). */
  clear(): void {
    this.version++;
    this.name = '';
    this.data = null;
    this.same = null;
    this.prevData = null;
    this.prevSame = null;
    this.ext = null;
    this.prevExt = null;
    this.coh = null;
    this.prevCoh = null;
    this.fadeLen = 0;
  }
}
