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

const LOOKAHEAD = 0.005;
const RELEASE = 0.08;
/** Headroom below the ceiling that absorbs float rounding of the gain and the output. */
const SAFETY = 1 - 1e-6;

export class Limiter {
  /** Look-ahead delay in frames. */
  readonly delay: number;
  private readonly dL: Float64Array;
  private readonly dR: Float64Array;
  private dPos = 0;
  // Sliding minimum over D + 1 frames: a monotonic deque in a ring.
  private readonly window: number;
  private readonly dqVal: Float64Array;
  private readonly dqIdx: Float64Array;
  private readonly dqCap: number;
  private dqHead = 0;
  private dqSize = 0;
  private n = 0;
  // Release and box smoothing.
  private env = 1;
  private readonly relCoef: number;
  private readonly box: Float64Array;
  private boxPos = 0;
  private boxSum: number;
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
    this.relCoef = 1 - Math.exp(-1 / (RELEASE * sampleRate));
    this.setCeilingDb(-1);
  }

  /** Output ceiling in dBFS. */
  setCeilingDb(db: number): void {
    const c = Number.isFinite(db) ? Math.min(0, db) : -1;
    this.ceiling = Math.pow(10, c / 20) * SAFETY;
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

  /** Limits `frames` stereo samples from inL/inR into outL/outR. */
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
    for (let i = 0; i < frames; i++) {
      const xl = inL[i];
      const xr = inR[i];
      let g: number;
      if (replay !== null) {
        g = this.cursor < replay.length ? replay[this.cursor] : 1;
      } else {
        const al = xl < 0 ? -xl : xl;
        const ar = xr < 0 ? -xr : xr;
        const peak = al > ar ? al : ar;
        const req = peak > this.ceiling ? this.ceiling / peak : 1;
        g = Math.fround(this.gainFor(req));
      }
      if (capture !== null && this.cursor < capture.length) capture[this.cursor] = g;
      this.cursor++;
      const p = this.dPos;
      outL[i] = dL[p] * g;
      outR[i] = dR[p] * g;
      dL[p] = xl;
      dR[p] = xr;
      this.dPos = p + 1 === D ? 0 : p + 1;
    }
  }

  /** Pushes req(n) and returns the smoothed gain for the delayed sample. */
  private gainFor(req: number): number {
    const cap = this.dqCap;
    const vals = this.dqVal;
    const idxs = this.dqIdx;
    const n = this.n++;
    // Drop larger values from the back, then append.
    while (this.dqSize > 0) {
      const back = (this.dqHead + this.dqSize - 1) % cap;
      if (vals[back] >= req) this.dqSize--;
      else break;
    }
    const slot = (this.dqHead + this.dqSize) % cap;
    vals[slot] = req;
    idxs[slot] = n;
    this.dqSize++;
    // Drop expired values from the front.
    while (idxs[this.dqHead] <= n - this.window) {
      this.dqHead = (this.dqHead + 1) % cap;
      this.dqSize--;
    }
    const held = vals[this.dqHead];
    // Instant attack (the box filter smooths it), exponential release.
    this.env = held < this.env ? held : this.env + (held - this.env) * this.relCoef;
    const bp = this.boxPos;
    this.boxSum += this.env - this.box[bp];
    this.box[bp] = this.env;
    this.boxPos = bp + 1 === this.delay ? 0 : bp + 1;
    return this.boxSum / this.delay;
  }
}
