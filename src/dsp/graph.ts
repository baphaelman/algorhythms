/**
 * The DSP graph (PLAN.md §8): voices → × g_n → dry bus and FX sends → reverb and delay returns →
 * master tone → look-ahead limiter. Pure TypeScript with no DOM or Web Audio, hosted by the
 * AudioWorklet (live) and the export worker (WAV). Both call `process()` once per 128-frame block.
 *
 * Transport (§8.3, §8.7): play, pause, seek, loop and hot-swap are requested by method calls and
 * applied at the next block boundary. Seek, loop wrap, play and pause crossfade over 5 ms by
 * handing every sounding voice to a "ghost" that keeps playing its old state while fading out;
 * hot-swap crossfades the same way over 20 ms when a voice's pitch moves by more than half a
 * semitone (or its timbre or life changes) and slews otherwise. The FX keep running throughout,
 * so tails continue.
 *
 * Stems (§12): `setRenderMode` renders one voice (its dry signal only) or the FX returns only,
 * through the same tone stage and limiter delay; `setLimiterCapture`/`setLimiterReplay` record and
 * replay the limiter's per-sample gain g_L. Σ voice stems + FX stem = mix.
 *
 * `process()` is allocation-free (§8.11). Methods that take scores or tables allocate, and are
 * meant to be called from message handlers.
 */

import type { FlatScore } from '../core/flat';
import type { MixSettings } from '../core/types';
import {
  BLOCK_FRAMES,
  CONTROL_PERIOD,
  DSP_MAX_VOICES,
  MAX_GHOSTS,
  MAX_TIMBRE_SLOTS,
  NORM_SMOOTHING,
  SEEK_FADE,
  SWAP_CROSSFADE_SEMITONES,
  SWAP_FADE,
} from './constants';
import { PingPongDelay } from './fx/delay';
import { Limiter } from './fx/limiter';
import { Reverb } from './fx/reverb';
import { Tone } from './fx/tone';
import { MixState, type ParamValue } from './mix';
import { TimbreSlot } from './timbre-slot';
import { EMPTY_VOICE_DATA, TICKS_PER_BLOCK, Voice, VoiceContext, VoiceData } from './voice';
import { MIP_BASE_HZ, type WavetableSet } from './wavetable';

/** What `process()` sends to the master (stems, §12). */
export const RenderMode = {
  /** Dry bus + FX returns: the normal mix. */
  Mix: 0,
  /** One voice's dry signal only (its sends feed nothing). */
  Voice: 1,
  /** The reverb and delay returns only (every voice feeds them). */
  Fx: 2,
} as const;
export type RenderMode = (typeof RenderMode)[keyof typeof RenderMode];

/** Bits of `Graph.events`, set during `process()`. */
export const GraphEvent = {
  /** A new clock anchor (see anchorPieceTime, anchorPlaying, anchorReason). */
  Anchor: 1,
  /** Playback reached the end of the piece and stopped. */
  Ended: 2,
} as const;

/** Why an anchor was posted. */
export const AnchorReason = {
  Load: 0,
  Play: 1,
  Pause: 2,
  Seek: 3,
  Loop: 4,
  Swap: 5,
  End: 6,
} as const;

/** Prepared voice data for a score (built in a message handler, applied at a block boundary). */
interface PreparedScore {
  data: VoiceData[];
  voiceIds: string[];
  duration: number;
  referenceHz: number;
}

export class Graph {
  /** Output sample rate in Hz. */
  readonly sampleRate: number;
  private readonly slots: TimbreSlot[] = [];
  private readonly slotByName = new Map<string, number>();
  private readonly ctx: VoiceContext;
  private readonly voices: Voice[] = [];
  private readonly ghosts: Voice[] = [];
  private voiceCount = 0;
  private voiceIds: string[] = [];
  private durationFrames = 0;
  private duration = 0;
  private seed = 0;
  private readonly mix = new MixState();

  private readonly reverb: Reverb;
  private readonly delay: PingPongDelay;
  private readonly tone: Tone;
  private readonly limiter: Limiter;
  private readonly revL = new Float64Array(BLOCK_FRAMES);
  private readonly revR = new Float64Array(BLOCK_FRAMES);
  private readonly dlyL = new Float64Array(BLOCK_FRAMES);
  private readonly dlyR = new Float64Array(BLOCK_FRAMES);
  private readonly masterL = new Float64Array(BLOCK_FRAMES);
  private readonly masterR = new Float64Array(BLOCK_FRAMES);
  private retRev = 0;
  private retDly = 0;

  // Transport.
  private playing = false;
  private pieceFrame = 0;
  private prevPieceFrame = 0;
  private renderFrame = 0;
  private loopStart = -1;
  private loopEnd = -1;
  private pendingPlay = -1;
  private pendingPos = -1;
  private pendingSwap: PreparedScore | null = null;
  private gnValue = 1;
  private readonly normCoeff: number;
  private readonly seekFadeFrames: number;
  private readonly swapFadeFrames: number;

  // Stems.
  private renderMode: RenderMode = RenderMode.Mix;
  private stemVoice = -1;

  /** GraphEvent bits set by the last `process()`. */
  events = 0;
  /** Piece time of the newest anchor (at the first frame of the block that set it). */
  anchorPieceTime = 0;
  /** Whether the transport is playing from that anchor. */
  anchorPlaying = false;
  /** AnchorReason of the newest anchor. */
  anchorReason: number = AnchorReason.Load;

  /** Post-limiter meter, accumulated until the host calls `resetMeter()`. */
  meterPeakL = 0;
  meterPeakR = 0;
  meterSumSq = 0;
  meterFrames = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    for (let i = 0; i < MAX_TIMBRE_SLOTS; i++) this.slots.push(new TimbreSlot());
    this.ctx = new VoiceContext(sampleRate, this.slots);
    for (let i = 0; i < DSP_MAX_VOICES; i++) this.voices.push(new Voice());
    for (let i = 0; i < MAX_GHOSTS; i++) this.ghosts.push(new Voice());
    this.reverb = new Reverb(sampleRate);
    this.delay = new PingPongDelay(sampleRate);
    this.tone = new Tone(sampleRate);
    this.limiter = new Limiter(sampleRate);
    this.normCoeff = 1 - Math.exp(-CONTROL_PERIOD / (NORM_SMOOTHING * sampleRate));
    this.seekFadeFrames = Math.round(SEEK_FADE * sampleRate);
    this.swapFadeFrames = Math.round(SWAP_FADE * sampleRate);
  }

  // -------------------------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------------------------

  /** Loads a score and mix: stops the transport, clears FX state, position 0. Allocates. */
  load(score: FlatScore, mix: MixSettings): void {
    const prepared = this.prepare(score);
    this.playing = false;
    this.pendingPlay = -1;
    this.pendingPos = -1;
    this.pendingSwap = null;
    for (const g of this.ghosts) g.enabled = false;
    this.seed = score.seed >>> 0;
    this.applyMeta(prepared);
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = this.voices[i];
      v.data = i < prepared.data.length ? prepared.data[i] : EMPTY_VOICE_DATA;
      v.setIdentity(i, v.data.hash, this.seed, this.voiceCount);
      v.enabled = false;
      v.clearFade();
      v.jump(0, true);
    }
    this.mix.set(mix);
    this.applyMix(true);
    this.reverb.reset();
    this.delay.reset();
    this.tone.reset();
    this.limiter.reset();
    this.pieceFrame = 0;
    this.prevPieceFrame = 0;
    this.gnValue = 1;
    this.loopStart = -1;
    this.loopEnd = -1;
    this.anchor(AnchorReason.Load);
  }

  /** Hot-swaps the score at the next block boundary (§8.7). Allocates now, not in process(). */
  swap(score: FlatScore): void {
    this.pendingSwap = this.prepare(score);
  }

  /**
   * Installs a timbre's wavetables. While audio is running, a replacement crossfades over
   * `fadeSeconds` (default 20 ms); before playback (and in exports) it is immediate.
   */
  setTables(name: string, tables: WavetableSet, fadeSeconds = SWAP_FADE): void {
    const slot = this.slots[this.slotIndex(name)];
    const running = this.playing || this.ghosts.some((g) => g.enabled);
    slot.install(tables, this.renderFrame, running ? Math.round(fadeSeconds * this.sampleRate) : 0);
  }

  /** Replaces the whole mix (smoothed). */
  setMix(mix: MixSettings): void {
    this.mix.set(mix);
    this.applyMix(false);
  }

  /** Sets one mix or voice parameter by path (see dsp/mix.ts). Returns false if not applied. */
  setParam(path: string, value: ParamValue): boolean {
    if (path.startsWith('voices.')) return this.setVoiceParam(path, value);
    if (!this.mix.setPath(path, value)) return false;
    this.applyMix(false);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  /** Starts playback (from `from` seconds if given) at the next block, with a 5 ms fade-in. */
  play(from?: number): void {
    this.pendingPlay = 1;
    if (from !== undefined) this.pendingPos = this.toFrame(from);
  }

  /** Pauses at the next block with a 5 ms fade-out; FX tails keep ringing. */
  pause(): void {
    this.pendingPlay = 0;
  }

  /** Moves the playhead; while playing, old and new positions crossfade over 5 ms. */
  seek(to: number): void {
    this.pendingPos = this.toFrame(to);
  }

  /** Loops [start, end) seconds; the wrap crossfades over 5 ms. */
  setLoop(start: number, end: number): void {
    const s = this.toFrame(start);
    const e = this.toFrame(end);
    if (e - s >= BLOCK_FRAMES * 2) {
      this.loopStart = s;
      this.loopEnd = e;
    } else this.clearLoop();
  }

  /** Stops looping. */
  clearLoop(): void {
    this.loopStart = -1;
    this.loopEnd = -1;
  }

  /** Piece time at the start of the next block, in seconds. */
  get position(): number {
    return this.pieceFrame / this.sampleRate;
  }

  /** Whether the transport is playing. */
  get isPlaying(): boolean {
    return this.playing;
  }

  /** Duration of the loaded score in seconds. */
  get scoreDuration(): number {
    return this.duration;
  }

  /** Total frames rendered since construction. */
  get framesRendered(): number {
    return this.renderFrame;
  }

  /** Resets the meter accumulators. */
  resetMeter(): void {
    this.meterPeakL = 0;
    this.meterPeakR = 0;
    this.meterSumSq = 0;
    this.meterFrames = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Stems hooks (§12)
  // -------------------------------------------------------------------------------------------

  /** Selects what reaches the master: the mix, one voice's dry signal, or the FX returns. */
  setRenderMode(mode: RenderMode, voiceIndex = -1): void {
    this.renderMode = mode;
    this.stemVoice = voiceIndex;
  }

  /** Records the limiter gain g_L, one value per output frame from now on (null stops). */
  setLimiterCapture(buffer: Float32Array | null): void {
    this.limiter.capture = buffer;
    this.limiter.cursor = 0;
  }

  /** Applies a recorded g_L instead of computing one, from the next frame on (null stops). */
  setLimiterReplay(buffer: Float32Array | null): void {
    this.limiter.replay = buffer;
    this.limiter.cursor = 0;
  }

  /** The limiter's look-ahead in frames: every output is delayed by this much. */
  get limiterDelayFrames(): number {
    return this.limiter.delay;
  }

  /** The voice in pool slot `i` (for tests and diagnostics). */
  voiceAt(i: number): Voice {
    return this.voices[i];
  }

  // -------------------------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------------------------

  /** Renders one block of BLOCK_FRAMES stereo frames. Allocation-free. */
  process(outL: Float32Array, outR: Float32Array): void {
    const ctx = this.ctx;
    this.events = 0;
    ctx.renderFrame0 = this.renderFrame;
    for (let i = 0; i < MAX_TIMBRE_SLOTS; i++) this.slots[i].settle(this.renderFrame);

    if (this.pendingSwap !== null) this.applySwap();
    if (this.pendingPlay >= 0 || this.pendingPos >= 0) this.applyTransport();
    if (this.playing) this.checkLoopAndEnd();
    this.computeNorm();

    ctx.dryL.fill(0);
    ctx.dryR.fill(0);
    ctx.revIn.fill(0);
    ctx.dlyIn.fill(0);
    const mode = this.renderMode;
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = this.voices[i];
      if (!v.enabled) continue;
      if (mode === RenderMode.Voice && i !== this.stemVoice) continue;
      v.render(ctx, this.pieceFrame);
    }
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const g = this.ghosts[i];
      if (!g.enabled) continue;
      if (mode !== RenderMode.Voice || g.index === this.stemVoice) g.render(ctx, g.frame);
      g.frame += BLOCK_FRAMES;
      if (g.xfDone) g.enabled = false;
    }

    const mL = this.masterL;
    const mR = this.masterR;
    const dryL = ctx.dryL;
    const dryR = ctx.dryR;
    if (mode !== RenderMode.Voice) {
      this.reverb.process(ctx.revIn, this.revL, this.revR);
      this.delay.process(ctx.dlyIn, this.dlyL, this.dlyR);
    }
    let rr = this.retRev;
    let rd = this.retDly;
    const drr = (this.mix.reverbReturn - rr) / BLOCK_FRAMES;
    const drd = (this.mix.delayReturn - rd) / BLOCK_FRAMES;
    const useDry = mode !== RenderMode.Fx;
    const useFx = mode !== RenderMode.Voice;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      let l = 0;
      let r = 0;
      if (useDry) {
        l = dryL[i];
        r = dryR[i];
      }
      if (useFx) {
        rr += drr;
        rd += drd;
        l += this.revL[i] * rr + this.dlyL[i] * rd;
        r += this.revR[i] * rr + this.dlyR[i] * rd;
      }
      mL[i] = l;
      mR[i] = r;
    }
    this.retRev = this.mix.reverbReturn;
    this.retDly = this.mix.delayReturn;

    this.tone.process(mL, mR);
    this.limiter.process(mL, mR, outL, outR, BLOCK_FRAMES);

    let pl = this.meterPeakL;
    let pr = this.meterPeakR;
    let ss = this.meterSumSq;
    for (let i = 0; i < BLOCK_FRAMES; i++) {
      const l = outL[i];
      const r = outR[i];
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      ss += l * l + r * r;
    }
    this.meterPeakL = pl;
    this.meterPeakR = pr;
    this.meterSumSq = ss;
    this.meterFrames += BLOCK_FRAMES;

    this.renderFrame += BLOCK_FRAMES;
    this.prevPieceFrame = this.pieceFrame;
    if (this.playing) this.pieceFrame += BLOCK_FRAMES;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private toFrame(t: number): number {
    return Number.isFinite(t) && t > 0 ? Math.round(t * this.sampleRate) : 0;
  }

  private anchor(reason: number): void {
    this.events |= GraphEvent.Anchor;
    this.anchorPieceTime = this.pieceFrame / this.sampleRate;
    this.anchorPlaying = this.playing;
    this.anchorReason = reason;
  }

  private slotIndex(name: string): number {
    const known = this.slotByName.get(name);
    if (known !== undefined) return known;
    let free = -1;
    for (let i = 0; i < MAX_TIMBRE_SLOTS && free < 0; i++) if (this.slots[i].name === '') free = i;
    if (free < 0) free = this.recycleSlot();
    this.slots[free].clear();
    this.slots[free].name = name;
    this.slotByName.set(name, free);
    return free;
  }

  /** Frees a slot no current or pending voice data references (slot 0 as a last resort). */
  private recycleSlot(): number {
    const used = new Uint8Array(MAX_TIMBRE_SLOTS);
    const mark = (d: VoiceData) => {
      for (let i = 0; i < d.nTimbre; i++) if (d.timbreSlot[i] >= 0) used[d.timbreSlot[i]] = 1;
    };
    for (const v of this.voices) mark(v.data);
    for (const g of this.ghosts) if (g.enabled) mark(g.data);
    if (this.pendingSwap) for (const d of this.pendingSwap.data) mark(d);
    let pick = 0;
    for (let i = 0; i < MAX_TIMBRE_SLOTS; i++) {
      if (used[i] === 0) {
        pick = i;
        break;
      }
    }
    this.slotByName.delete(this.slots[pick].name);
    return pick;
  }

  private prepare(score: FlatScore): PreparedScore {
    const slotOf = new Int32Array(score.timbreNames.length);
    score.timbreNames.forEach((name, i) => (slotOf[i] = this.slotIndex(name)));
    const n = Math.min(DSP_MAX_VOICES, score.voices.length);
    const data: VoiceData[] = [];
    for (let i = 0; i < n; i++) {
      data.push(VoiceData.fromFlat(score.voices[i], score.voiceParams, i, slotOf));
    }
    return {
      data,
      voiceIds: score.voiceIds.slice(0, n),
      duration: Number.isFinite(score.duration) ? Math.max(0, score.duration) : 0,
      referenceHz: score.referenceHz > 0 ? score.referenceHz : 440,
    };
  }

  private applyMeta(p: PreparedScore): void {
    this.voiceCount = p.data.length;
    this.voiceIds = p.voiceIds;
    this.duration = p.duration;
    this.durationFrames = Math.round(p.duration * this.sampleRate);
    this.ctx.refOct = Math.log2(p.referenceHz / MIP_BASE_HZ);
    this.updateSolo(p.data);
  }

  private updateSolo(data: VoiceData[]): void {
    let any = false;
    for (const d of data) if (d.solo) any = true;
    this.ctx.anySolo = any;
  }

  private applyMix(immediate: boolean): void {
    const m = this.mix;
    this.reverb.setParams(m.reverbSize, m.reverbDecay, m.reverbDamping, m.reverbPreDelay, immediate);
    this.delay.setParams(m.delayTime, m.delayFeedback, immediate);
    this.tone.setParams(m.toneTilt, m.toneLowpassHz, immediate);
    this.limiter.setCeilingDb(m.ceilingDb);
    this.ctx.sendReverb = Math.max(0, m.sendReverb);
    this.ctx.sendDelay = Math.max(0, m.sendDelay);
    this.ctx.panByPitch = m.panByPitch;
    if (immediate) {
      this.retRev = m.reverbReturn;
      this.retDly = m.delayReturn;
    }
  }

  private setVoiceParam(path: string, value: ParamValue): boolean {
    const parts = path.split('.');
    if (parts.length < 3) return false;
    const key = parts[1];
    let index = this.voiceIds.indexOf(key);
    if (index < 0 && /^\d+$/.test(key)) index = Number(key);
    if (index < 0 || index >= this.voiceCount) return false;
    const d = this.voices[index].data;
    if (d === EMPTY_VOICE_DATA) return false;
    const field = parts.slice(2).join('.');
    switch (field) {
      case 'gain':
        if (typeof value !== 'number' || !Number.isFinite(value)) return false;
        d.gain = Math.max(0, value);
        return true;
      case 'pan':
        if (value === 'auto') d.pan = NaN;
        else if (typeof value === 'number' && Number.isFinite(value)) d.pan = value;
        else return false;
        return true;
      case 'mute':
        d.mute = value === true;
        return true;
      case 'solo': {
        d.solo = value === true;
        const all: VoiceData[] = [];
        for (let i = 0; i < this.voiceCount; i++) all.push(this.voices[i].data);
        this.updateSolo(all);
        return true;
      }
      case 'sends.reverb':
      case 'sends.delay': {
        const v = value === null ? NaN : typeof value === 'number' ? Math.max(0, value) : NaN;
        if (value !== null && !(v >= 0)) return false;
        if (field === 'sends.reverb') d.sendReverb = v;
        else d.sendDelay = v;
        return true;
      }
      default:
        return false;
    }
  }

  /** g_n target 1/√(Σ life weights) at piece time t (pure). */
  private normTarget(t: number): number {
    let sum = 0;
    for (let i = 0; i < this.voiceCount; i++) sum += this.voices[i].data.lifeAt(t);
    return 1 / Math.sqrt(sum > 1 ? sum : 1);
  }

  private computeNorm(): void {
    const gn = this.ctx.gn;
    gn[0] = this.gnValue;
    const inv = 1 / this.sampleRate;
    for (let k = 1; k <= TICKS_PER_BLOCK; k++) {
      if (this.playing) {
        const t = (this.pieceFrame + k * CONTROL_PERIOD) * inv;
        let sum = 0;
        for (let i = 0; i < this.voiceCount; i++) sum += this.voices[i].lifeAt(t);
        const target = 1 / Math.sqrt(sum > 1 ? sum : 1);
        this.gnValue += (target - this.gnValue) * this.normCoeff;
      }
      gn[k] = this.gnValue;
    }
  }

  private freeGhosts(): number {
    let n = 0;
    for (let i = 0; i < MAX_GHOSTS; i++) if (!this.ghosts[i].enabled) n++;
    return n;
  }

  /** A free ghost; when `force`, steals the most-faded one if none is free. */
  private acquireGhost(force: boolean): Voice | null {
    let best: Voice | null = null;
    let bestGain = Infinity;
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const g = this.ghosts[i];
      if (!g.enabled) return g;
      if (force) {
        const gain = g.xfGain();
        if (gain < bestGain) {
          bestGain = gain;
          best = g;
        }
      }
    }
    return best;
  }

  /** Hands voice v's current sound to a ghost that fades out over `frames`. */
  private ghostOf(v: Voice, frames: number, force: boolean): boolean {
    const g = this.acquireGhost(force);
    if (g === null) return false;
    g.copyFrom(v);
    g.frame = this.pieceFrame;
    g.gnFrozen = this.gnValue;
    g.fadeOut(frames);
    return true;
  }

  /** Fades every sounding main voice out through ghosts; false if ghosts ran out (not forced). */
  private fadeOutMains(frames: number, force: boolean): boolean {
    if (!force) {
      let needed = 0;
      for (let i = 0; i < DSP_MAX_VOICES; i++) {
        const v = this.voices[i];
        if (v.enabled && v.prevAmp > 0) needed++;
      }
      if (needed > this.freeGhosts()) return false;
    }
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.enabled && v.prevAmp > 0) this.ghostOf(v, frames, force);
      v.enabled = false;
    }
    return true;
  }

  /** Starts every main voice at the current position with a fade-in. */
  private startMains(frames: number): void {
    const t = this.pieceFrame / this.sampleRate;
    this.gnValue = this.normTarget(t);
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = this.voices[i];
      v.enabled = i < this.voiceCount;
      if (!v.enabled) continue;
      v.jump(t, true);
      v.fadeIn(frames);
    }
  }

  private applyTransport(): void {
    const wantPlay = this.pendingPlay >= 0 ? this.pendingPlay === 1 : this.playing;
    const moving = this.pendingPos >= 0;
    const pos = moving ? this.pendingPos : this.pieceFrame;
    if (this.playing) {
      if (!wantPlay || moving) {
        if (!this.fadeOutMains(this.seekFadeFrames, false)) return; // retry next block
      }
      if (!wantPlay) {
        this.playing = false;
        this.pieceFrame = pos;
        this.anchor(AnchorReason.Pause);
      } else if (moving) {
        this.pieceFrame = pos;
        this.startMains(this.seekFadeFrames);
        this.anchor(AnchorReason.Seek);
      }
    } else {
      this.pieceFrame = pos;
      if (wantPlay) {
        this.playing = true;
        this.startMains(this.seekFadeFrames);
        this.anchor(AnchorReason.Play);
      } else this.anchor(AnchorReason.Seek);
    }
    this.prevPieceFrame = this.pieceFrame;
    this.pendingPlay = -1;
    this.pendingPos = -1;
  }

  private checkLoopAndEnd(): void {
    if (this.loopEnd > this.loopStart && this.loopStart >= 0) {
      const threshold = this.loopEnd - BLOCK_FRAMES / 2;
      if (this.prevPieceFrame < threshold && this.pieceFrame >= threshold) {
        const pos = Math.max(0, this.loopStart + (this.pieceFrame - this.loopEnd));
        this.fadeOutMains(this.seekFadeFrames, true);
        this.pieceFrame = pos;
        this.prevPieceFrame = pos;
        this.startMains(this.seekFadeFrames);
        this.anchor(AnchorReason.Loop);
        return;
      }
      if (this.pieceFrame < this.loopEnd) return;
    }
    if (this.pieceFrame >= this.durationFrames) {
      this.fadeOutMains(this.seekFadeFrames, true);
      this.playing = false;
      this.events |= GraphEvent.Ended;
      this.anchor(AnchorReason.End);
    }
  }

  /** Whether swapping voice v to `nd` at time t needs a crossfade rather than a slew. */
  private needsCrossfade(v: Voice, nd: VoiceData, t: number): boolean {
    if (nd.hash !== v.data.hash) return true;
    if (!(nd.lifeAt(t) > 0)) return true;
    const p = nd.pitchAt(t);
    if (!(Math.abs(p - v.curPitch) <= SWAP_CROSSFADE_SEMITONES)) return true;
    return nd.slotAt(t) !== v.curSlot;
  }

  private applySwap(): void {
    const next = this.pendingSwap as PreparedScore;
    const t = this.pieceFrame / this.sampleRate;
    const n = next.data.length;
    if (this.playing) {
      let needed = 0;
      for (let i = 0; i < DSP_MAX_VOICES; i++) {
        const v = this.voices[i];
        const nd = i < n ? next.data[i] : EMPTY_VOICE_DATA;
        if (v.enabled && v.prevAmp > 0 && this.needsCrossfade(v, nd, t)) needed++;
      }
      if (needed > this.freeGhosts()) return; // retry next block
    }
    this.pendingSwap = null;
    this.applyMeta(next);
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = this.voices[i];
      const nd = i < n ? next.data[i] : EMPTY_VOICE_DATA;
      const identityChanged = nd.hash !== v.data.hash;
      if (!this.playing) {
        v.data = nd;
        if (identityChanged) v.setIdentity(i, nd.hash, this.seed, this.voiceCount);
        v.jump(t, true);
        continue;
      }
      const audible = v.enabled && v.prevAmp > 0;
      if (audible && this.needsCrossfade(v, nd, t)) {
        this.ghostOf(v, this.swapFadeFrames, true);
        v.data = nd;
        if (identityChanged) v.setIdentity(i, nd.hash, this.seed, this.voiceCount);
        v.enabled = i < n;
        v.jump(t, true);
        v.fadeIn(this.swapFadeFrames);
      } else if (audible) {
        const p = v.curPitch;
        const a = v.prevAmp;
        v.data = nd;
        v.jump(t, false);
        v.slew(p, a, this.swapFadeFrames);
      } else {
        v.data = nd;
        if (identityChanged) v.setIdentity(i, nd.hash, this.seed, this.voiceCount);
        v.enabled = i < n;
        v.jump(t, true);
        // Whatever the new score sounds here ramps in over 20 ms instead of starting abruptly.
        v.slew(nd.pitchAt(t), 0, this.swapFadeFrames);
      }
    }
    this.anchor(AnchorReason.Swap);
  }
}
