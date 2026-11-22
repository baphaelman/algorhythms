/**
 * Live mode without Web Audio, for the Node DSP tests and the no-GC harness: a graph loaded with
 * a live score, its LiveInput (what the worklet runs), and LiveEngine's main-thread decision path
 * (core `liveUpdate` on a mirror). Messages are queued as the worklet's port would deliver them:
 * between blocks, applied at the next one. The mirror applies each message when the rig reads its
 * stamp, at the stamped time, as LiveEngine does.
 */

import {
  clampBend,
  DEFAULT_LIVE_SETTINGS,
  LiveKeys,
  liveUpdate,
  mergeLiveSettings,
  type LiveSettings,
  type LiveUpdate,
} from '../../core/live';
import type { MixSettings, Pitch, Timbre } from '../../core/types';
import { BLOCK_FRAMES } from '../../dsp/constants';
import type { Graph } from '../../dsp/graph';
import { LiveInput, type LiveTracks } from '../../dsp/live';
import { createLoadedGraph } from '../offline';
import { encodeMoves, liveView, mirrorTracks } from '../live-mirror';
import { liveScore, type LiveSetup, type LiveVoiceSetup } from '../live-setup';

/** `n` voices over [lo, hi], starting at `start`, all on `timbre`. */
export function liveSetupOf(
  n: number,
  timbre = 'glass',
  range: [Pitch, Pitch] = [36, 84],
  start: Pitch = 60,
  mix?: MixSettings,
  timbres?: Record<string, Timbre>,
): LiveSetup {
  const voices: LiveVoiceSetup[] = [];
  for (let i = 0; i < n; i++) {
    voices.push({
      id: `v${i + 1}`,
      range: [range[0], range[1]],
      timbre,
      pitch: start,
      part: '',
      gain: 1,
      pan: 'auto',
      mute: false,
      solo: false,
      sends: {},
    });
  }
  return {
    voices,
    mix: mix ?? {
      reverb: { size: 0.6, decay: 2.4, damping: 0.4, preDelay: 0.02, returnLevel: 0.3 },
      delay: { time: 0.375, feedback: 0.3, returnLevel: 0.15 },
      sends: { reverb: 0.35, delay: 0.1 },
      tone: { tilt: 0, lowpassHz: 18000 },
      limiter: { ceilingDb: -1 },
      panAuto: 'index',
    },
    timbres,
    referenceHz: 440,
    seed: 7,
    key: { tonic: 'C', scale: 'major' },
  };
}

/** A graph in live mode plus the main-thread side, driven block by block. */
export class LiveRig {
  readonly graph: Graph;
  readonly input: LiveInput;
  /** The main thread's mirror (moves applied at their stamps). */
  readonly mirror: LiveTracks;
  readonly keys = new LiveKeys();
  settings: LiveSettings;
  /** Stamps read so far: seq → { frame (rendered frames), time }. */
  readonly stamps = new Map<number, { frame: number; time: number }>();
  readonly left: number[] = [];
  readonly right: number[] = [];
  /** Record output (`run`); off for the no-GC harness. */
  record = true;
  private readonly setup: LiveSetup;
  private readonly bl = new Float32Array(BLOCK_FRAMES);
  private readonly br = new Float32Array(BLOCK_FRAMES);
  private seq = 0;
  private frames = 0;

  constructor(setup: LiveSetup, settings: Partial<LiveSettings> = {}, sampleRate = 48000) {
    this.setup = setup;
    this.settings = mergeLiveSettings(DEFAULT_LIVE_SETTINGS, { key: setup.key, ...settings });
    this.graph = createLoadedGraph({
      score: liveScore(setup),
      mix: setup.mix,
      timbres: setup.timbres,
      sampleRate,
    });
    this.input = new LiveInput(this.graph, setup.voices.length);
    this.graph.play(0);
    this.mirror = mirrorTracks(setup);
  }

  /** Live time at the start of the next block (where a message posted now applies). */
  get time(): number {
    return this.graph.position;
  }

  /** What changing H now decides (on the mirror, at the next block's time). */
  decide(): LiveUpdate {
    const t = this.time;
    const view = liveView(this.mirror, this.setup.voices, t);
    return liveUpdate(view, this.keys.held, this.settings, (this.setup.seed + this.seq + 1) >>> 0);
  }

  /** Posts an update; returns its seq (−1 if empty). */
  post(update: LiveUpdate): number {
    if (update.moves.length === 0 && update.level === null) return -1;
    const seq = ++this.seq;
    const moves = encodeMoves(update.moves);
    const gain = update.level ? update.level.gain : NaN;
    const over = update.level ? update.level.over : 0;
    this.input.queue(seq, moves, update.moves.length, gain, over);
    // The rig decides on the mirror, so it must see this message now: LiveEngine's predicted
    // copy, applied at the time it will be stamped with (the next block).
    this.mirror.apply(moves, 0, update.moves.length, gain, over, this.time);
    return seq;
  }

  noteOn(p: Pitch): number {
    return this.keys.noteOn(p) ? this.post(this.decide()) : -1;
  }

  noteOff(p: Pitch): number {
    return this.keys.noteOff(p) ? this.post(this.decide()) : -1;
  }

  sustain(on: boolean): number {
    return this.keys.setSustain(on) ? this.post(this.decide()) : -1;
  }

  allOff(): number {
    return this.keys.allOff() ? this.post(this.decide()) : -1;
  }

  bend(semitones: number): void {
    this.input.setBend(clampBend(semitones, this.settings.bendRange));
  }

  /** Renders one block (applying queued messages first, as the worklet does). */
  block(): void {
    this.input.beforeBlock(this.frames);
    this.graph.process(this.bl, this.br);
    if (this.record) {
      for (let k = 0; k < this.input.appliedCount; k++) {
        const seq = this.input.appliedSeq[k];
        this.stamps.set(seq, { frame: this.input.appliedFrame, time: this.input.appliedTime });
      }
      for (let i = 0; i < BLOCK_FRAMES; i++) {
        this.left.push(this.bl[i]);
        this.right.push(this.br[i]);
      }
    }
    this.frames += BLOCK_FRAMES;
  }

  /** Renders whole blocks covering `seconds`. */
  run(seconds: number): void {
    const blocks = Math.ceil((seconds * this.graph.sampleRate) / BLOCK_FRAMES);
    for (let b = 0; b < blocks; b++) this.block();
  }

  out(): { left: Float32Array; right: Float32Array } {
    return { left: Float32Array.from(this.left), right: Float32Array.from(this.right) };
  }
}
