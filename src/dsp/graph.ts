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
 * Unison lock (docs/build-log.md, "Unison lock"): once per block, `computeGroups` finds voices
 * whose pitches meet and steers them into one steady, phase-coherent tone at the level the same
 * voices would have as a chord (see Voice for what each voice does with it).
 *
 * Stems (§12): `setRenderMode` renders one voice (its dry signal only) or the FX returns only,
 * through the same tone stage and limiter delay. Every other voice still runs, silently, because
 * the unison lock couples voices: so each voice stem carries exactly what that voice contributed
 * to the mix; `setLimiterCapture`/`setLimiterReplay` record and
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
  SWAP_FADE,
  VOICE_BASE_GAIN,
} from './constants';
import { PingPongDelay } from './fx/delay';
import { Limiter } from './fx/limiter';
import { Reverb } from './fx/reverb';
import { Tone } from './fx/tone';
import { MixState, type ParamValue } from './mix';
import { SINE, SINE_TABLE_SIZE } from './sine';
import { TimbreSlot } from './timbre-slot';
import {
  computeStrikeShares,
  computeUnisonWarps,
  EMPTY_VOICE_DATA,
  LOUDNESS_PITCH,
  LOUDNESS_SLOPE,
  TICKS_PER_BLOCK,
  Voice,
  VoiceContext,
  VoiceData,
} from './voice';
import { COH_NOISE, COH_REST, COH_STRIDE, MIP_BASE_HZ, type WavetableSet } from './wavetable';
import * as pmath from './pmath';

/** pmath's registers (allocation-free calls on the audio thread). */
const PR = pmath.R;
const ATAN_C = pmath.ATAN_C;

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

/**
 * Unison lock (docs/build-log.md, "Unison lock"). Two voices group fully when their score pitches
 * are within LOCK_FULL cents, not at all beyond LOCK_EDGE cents, smoothly in between.
 */
const LOCK_FULL = 2;
const LOCK_EDGE = 20;
/**
 * Phase pull: a voice's frequency moves toward its group's mean phase by up to LOCK_PULL of
 * itself (about 7 cents), and by at most LOCK_PULL_MAX_HZ. A pair closes a small phase gap with a
 * time constant of 1/(2π · LOCK_PULL · f): 0.18 s at 220 Hz.
 */
const LOCK_PULL = 0.004;
const LOCK_PULL_MAX_HZ = 12;
/**
 * Release pull: while a voice is parting from a close neighbour, it unwinds its accumulated phase
 * pull θ at up to LOCK_RELEASE_PULL of its frequency (it is gliding then anyway), so voices leave a
 * unison with unrelated phases instead of fanning out from one phase, which would cancel in nulls
 * as they part. A voice whose group simply ends (its partner dies) keeps its θ: no pitch bend.
 */
const LOCK_RELEASE_PULL = 0.012;
/**
 * Two voices moving apart faster than SEP_START cents/s start to leave their group; at SEP_FULL
 * cents/s they have left it, however close they still are.
 */
const SEP_START = 2;
const SEP_FULL = 12;
const INV_SEP_SPAN = 1 / (SEP_FULL - SEP_START);
/**
 * Stillness: a voice's say in its group's target pitch and phase is its amplitude times its
 * stillness, 1 / (1 + |v| / 20 cents/s) for score-pitch speed v. Stillness drops at once when a
 * voice moves and recovers over STILL_SETTLE seconds, so a voice gliding in (and for a while after
 * it arrives) does the converging, and a held voice it arrives on keeps its pitch.
 */
const INV_STILL_SPEED = 1 / 20;
const STILL_SETTLE = 0.6;
/** Vibrato-phase pull, in Hz of vibrato rate. */
const LOCK_LFO_PULL = 0.6;
/** Smoothing of the lock amount λ, rising and falling (seconds). */
const LOCK_ATTACK = 0.04;
const LOCK_RELEASE = 0.1;
/**
 * Smoothing of the group gain h (seconds), and its ceiling h² ≤ LOCK_H2_MAX (+3 dB). h targets the
 * phases predicted for the end of the block (it is interpolated across the block), so it can
 * follow beats of up to ~10 Hz during a capture.
 */
const LOCK_GAIN_SMOOTHING = 0.002;
const LOCK_H2_MAX = 2;
const INV_LOCK_SPAN = 1 / (LOCK_EDGE - LOCK_FULL);
/**
 * Capture (docs/build-log.md, "Unison lock: steady approach and parting"), for pairs where either
 * voice runs a unison warp (Voice: it arrives at or leaves a unison):
 * - arriving, their phases pull together from CAPTURE_EDGE cents apart, fully within
 *   CAPTURE_FULL, by up to CAPTURE_PULL of the frequency (at most LOCK_PULL_MAX_HZ), so the voices
 *   meet in phase;
 * - arriving or leaving, the pair counts for h while it beats slower than CAPTURE_H_EDGE Hz (fully
 *   below CAPTURE_H_FULL), so h evens out the slow beats it cannot avoid.
 */
const CAPTURE_EDGE = 60;
const CAPTURE_FULL = 20;
const INV_CAPTURE_SPAN = 1 / (CAPTURE_EDGE - CAPTURE_FULL);
const CAPTURE_PULL = 0.008;
const CAPTURE_H_FULL = 10;
const CAPTURE_H_EDGE = 20;
const INV_CAPTURE_H_SPAN = 1 / (CAPTURE_H_EDGE - CAPTURE_H_FULL);
/**
 * Capture fades in (and out) over CAPTURE_RAMP seconds once a voice's warp starts (or ends),
 * along a smoothstep: the warp starts inside the zone where a pair already beats below
 * CAPTURE_H_EDGE, so switching capture on at once stepped h by up to 40 % in one block when the
 * pair was out of phase (merges and splits crossfade, 2026-11-21).
 */
const CAPTURE_RAMP = 0.03;
const INV_TWO_PI = 1 / (2 * Math.PI);

/** One g_n row per normalisation group in VoiceContext.gn. */
const GN_ROW = TICKS_PER_BLOCK + 1;

/** Prepared voice data for a score (built in a message handler, applied at a block boundary). */
interface PreparedScore {
  data: VoiceData[];
  voiceIds: string[];
  duration: number;
  referenceHz: number;
  /** Normalisation group per voice (Graph.partGroups) and how many distinct. */
  groups: Int32Array;
  distinctGroups: number;
  /** Per group: √(its peak lines / Σ peak lines), see Graph.partShare. */
  partShare: Float64Array;
  /** partGroups was rebuilt: every group's g_n restarts at 1. */
  groupsReset: boolean;
}

export class Graph {
  /** Output sample rate in Hz. */
  readonly sampleRate: number = 0;
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
  /** Smoothed g_n per normalisation group (index 0: every voice when not per part). */
  private readonly gnVal = new Float64Array(DSP_MAX_VOICES).fill(1);
  private readonly gnScratch = new Float64Array(1);
  /**
   * Per-part normalisation (§8.4 revision 10): on when mix.normalise is 'part' and the score has
   * more than one group. Groups are numbered by part name in `partGroups`, kept across swaps so a
   * hot-swap keeps each part's g_n.
   */
  private normPart = false;
  private readonly partGroups = new Map<string, number>();
  private readonly voiceGroup = new Int32Array(DSP_MAX_VOICES);
  private distinctGroups = 1;
  /**
   * Static trim per group: √(N_p / Σ N), N_p = FlatScore.partLines (the part's peak lines), so
   * with every part at its peak the levels are those of 'all', and fewer parts never lower any.
   */
  private readonly partShare = new Float64Array(DSP_MAX_VOICES);
  private readonly groupSum = new Float64Array(DSP_MAX_VOICES);
  /**
   * 1 while a group has not sounded since load (or since a score without it): its g_n takes its
   * target at once instead of gliding there from a stale value.
   */
  private readonly groupQuiet = new Uint8Array(DSP_MAX_VOICES).fill(1);
  private readonly normCoeff: number = 0;
  private readonly seekFadeFrames: number = 0;
  private readonly swapFadeFrames: number = 0;

  // Stems.
  private renderMode: RenderMode = RenderMode.Mix;
  private stemVoice = -1;

  // Unison lock: the group pass's per-voice inputs (0 = out, 1 = running, 2 = starting from
  // silence), smoothed state and coefficients.
  private readonly gPart = new Uint8Array(DSP_MAX_VOICES);
  private readonly gWas = new Uint8Array(DSP_MAX_VOICES);
  private readonly gP = new Float64Array(DSP_MAX_VOICES);
  private readonly gA = new Float64Array(DSP_MAX_VOICES);
  private readonly gM = new Float64Array(DSP_MAX_VOICES);
  private readonly gL = new Float64Array(DSP_MAX_VOICES);
  private readonly gInc = new Float64Array(DSP_MAX_VOICES);
  /** Score pitch at the previous block (cents), for the separation speed of pairs. */
  private readonly gPrevP = new Float64Array(DSP_MAX_VOICES);
  private readonly gV = new Float64Array(DSP_MAX_VOICES);
  private readonly gTh = new Float64Array(DSP_MAX_VOICES);
  /** Settled stillness per voice (see STILL_SETTLE). */
  private readonly gStill = new Float64Array(DSP_MAX_VOICES);
  /** Unison warp running (ctx.gWarp) per voice. */
  private readonly gWg = new Float64Array(DSP_MAX_VOICES);
  /** Capture gate per voice: ramps 0 → 1 over CAPTURE_RAMP while its warp runs (`gCapW`: eased). */
  private readonly gCap = new Float64Array(DSP_MAX_VOICES);
  private readonly gCapW = new Float64Array(DSP_MAX_VOICES);
  /** Predicted phase at the block end and its phasor, for h. */
  private readonly gPred = new Float64Array(DSP_MAX_VOICES);
  private readonly gHx = new Float64Array(DSP_MAX_VOICES);
  private readonly gHy = new Float64Array(DSP_MAX_VOICES);
  private readonly gCx = new Float64Array(DSP_MAX_VOICES);
  private readonly gSy = new Float64Array(DSP_MAX_VOICES);
  private readonly gLx = new Float64Array(DSP_MAX_VOICES);
  private readonly gLy = new Float64Array(DSP_MAX_VOICES);
  private readonly gLamS = new Float64Array(DSP_MAX_VOICES);
  private readonly gHS = new Float64Array(DSP_MAX_VOICES).fill(1);
  /** Group members and their weights (computeGroups → timbreZ2), and its result. */
  private readonly gMemb = new Int32Array(DSP_MAX_VOICES);
  private readonly gMembC = new Float64Array(DSP_MAX_VOICES);
  private readonly gZ2 = new Float64Array(1);
  /** Render frame at which each voice last published its spectrum (timbreZ2). */
  private readonly gCohStamp = new Float64Array(DSP_MAX_VOICES).fill(-1);
  private readonly lockUp: number = 0;
  private readonly lockDown: number = 0;
  private readonly lockGain: number = 0;
  private readonly pullMaxInc: number = 0;
  /** Beat rate in Hz per cent of distance per unit phase increment: sampleRate · ln 2 / 1200. */
  private readonly centsToHz: number = 0;
  private readonly invBlockSeconds: number = 0;
  private readonly stillCoeff: number = 0;
  private readonly capStep: number = 0;

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
    for (let i = 0; i < DSP_MAX_VOICES; i++) this.voices.push(new Voice(sampleRate));
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const g = new Voice(sampleRate);
      g.isGhost = true;
      this.ghosts.push(g);
    }
    this.reverb = new Reverb(sampleRate);
    this.delay = new PingPongDelay(sampleRate);
    this.tone = new Tone(sampleRate);
    this.limiter = new Limiter(sampleRate);
    this.normCoeff = 1 - pmath.exp(-CONTROL_PERIOD / (NORM_SMOOTHING * sampleRate));
    this.seekFadeFrames = Math.round(SEEK_FADE * sampleRate);
    this.swapFadeFrames = Math.round(SWAP_FADE * sampleRate);
    const blockSeconds = BLOCK_FRAMES / sampleRate;
    this.lockUp = 1 - pmath.exp(-blockSeconds / LOCK_ATTACK);
    this.lockDown = 1 - pmath.exp(-blockSeconds / LOCK_RELEASE);
    this.lockGain = 1 - pmath.exp(-blockSeconds / LOCK_GAIN_SMOOTHING);
    this.pullMaxInc = LOCK_PULL_MAX_HZ / sampleRate;
    this.centsToHz = (sampleRate * Math.LN2) / 1200;
    this.invBlockSeconds = sampleRate / BLOCK_FRAMES;
    this.stillCoeff = 1 - pmath.exp(-blockSeconds / STILL_SETTLE);
    this.capStep = blockSeconds / CAPTURE_RAMP;
  }

  // -------------------------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------------------------

  /** Loads a score and mix: stops the transport, clears FX state, position 0. Allocates. */
  load(score: FlatScore, mix: MixSettings): void {
    this.partGroups.clear();
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
    this.gnVal.fill(1);
    this.groupQuiet.fill(1);
    this.resetGroups();
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

  /** Whether a play, pause or seek is waiting to be applied at a block boundary. */
  get transportPending(): boolean {
    return this.pendingPlay >= 0 || this.pendingPos >= 0;
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

  /** Turns the unison lock off for every voice (tests' no-lock reference only). */
  setLockable(on: boolean): void {
    this.ctx.lockable = on ? 1 : 0;
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

  /** Voice `index`'s amplitude at the end of the last block (tests: envelope continuity). */
  voiceAmplitude(index: number): number {
    return this.voices[index].amplitude;
  }

  /** The limiter's look-ahead in frames: every output is delayed by this much. */
  get limiterDelayFrames(): number {
    return this.limiter.delay;
  }

  /** The slot holding timbre `name`, or −1 (tests: `Voice.timbreWeight`). */
  timbreSlotOf(name: string): number {
    return this.slotByName.get(name) ?? -1;
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
    if (this.playing) this.computeGroups();

    ctx.dryL.fill(0);
    ctx.dryR.fill(0);
    ctx.revIn.fill(0);
    ctx.dlyIn.fill(0);
    const mode = this.renderMode;
    const voices = this.voices;
    const ghosts = this.ghosts;
    const pieceFrame = this.pieceFrame;
    const stem = mode === RenderMode.Voice ? this.stemVoice : -1;
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = voices[i];
      if (!v.enabled) continue;
      // In a voice stem, the other voices run silently: the unison lock couples them.
      v.render(ctx, pieceFrame, stem < 0 || i === stem);
    }
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const g = ghosts[i];
      if (!g.enabled) continue;
      if (mode !== RenderMode.Voice || g.index === this.stemVoice) {
        for (let k = 1; k <= TICKS_PER_BLOCK; k++) g.computeLife(g.frame + k * CONTROL_PERIOD, k);
        g.render(ctx, g.frame, true);
      }
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

  /**
   * Frees the slots of timbres the host no longer needs. `AudioEngine` evicts least-recently-used
   * names this way, so its record of which tables the worklet holds stays true and `slotIndex`
   * never has to recycle a named slot. A freed slot keeps its tables until it is reused, so voices
   * still fading out on it keep sounding.
   */
  forget(names: readonly string[]): void {
    for (const name of names) {
      const i = this.slotByName.get(name);
      if (i === undefined) continue;
      this.slotByName.delete(name);
      this.slots[i].name = '';
    }
  }

  private slotIndex(name: string): number {
    const known = this.slotByName.get(name);
    if (known !== undefined) return known;
    // A free slot no voice references; else any free one; else recycle a named one.
    const used = this.referencedSlots();
    let free = -1;
    let anyFree = -1;
    for (let i = 0; i < MAX_TIMBRE_SLOTS && free < 0; i++) {
      if (this.slots[i].name !== '') continue;
      if (used[i] === 0) free = i;
      else if (anyFree < 0) anyFree = i;
    }
    if (free < 0) free = anyFree >= 0 ? anyFree : this.recycleSlot(used);
    this.slots[free].clear();
    this.slots[free].name = name;
    this.slotByName.set(name, free);
    return free;
  }

  /** 1 for each slot current, fading or pending voice data references. */
  private referencedSlots(): Uint8Array {
    const used = new Uint8Array(MAX_TIMBRE_SLOTS);
    const mark = (d: VoiceData) => {
      for (let i = 0; i < d.nTimbre; i++) if (d.timbreSlot[i] >= 0) used[d.timbreSlot[i]] = 1;
    };
    for (const v of this.voices) mark(v.data);
    for (const g of this.ghosts) if (g.enabled) mark(g.data);
    if (this.pendingSwap) for (const d of this.pendingSwap.data) mark(d);
    return used;
  }

  /**
   * Frees a named slot no voice data references (slot 0 as a last resort). Only reached when more
   * than MAX_TIMBRE_SLOTS names are live at once (a host that does not `forget`, or one score
   * with that many); the host is not told.
   */
  private recycleSlot(used: Uint8Array): number {
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
    const referenceHz = score.referenceHz > 0 ? score.referenceHz : 440;
    computeUnisonWarps(data, referenceHz);
    computeStrikeShares(data);
    const names = (score.voiceParts ?? []).slice(0, n);
    while (names.length < n) names.push('');
    let groupsReset = false;
    const fresh = names.filter((x) => !this.partGroups.has(x));
    if (this.partGroups.size + new Set(fresh).size > DSP_MAX_VOICES) {
      this.partGroups.clear();
      groupsReset = true;
    }
    const groups = new Int32Array(n);
    names.forEach((name, i) => {
      let g = this.partGroups.get(name);
      if (g === undefined) {
        g = this.partGroups.size;
        this.partGroups.set(name, g);
      }
      groups[i] = g;
    });
    const lines = score.partLines ?? {};
    const used = [...new Set(names)];
    const peakOf = (name: string) => Math.max(1, lines[name] ?? 1);
    let total = 0;
    for (const name of used) total += peakOf(name);
    const share = new Float64Array(DSP_MAX_VOICES);
    for (const name of used) share[groups[names.indexOf(name)]] = Math.sqrt(peakOf(name) / total);
    return {
      data,
      voiceIds: score.voiceIds.slice(0, n),
      duration: Number.isFinite(score.duration) ? Math.max(0, score.duration) : 0,
      referenceHz,
      groups,
      distinctGroups: used.length,
      partShare: share,
      groupsReset,
    };
  }

  private applyMeta(p: PreparedScore): void {
    this.voiceCount = p.data.length;
    this.voiceIds = p.voiceIds;
    this.duration = p.duration;
    this.durationFrames = Math.round(p.duration * this.sampleRate);
    this.ctx.refOct = pmath.log2(p.referenceHz / MIP_BASE_HZ);
    this.updateSolo(p.data);
    if (p.groupsReset) this.groupQuiet.fill(1);
    // Groups this score does not use start afresh if a later score brings them back.
    for (let g = 0; g < DSP_MAX_VOICES; g++) if (p.partShare[g] === 0) this.groupQuiet[g] = 1;
    this.voiceGroup.fill(0);
    this.voiceGroup.set(p.groups);
    this.distinctGroups = p.distinctGroups;
    this.partShare.set(p.partShare);
    this.updateNormMode();
  }

  /**
   * Points each voice at its g_n row: its group's when normalising per part, else row 0. Turning
   * per-part on starts every group from the shared g_n; turning it off keeps group 0's.
   */
  private updateNormMode(): void {
    const on = this.mix.normPart && this.distinctGroups > 1;
    if (on && !this.normPart) {
      for (let g = 1; g < DSP_MAX_VOICES; g++) this.gnVal[g] = this.gnVal[0];
      this.groupQuiet.fill(0);
    }
    this.normPart = on;
    for (let i = 0; i < DSP_MAX_VOICES; i++)
      this.voices[i].gnOff = on ? this.voiceGroup[i] * GN_ROW : 0;
  }

  private updateSolo(data: VoiceData[]): void {
    let any = false;
    for (const d of data) if (d.solo) any = true;
    this.ctx.anySolo = any;
  }

  private applyMix(immediate: boolean): void {
    const m = this.mix;
    // Through the FX's param arrays, not double arguments (those would be boxed per edit).
    const rp = this.reverb.params;
    rp[0] = m.reverbSize;
    rp[1] = m.reverbDecay;
    rp[2] = m.reverbDamping;
    rp[3] = m.reverbPreDelay;
    this.reverb.applyParams(immediate);
    this.delay.params[0] = m.delayTime;
    this.delay.params[1] = m.delayFeedback;
    this.delay.applyParams(immediate);
    this.tone.params[0] = m.toneTilt;
    this.tone.params[1] = m.toneLowpassHz;
    this.tone.applyParams(immediate);
    this.limiter.params[0] = m.ceilingDb;
    this.limiter.applyParams();
    this.ctx.sendReverb = Math.max(0, m.sendReverb);
    this.ctx.sendDelay = Math.max(0, m.sendDelay);
    this.ctx.panByPitch = m.panByPitch;
    this.updateNormMode();
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

  /** Re-initialises g_n to 1/√(Σ life × line weights) at the current position (after a jump). */
  private resetNorm(): void {
    if (this.normPart) {
      this.sumGroups(this.pieceFrame, 0);
      const nG = this.partGroups.size;
      for (let g = 0; g < nG; g++) {
        const sum = this.groupSum[g];
        this.gnVal[g] = this.partShare[g] / Math.sqrt(sum > 1 ? sum : 1);
      }
      return;
    }
    let sum = 0;
    for (let i = 0; i < this.voiceCount; i++) {
      const v = this.voices[i];
      v.computeLife(this.pieceFrame, 0);
      sum += v.powTick[0];
    }
    this.gnVal[0] = 1 / Math.sqrt(sum > 1 ? sum : 1);
  }

  /** Σ life × line weights per normalisation group at `frame` into groupSum (powTick[slot]). */
  private sumGroups(frame: number, slot: number): void {
    const sums = this.groupSum;
    sums.fill(0);
    for (let i = 0; i < this.voiceCount; i++) {
      const v = this.voices[i];
      v.computeLife(frame, slot);
      sums[this.voiceGroup[i]] += v.powTick[slot];
    }
  }

  private computeNorm(): void {
    const gn = this.ctx.gn;
    if (this.normPart) {
      this.computePartNorm();
      return;
    }
    let gv = this.gnVal[0];
    gn[0] = gv;
    for (let k = 1; k <= TICKS_PER_BLOCK; k++) {
      if (this.playing) {
        const frame = this.pieceFrame + k * CONTROL_PERIOD;
        let sum = 0;
        for (let i = 0; i < this.voiceCount; i++) {
          const v = this.voices[i];
          v.computeLife(frame, k);
          sum += v.powTick[k];
        }
        const target = 1 / Math.sqrt(sum > 1 ? sum : 1);
        gv += (target - gv) * this.normCoeff;
      }
      gn[k] = gv;
    }
    this.gnVal[0] = gv;
  }

  /**
   * Per-part g_n (§8.4 revision 10): each group's lines by 1/√(its own Σ life × line weights),
   * times its static share (partShare), each smoothed like g_n.
   */
  private computePartNorm(): void {
    const gn = this.ctx.gn;
    const val = this.gnVal;
    const share = this.partShare;
    const sums = this.groupSum;
    const nG = this.partGroups.size;
    for (let g = 0; g < nG; g++) gn[g * GN_ROW] = val[g];
    for (let k = 1; k <= TICKS_PER_BLOCK; k++) {
      if (this.playing) {
        this.sumGroups(this.pieceFrame + k * CONTROL_PERIOD, k);
        for (let g = 0; g < nG; g++) {
          const sum = sums[g];
          const target = share[g] / Math.sqrt(sum > 1 ? sum : 1);
          if (this.groupQuiet[g] === 1) {
            // A part new to this graph (load or hot-swap) starts at its own level.
            val[g] = target;
            if (sum > 0) this.groupQuiet[g] = 0;
          } else val[g] += (target - val[g]) * this.normCoeff;
        }
      }
      for (let g = 0; g < nG; g++) gn[g * GN_ROW + k] = val[g];
    }
  }

  /** Clears the unison-lock state (on load). */
  private resetGroups(): void {
    const ctx = this.ctx;
    this.gWas.fill(0);
    this.gLamS.fill(0);
    this.gHS.fill(1);
    this.gCap.fill(0);
    this.gCapW.fill(0);
    ctx.gOk.fill(0);
    ctx.gLam.fill(0);
    ctx.gCorr.fill(0);
    ctx.gDInc.fill(0);
    ctx.gDLfo.fill(0);
    ctx.gH0.fill(1);
    ctx.gH1.fill(1);
    ctx.gSnapPh.fill(NaN);
  }

  /** cos and sin of 2π·src[i] into c[i], s[i] (shared sine table; src[i] in [0, 1)). */
  private static trig(src: Float64Array, i: number, c: Float64Array, s: Float64Array): void {
    let x = src[i];
    x -= Math.floor(x);
    const N = SINE_TABLE_SIZE;
    const pos = x * N;
    const i0 = pos | 0;
    const a = SINE[i0];
    s[i] = a + (SINE[i0 + 1] - a) * (pos - i0);
    let cpos = pos + N / 4;
    if (cpos >= N) cpos -= N;
    const c0 = cpos | 0;
    const b = SINE[c0];
    c[i] = b + (SINE[c0 + 1] - b) * (cpos - c0);
  }

  /**
   * The unison-lock group pass (once per block, before the voices render). From each voice's state
   * at the end of the last block it computes, per voice j:
   * - pair weights w(j, l): 1 when the score pitches are within LOCK_FULL cents, 0 beyond
   *   LOCK_EDGE, smoothstep between, times both voices' lockability (VoiceContext.lockable);
   * - the lock amount λ_j = max over l of w(j, l), smoothed (fast up, slower down);
   * - a pitch correction λ_j·(m̄ − m_j) toward the group's mean modulated pitch m̄ (detune, drift
   *   and vibrato included), weighted by amplitude and settled stillness (STILL_SETTLE);
   * - a phase pull toward the group's mean phase, weighted the same way, and the same for the
   *   vibrato phase; while a voice is parting from a close neighbour, a release pull instead
   *   unwinds the phase pull it has accumulated;
   * - the group gain h_j = √(Σ_l w²A_l²) / |Z_j|, Z_j = Σ_l w·A_l·e^{2πiφ_l} with the actual
   *   phases (capped at +3 dB, smoothed), so a coherent group
   *   sums to the power of the same voices spread out (incoherent), whatever its phases.
   * While either voice of a pair runs a unison warp, the pair is also captured: phase pull from
   * CAPTURE_EDGE cents (arriving only) and a place in h while it beats slower than CAPTURE_H_EDGE
   * Hz; h targets the phases predicted for the block end.
   * A voice starting from silence (seek, birth) takes its group's phase at once (gSnapPh), so the
   * lock holds from its first sample. All inputs are block-start state, which every render mode
   * computes identically, so stems sum exactly. Allocation-free.
   */
  private computeGroups(): void {
    const ctx = this.ctx;
    const n = this.voiceCount;
    const part = this.gPart;
    const P = this.gP;
    const Am = this.gA;
    const M = this.gM;
    const Lk = this.gL;
    const INC = this.gInc;
    const CX = this.gCx;
    const SY = this.gSy;
    const LX = this.gLx;
    const LY = this.gLy;
    const V = this.gV;
    const ST = this.gStill;
    const WG = this.gWg;
    const CW = this.gCapW;
    const HX = this.gHx;
    const HY = this.gHy;
    const frameEnd = this.pieceFrame + BLOCK_FRAMES;
    let any = 0;
    for (let i = 0; i < n; i++) {
      const v = this.voices[i];
      part[i] = 0;
      ctx.gSnapPh[i] = NaN;
      const cap0 = this.gCap[i];
      this.gCap[i] = 0;
      this.gCapW[i] = 0;
      if (!v.enabled) continue;
      if (!v.isFresh && ctx.gOk[i] === 1) {
        part[i] = 1;
        P[i] = ctx.gPitch[i];
        Am[i] = ctx.gAmp[i];
        M[i] = ctx.gMod[i];
        Lk[i] = ctx.gLock[i];
        INC[i] = ctx.gInc[i];
        this.gTh[i] = ctx.gTheta[i];
        WG[i] = ctx.gWarp[i];
        this.gV[i] = this.gWas[i] === 1 ? (P[i] - this.gPrevP[i]) * this.invBlockSeconds : 0;
      } else if (v.lifeTick[TICKS_PER_BLOCK] > 0) {
        // Starts this block (seek, birth, swap): probe where it starts.
        const d = v.data;
        d.probe(frameEnd, this.sampleRate);
        d.probeMix(this.slots);
        const slot = d.probeSlot;
        const pp = d.probePitch;
        if (slot < 0 || !(pp === pp) || this.slots[slot].data === null) continue;
        part[i] = 2;
        P[i] = pp * 100;
        M[i] = P[i];
        PR[0] = -(pp - LOUDNESS_PITCH) * LOUDNESS_SLOPE;
        pmath.expR();
        Am[i] = VOICE_BASE_GAIN * d.gain * d.probeLife * PR[0];
        Lk[i] = ctx.lockable;
        INC[i] = 0;
        this.gTh[i] = 0;
        this.gV[i] = 0;
        WG[i] = 0;
        v.publishPhase(ctx);
      } else continue;
      // Capture gate (CAPTURE_RAMP): towards 1 while the warp runs, towards 0 otherwise.
      let g = cap0 + (WG[i] > 0 ? this.capStep : -this.capStep);
      g = g < 0 ? 0 : g > 1 ? 1 : g;
      this.gCap[i] = g;
      this.gCapW[i] = g * g * (3 - 2 * g);
      const vi = this.gV[i] < 0 ? -this.gV[i] : this.gV[i];
      const still = 1 / (1 + vi * INV_STILL_SPEED);
      const prev = this.gStill[i];
      this.gStill[i] =
        part[i] === 2 || this.gWas[i] === 0 || still < prev
          ? still
          : prev + (still - prev) * this.stillCoeff;
      Graph.trig(ctx.gPhase, i, CX, SY);
      Graph.trig(ctx.gLfo, i, LX, LY);
      // Phase at the end of this block, for h (which is interpolated up to it across the block).
      this.gPred[i] = ctx.gPhase[i] + INC[i] * BLOCK_FRAMES;
      Graph.trig(this.gPred, i, HX, HY);
      any++;
    }

    // Voices starting from silence take their group's phase: the amplitude-weighted mean of the
    // running members, else the lowest-index starting member's (all start on the same tick).
    for (let j = 0; j < n; j++) {
      if (part[j] !== 2 || !(Lk[j] > 0)) continue;
      let sx = 0;
      let sy = 0;
      let lx = 0;
      let ly = 0;
      let swa = 0;
      let sinc = 0;
      let first = -1;
      for (let l = 0; l < n; l++) {
        if (l === j || part[l] === 0) continue;
        const dp = P[j] - P[l];
        const dist = dp < 0 ? -dp : dp;
        if (dist >= LOCK_EDGE) continue;
        let w = (LOCK_EDGE - dist) * INV_LOCK_SPAN;
        if (w > 1) w = 1;
        w = w * w * (3 - 2 * w) * Lk[l];
        if (!(w > 0)) continue;
        if (part[l] === 1) {
          const wa = w * Am[l] * ST[l];
          sx += wa * CX[l];
          sy += wa * SY[l];
          lx += wa * LX[l];
          ly += wa * LY[l];
          sinc += wa * INC[l];
          swa += wa;
        } else if (first < 0 && l < j) first = l;
      }
      let ph: number;
      let lfo: number;
      let inc = 0;
      if (swa > 0 && sx * sx + sy * sy > 1e-24) {
        // Angles of (sx, sy) and, if long enough, (lx, ly) in turns: pmath.atan2R's body inline
        // (see pmath.ts, "Audio thread").
        ph = 0;
        lfo = ctx.gLfo[j];
        const angles = lx * lx + ly * ly > 1e-24 ? 2 : 1;
        for (let a = 0; a < angles; a++) {
          const y = a === 0 ? sy : ly;
          const x = a === 0 ? sx : lx;
          const ax = Math.abs(x);
          const ay = Math.abs(y);
          let r = 0;
          if (ax === ay) r = pmath.QUARTER_PI;
          else if (ay !== 0) {
            const swap = ay > ax;
            const t = swap ? ax / ay : ay / ax;
            let base = 0;
            let z = t;
            if (t > pmath.TAN_PI_12) {
              base = pmath.SIXTH_PI;
              z = (t * pmath.SQRT3 - 1) / (pmath.SQRT3 + t);
            }
            const z2 = z * z;
            let acc = ATAN_C[15];
            for (let k = 14; k >= 0; k--) acc = acc * z2 + ATAN_C[k];
            r = base + z * acc;
            if (swap) r = pmath.HALF_PI - r;
          }
          if (x < 0) r = pmath.PI - r;
          if (y < 0) r = -r;
          if (a === 0) ph = r * INV_TWO_PI;
          else lfo = r * INV_TWO_PI;
        }
        inc = sinc / swa;
      } else if (first >= 0) {
        const fp = ctx.gSnapPh[first];
        ph = fp === fp ? fp : ctx.gPhase[first];
        lfo = fp === fp ? ctx.gSnapLfo[first] : ctx.gLfo[first];
      } else continue;
      ph -= Math.floor(ph);
      lfo -= Math.floor(lfo);
      ctx.gSnapPh[j] = ph;
      ctx.gSnapLfo[j] = lfo;
      ctx.gSnapInc[j] = inc;
      ctx.gPhase[j] = ph;
      ctx.gLfo[j] = lfo;
      Graph.trig(ctx.gPhase, j, CX, SY);
      Graph.trig(ctx.gLfo, j, LX, LY);
      this.gPred[j] = ph + inc * BLOCK_FRAMES;
      Graph.trig(this.gPred, j, HX, HY);
    }

    // Per-voice lock controls.
    for (let j = 0; j < DSP_MAX_VOICES; j++) {
      if (j >= n || part[j] === 0) {
        this.gWas[j] = 0;
        this.gLamS[j] = 0;
        this.gHS[j] = 1;
        ctx.gLam[j] = 0;
        ctx.gCorr[j] = 0;
        ctx.gDInc[j] = 0;
        ctx.gDLfo[j] = 0;
        ctx.gH0[j] = 1;
        ctx.gH1[j] = 1;
        continue;
      }
      // Z (for h): amplitude-weighted phasor sum and Σ w²A². T: the stillness-weighted target sums
      // for pitch (sa, sam), phase (tx, ty) and vibrato phase (lx, ly).
      const aj = Am[j];
      const tj = aj * ST[j];
      let zx = aj * HX[j];
      let zy = aj * HY[j];
      let tx = tj * CX[j];
      let ty = tj * SY[j];
      let lx = tj * LX[j];
      let ly = tj * LY[j];
      let q = aj * aj;
      let sa = tj;
      let sam = tj * M[j];
      let lamT = 0;
      let lamC = 0;
      let parting = 0;
      // Members of j's sum Z (j first), for timbreZ2.
      const memb = this.gMemb;
      const membC = this.gMembC;
      memb[0] = j;
      membC[0] = aj;
      let mc = 1;
      if (any > 1 && Lk[j] > 0) {
        const wj = WG[j];
        for (let l = 0; l < n; l++) {
          if (l === j || part[l] === 0) continue;
          const dp = P[j] - P[l];
          const dist = dp < 0 ? -dp : dp;
          // Capture: while either voice of a pair runs a unison warp, the pair's phases pull
          // together from CAPTURE_EDGE cents, and it counts for h while it beats slower than
          // CAPTURE_H_EDGE Hz.
          const gc = CW[j] > CW[l] ? CW[j] : CW[l];
          const cap = gc > 0;
          const inc = INC[j] > INC[l] ? INC[j] : INC[l];
          const hz = dist * inc * this.centsToHz;
          if (cap ? dist >= CAPTURE_EDGE && hz >= CAPTURE_H_EDGE : dist >= LOCK_EDGE) continue;
          const lkk = Lk[j] * Lk[l];
          let w = 0;
          if (dist < LOCK_EDGE) {
            w = (LOCK_EDGE - dist) * INV_LOCK_SPAN;
            if (w > 1) w = 1;
            w = w * w * (3 - 2 * w) * lkk;
          }
          let wc = 0;
          let wh = 0;
          if (cap) {
            if (dist < CAPTURE_EDGE && (wj === 1 || WG[l] === 1)) {
              wc = (CAPTURE_EDGE - dist) * INV_CAPTURE_SPAN;
              if (wc > 1) wc = 1;
              wc = wc * wc * (3 - 2 * wc) * lkk * gc;
              if (wc > lamC) lamC = wc;
            }
            if (hz < CAPTURE_H_EDGE) {
              wh = (CAPTURE_H_EDGE - hz) * INV_CAPTURE_H_SPAN;
              if (wh > 1) wh = 1;
              wh = wh * wh * (3 - 2 * wh) * lkk * gc;
            }
          }
          const we = Math.max(w, wc);
          const wz = Math.max(w, wh);
          if (!(we > 0 || wz > 0)) continue;
          // Pairs moving apart leave the group early (separation speed, cents/s).
          const sep = dp < 0 ? V[l] - V[j] : V[j] - V[l];
          if (sep > SEP_START) {
            let g = 1 - (sep - SEP_START) * INV_SEP_SPAN;
            if (g < 0) g = 0;
            const lw = w * g * g * (3 - 2 * g);
            if (lw > lamT) lamT = lw;
            // A warped parting needs no unwinding: h covers its slow beats.
            if (!cap && w - lw > parting) parting = w - lw;
          } else if (w > lamT) lamT = w;
          const za = wz * Am[l];
          if (za > 0) {
            memb[mc] = l;
            membC[mc] = za;
            mc++;
          }
          zx += za * HX[l];
          zy += za * HY[l];
          q += za * za;
          const wt = we * Am[l] * ST[l];
          tx += wt * CX[l];
          ty += wt * SY[l];
          lx += wt * LX[l];
          ly += wt * LY[l];
          const wp = w * Am[l] * ST[l];
          sa += wp;
          sam += wp * M[l];
        }
      }
      const starting = part[j] === 2 || this.gWas[j] === 0;
      let lam = this.gLamS[j];
      if (starting) lam = lamT;
      else lam += (lamT - lam) * (lamT > lam ? this.lockUp : this.lockDown);
      this.gLamS[j] = lam;
      ctx.gLam[j] = lam;
      ctx.gCorr[j] = sa > 0 ? lam * (sam / sa - M[j]) : 0;

      let z2 = zx * zx + zy * zy;
      if (mc > 1 && this.timbreZ2(mc) === 1) z2 = this.gZ2[0];
      let dInc = 0;
      let dLfo = 0;
      if (part[j] === 1) {
        const t2 = tx * tx + ty * ty;
        if ((lam > 0 || lamC > 0) && t2 > 1e-24) {
          // sin(arg T − φ_j) = Im(T · e^{−iφ_j}) / |T|. Beyond a quarter cycle the pull is full
          // (not sin): a voice caught near anti-phase must not hang there (a level dip).
          let sd = (ty * CX[j] - tx * SY[j]) / Math.sqrt(t2);
          if (tx * CX[j] + ty * SY[j] < 0) sd = sd < 0 ? -1 : 1;
          dInc =
            sd *
            Math.max(
              lam * Math.min(LOCK_PULL * INC[j], this.pullMaxInc),
              lamC * Math.min(CAPTURE_PULL * INC[j], this.pullMaxInc),
            );
          const l2 = lx * lx + ly * ly;
          if (l2 > 1e-24) dLfo = (lam * LOCK_LFO_PULL * (ly * LX[j] - lx * LY[j])) / Math.sqrt(l2);
        }
        // Release while parting: unwind θ (sin 2πθ from the sine table; θ in [−0.5, 0.5)).
        const th = this.gTh[j];
        if (parting > 0 && th !== 0) {
          let pos = (th + 1) * SINE_TABLE_SIZE;
          if (pos >= SINE_TABLE_SIZE) pos -= SINE_TABLE_SIZE;
          const i0 = pos | 0;
          const a = SINE[i0];
          const sth = a + (SINE[i0 + 1] - a) * (pos - i0);
          dInc -= parting * sth * Math.min(LOCK_RELEASE_PULL * INC[j], this.pullMaxInc);
        }
      }
      ctx.gDInc[j] = dInc;
      ctx.gDLfo[j] = dLfo;

      // Group gain: h² = Σ w²A² / |Z|², at most LOCK_H2_MAX.
      const h2 = q > 0 ? Math.min(LOCK_H2_MAX, q / z2) : 1;
      const hT = Math.sqrt(h2);
      let h = this.gHS[j];
      const h0 = starting ? hT : h;
      if (starting) h = hT;
      else h += (hT - h) * this.lockGain;
      this.gHS[j] = h;
      ctx.gH0[j] = h0;
      ctx.gH1[j] = h;
      this.gWas[j] = 1;
      this.gPrevP[j] = P[j];
    }
  }

  /**
   * |Z|² for a group whose members sound different timbres (or mixes), else 0 and nothing: the
   * phasor sum assumes every member's waveform is the same, so they add as amplitudes. Members a
   * and b sounding different spectra add with their correlation ρ_ab instead (phase-locked
   * harmonics as amplitudes, the free-running parts of a shared table and the noise as before,
   * anything else as powers): |Z|² = Σ_ab c_a·c_b·ρ_ab·cos(φ_a − φ_b), so h keeps the group at
   * the level of the same voices in a chord. Members starting this block, or without coherence
   * rows, count as matching everyone; a group none of whose voices has timbre changes is left
   * alone. Reads gMemb/gMembC (mc members), writes gZ2[0]; returns 1
   * when it did.
   */
  private timbreZ2(mc: number): number {
    const ctx = this.ctx;
    const memb = this.gMemb;
    const part = this.gPart;
    const tab = ctx.gTab;
    // Only for groups with a voice that changes timbre: static multi-timbre unisons keep the
    // amplitude sum, bit for bit (render goldens; docs/build-log.md, "M6-b2").
    let moves = false;
    for (let a = 0; a < mc && !moves; a++) moves = this.voices[memb[a]].changesTimbre;
    if (!moves) return 0;
    let ref: Float32Array | null = null;
    let mixed = false;
    let known = 0;
    for (let a = 0; a < mc; a++) {
      const v = memb[a];
      if (part[v] !== 1) continue;
      const t = this.voices[v].soleTable();
      if (known === 0) ref = t;
      else if (t !== ref) mixed = true;
      if (t === null) mixed = true;
      known++;
    }
    if (!mixed || known < 2) return 0;
    // Spectra of the members, once per block each.
    for (let a = 0; a < mc; a++) {
      const v = memb[a];
      if (part[v] !== 1 || this.gCohStamp[v] === this.renderFrame) continue;
      this.gCohStamp[v] = this.renderFrame;
      this.voices[v].publishTimbre(ctx);
    }
    const C = COH_STRIDE;
    const coh = ctx.gCoh;
    const HX = this.gHx;
    const HY = this.gHy;
    const membC = this.gMembC;
    let z2 = 0;
    for (let a = 0; a < mc; a++) {
      const va = memb[a];
      const ca = membC[a];
      z2 += ca * ca;
      const ka = part[va] === 1 && ctx.gCohOk[va] === 1;
      for (let b = a + 1; b < mc; b++) {
        const vb = memb[b];
        let rho = 1;
        if (ka && part[vb] === 1 && ctx.gCohOk[vb] === 1 && tab[va] !== tab[vb]) {
          const oa = va * C;
          const ob = vb * C;
          let num = 0;
          for (let i = 0; i <= COH_NOISE; i++) num += coh[oa + i] * coh[ob + i];
          for (let r = 0; r < 4; r++) {
            const ta = ctx.gRoleTab[va * 4 + r];
            if (ta === null) continue;
            for (let q = 0; q < 4; q++) {
              if (ctx.gRoleTab[vb * 4 + q] !== ta) continue;
              num +=
                ctx.gRoleG[va * 4 + r] *
                ctx.gRoleG[vb * 4 + q] *
                Math.sqrt(ctx.gRoleRest[va * 4 + r] * ctx.gRoleRest[vb * 4 + q]);
            }
          }
          rho = num / Math.sqrt(coh[oa + COH_REST] * coh[ob + COH_REST]);
        }
        z2 += 2 * ca * membC[b] * rho * (HX[va] * HX[vb] + HY[va] * HY[vb]);
      }
    }
    this.gZ2[0] = z2 > 1e-30 ? z2 : 1e-30;
    return 1;
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
    this.gnScratch[0] = this.gnVal[(v.gnOff / GN_ROW) | 0];
    g.freezeGn(this.gnScratch, 0);
    g.fadeOut(frames);
    return true;
  }

  /** Fades every sounding main voice out through ghosts; false if ghosts ran out (not forced). */
  private fadeOutMains(frames: number, force: boolean): boolean {
    if (!force) {
      let needed = 0;
      for (let i = 0; i < DSP_MAX_VOICES; i++) {
        const v = this.voices[i];
        if (v.enabled && v.isSounding()) needed++;
      }
      if (needed > this.freeGhosts()) return false;
    }
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.enabled && v.isSounding()) this.ghostOf(v, frames, force);
      v.enabled = false;
    }
    return true;
  }

  /** Starts every main voice at the current position with a fade-in. */
  private startMains(frames: number): void {
    for (let i = 0; i < DSP_MAX_VOICES; i++) {
      const v = this.voices[i];
      v.enabled = i < this.voiceCount;
      if (!v.enabled) continue;
      v.jump(this.pieceFrame, true);
      v.fadeIn(frames);
    }
    this.resetNorm();
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

  private applySwap(): void {
    const next = this.pendingSwap as PreparedScore;
    const n = next.data.length;
    if (this.playing) {
      let needed = 0;
      for (let i = 0; i < DSP_MAX_VOICES; i++) {
        const v = this.voices[i];
        const nd = i < n ? next.data[i] : EMPTY_VOICE_DATA;
        if (
          v.enabled &&
          v.isSounding() &&
          v.swapNeedsCrossfade(nd, this.pieceFrame, this.sampleRate, this.slots)
        )
          needed++;
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
        v.jump(this.pieceFrame, true);
        continue;
      }
      const audible = v.enabled && v.isSounding();
      if (audible && v.swapNeedsCrossfade(nd, this.pieceFrame, this.sampleRate, this.slots)) {
        this.ghostOf(v, this.swapFadeFrames, true);
        v.data = nd;
        if (identityChanged) v.setIdentity(i, nd.hash, this.seed, this.voiceCount);
        v.enabled = i < n;
        v.jump(this.pieceFrame, true);
        v.fadeIn(this.swapFadeFrames);
      } else if (audible) {
        v.slewFromCurrent(this.swapFadeFrames);
        v.data = nd;
        v.jump(this.pieceFrame, false);
      } else {
        v.data = nd;
        if (identityChanged) v.setIdentity(i, nd.hash, this.seed, this.voiceCount);
        v.enabled = i < n;
        v.jump(this.pieceFrame, true);
        // Whatever the new score sounds here ramps in over 20 ms instead of starting abruptly.
        v.slewFromSilence(this.swapFadeFrames);
      }
    }
    this.anchor(AnchorReason.Swap);
  }
}
