/**
 * The live lines' samples (PLAN.md §9; drawn by render/live.ts `drawLiveLines`): once per frame
 * while live, each live voice's pitch (bend included) and level at the engine's "now", read from
 * the LiveEngine's mirror (`tracks.pitchAt` / `levelAt`, no allocation). A ring of about 30 s at
 * 60 fps; the mirror's own history is compacted, so the trail keeps its own samples.
 */

import type { LiveTrail } from '../render';

/** Samples kept per voice. */
export const TRAIL_CAP = 1800;
/** Live voices drawn at most (DSP_MAX_VOICES). */
const MAX_VOICES = 32;

/** What the trail reads from the live engine. */
export interface TrailSource {
  readonly active: boolean;
  now(): number;
  readonly bendSemitones: number;
  readonly tracks: {
    readonly data: readonly unknown[];
    pitchAt(i: number, t: number): number;
    levelAt(i: number, t: number): number;
  } | null;
}

export class LiveTrailBuffer implements LiveTrail {
  cap = TRAIL_CAP;
  count = 0;
  next = 0;
  voices = 0;
  now = 0;
  colorIndex: readonly number[] = [];
  readonly times = new Float64Array(TRAIL_CAP);
  readonly pitch = new Float32Array(TRAIL_CAP * MAX_VOICES);
  readonly level = new Float32Array(TRAIL_CAP * MAX_VOICES);

  /** Empties the trail for a new live session of `voices` voices (colours by piece voice). */
  reset(voices: number, colorIndex: readonly number[]): void {
    this.count = 0;
    this.next = 0;
    this.voices = Math.min(MAX_VOICES, voices);
    this.colorIndex = colorIndex;
  }

  /** Appends the voices' state at the source's now. False when not live. */
  sample(src: TrailSource): boolean {
    const tr = src.tracks;
    if (!src.active || !tr) return false;
    const t = src.now();
    if (this.count > 0 && t <= this.times[(this.next - 1 + this.cap) % this.cap]) {
      this.now = t;
      return true;
    }
    const n = Math.min(this.voices, tr.data.length);
    const slot = this.next;
    const bend = src.bendSemitones;
    this.times[slot] = t;
    for (let v = 0; v < this.voices; v++) {
      const o = slot * this.voices + v;
      this.pitch[o] = v < n ? tr.pitchAt(v, t) + bend : NaN;
      this.level[o] = v < n ? tr.levelAt(v, t) : 0;
    }
    this.next = (slot + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    this.now = t;
    return true;
  }
}
