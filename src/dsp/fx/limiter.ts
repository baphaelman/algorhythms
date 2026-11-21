/**
 * Look-ahead peak limiter (PLAN.md §8.6, §8.8), stereo-linked, the only nonlinear stage.
 *
 * The signal is delayed by D = round(5 ms · fs) frames. The required gain
 * req(n) = min(1, ceiling / max|x(n)|) is held over a window of D + 1 frames (a sliding minimum),
 * released exponentially, and smoothed by a box filter of D frames. Every value averaged into the
 * gain applied to sample n − D is a minimum over a window that contains n − D, so the output never
 * exceeds the ceiling, and the gain moves smoothly (no clicks) both ways.
 *
 * Stems (§12): the per-sample gain g_L can be recorded (capture) and replayed (replay mode applies
 * the recorded curve instead of computing one), so any linear part of the mix pushed through the
 * same delay and × g_L sums exactly to the mix. The applied gain is rounded to float32 in every
 * mode, so a recorded Float32Array reproduces it bit for bit.
 */

import * as pmath from '../pmath';

const LOOKAHEAD = 0.005;
const RELEASE = 0.08;
/** Headroom below the ceiling that absorbs float rounding of the gain and the output. */
const SAFETY = 1 - 1e-6;

export class Limiter {
  /** Look-ahead delay in frames. */
  readonly delay: number = 0;
  private readonly dL: Float64Array;
  private readonly dR: Float64Array;
  private dPos = 0;
  // Sliding minimum over D + 1 frames: a monotonic deque in a ring.
  private readonly window: number = 0;
  private readonly dqVal: Float64Array;
  private readonly dqIdx: Float64Array;
  private readonly dqCap: number = 0;
  private dqHead = 0;
  private dqSize = 0;
  private n = 0;
  // Release and box smoothing.
  private env = 1;
  private readonly relCoef: number = 0;
  private readonly box: Float64Array;
  private boxPos = 0;
  private boxSum: number = 0;
  private ceiling = 1;

  /** When set, every applied gain is written here at `cursor` (then cursor advances). */
  capture: Float32Array | null = null;
  /** When set, gains are read from here instead of computed. */
  replay: Float32Array | null = null;
  /** Frame index into capture/replay. */
  cursor = 0;

  constructor(sampleRate: number) {
    this.delay = Math.max(1, Math.round(LOOKAHEAD * sampleRate));
    const D = this.delay;
    this.dL = new Float64Array(D);
    this.dR = new Float64Array(D);
    this.window = D + 1;
    this.dqCap = D + 2;
    this.dqVal = new Float64Array(this.dqCap);
    this.dqIdx = new Float64Array(this.dqCap);
    this.box = new Float64Array(D).fill(1);
    this.boxSum = D;
    this.relCoef = 1 - pmath.exp(-1 / (RELEASE * sampleRate));
    this.setCeilingDb(-1);
  }

  /** Output ceiling in dBFS. */
  setCeilingDb(db: number): void {
    const c = Number.isFinite(db) ? Math.min(0, db) : -1;
    pmath.R[0] = c;
    pmath.dbToGainR();
    this.ceiling = pmath.R[0] * SAFETY;
  }

  /** Clears state: unity gain, silent delay line. */
  reset(): void {
    this.dL.fill(0);
    this.dR.fill(0);
    this.dPos = 0;
    this.dqHead = 0;
    this.dqSize = 0;
    this.n = 0;
    this.env = 1;
    this.box.fill(1);
    this.boxPos = 0;
    this.boxSum = this.delay;
    this.cursor = 0;
  }

  /** Limits `frames` stereo samples from inL/inR into outL/outR. Allocation-free. */
  process(
    inL: Float64Array,
    inR: Float64Array,
    outL: Float32Array,
    outR: Float32Array,
    frames: number,
  ): void {
    const D = this.delay;
    const dL = this.dL;
    const dR = this.dR;
    const replay = this.replay;
    const capture = this.capture;
    const cap = this.dqCap;
    const vals = this.dqVal;
    const idxs = this.dqIdx;
    const box = this.box;
    const ceiling = this.ceiling;
    const window = this.window;
    const rel = this.relCoef;
    let head = this.dqHead;
    let size = this.dqSize;
    let n = this.n;
    let env = this.env;
    let boxPos = this.boxPos;
    let boxSum = this.boxSum;
    let cursor = this.cursor;
    let dPos = this.dPos;
    for (let i = 0; i < frames; i++) {
      const xl = inL[i];
      const xr = inR[i];
      let g: number;
      if (replay !== null) {
        g = cursor < replay.length ? replay[cursor] : 1;
      } else {
        const al = xl < 0 ? -xl : xl;
        const ar = xr < 0 ? -xr : xr;
        const peak = al > ar ? al : ar;
        const req = peak > ceiling ? ceiling / peak : 1;
        // Sliding minimum over the last D + 1 values: drop larger values from the back, append,
        // then drop expired values from the front.
        while (size > 0) {
          const back = (head + size - 1) % cap;
          if (vals[back] >= req) size--;
          else break;
        }
        const slot = (head + size) % cap;
        vals[slot] = req;
        idxs[slot] = n;
        size++;
        while (idxs[head] <= n - window) {
          head = (head + 1) % cap;
          size--;
        }
        n++;
        const held = vals[head];
        // Instant attack (the box filter smooths it), exponential release.
        env = held < env ? held : env + (held - env) * rel;
        boxSum += env - box[boxPos];
        box[boxPos] = env;
        boxPos = boxPos + 1 === D ? 0 : boxPos + 1;
        g = Math.fround(boxSum / D);
      }
      if (capture !== null && cursor < capture.length) capture[cursor] = g;
      cursor++;
      outL[i] = dL[dPos] * g;
      outR[i] = dR[dPos] * g;
      dL[dPos] = xl;
      dR[dPos] = xr;
      dPos = dPos + 1 === D ? 0 : dPos + 1;
    }
    this.dqHead = head;
    this.dqSize = size;
    this.n = n;
    this.env = env;
    this.boxPos = boxPos;
    this.boxSum = boxSum;
    this.cursor = cursor;
    this.dPos = dPos;
  }
}
