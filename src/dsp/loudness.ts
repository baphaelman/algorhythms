/**
 * Loudness for exports (PLAN.md §12 "Ready for YouTube", §8.8): ITU-R BS.1770-4 integrated
 * loudness and true peak, and `normalize`, which brings a render to a target loudness under a
 * true-peak ceiling. Pure and deterministic (portable math only); runs on the offline render's
 * float buffers in the export worker, never on the audio thread.
 *
 * - **Integrated loudness:** K-weighting (the high shelf and RLB high-pass of Annex 1, designed
 *   from their analog prototypes so 44.1 kHz gets the right curve; at 48 kHz they match the
 *   published coefficients), mean square per channel over 400 ms blocks every 100 ms, channel
 *   weights 1 (L, R or mono), an absolute gate at −70 LUFS and a relative gate 10 LU below the
 *   absolutely gated loudness.
 * - **True peak:** 4× oversampling with the 48-tap polyphase interpolator of Annex 2; the result
 *   is the larger of that and the sample peak.
 * - **normalize:** measure, apply one gain, then a look-ahead true-peak limiter (the master
 *   limiter's smoothing: sliding minimum, release, box filter; no clicks) at the ceiling. It
 *   re-measures and corrects until the result is within 0.1 LU of the target and under the
 *   ceiling (at most a few rounds; heavy limiting costs loudness that the next round restores).
 */

import * as pmath from './pmath';

/** A stereo (or mono: `right` = null) float render. */
export interface Channels {
  left: Float32Array;
  right: Float32Array | null;
}

/** One biquad: y = b0 x + b1 x₋₁ + b2 x₋₂ − a1 y₋₁ − a2 y₋₂. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** What `measureLoudness` finds. */
export interface LoudnessMeasure {
  /** Integrated loudness in LUFS; −Infinity when every block is gated out (silence). */
  lufs: number;
  /** True peak (4× oversampled), dBTP; −Infinity for silence. */
  truePeakDb: number;
  /** Sample peak, dBFS. */
  samplePeakDb: number;
}

/** What `normalize` did. */
export interface NormalizeReport {
  /** The input's measurement. */
  input: LoudnessMeasure;
  /** The output's measurement (integrated loudness, true peak). */
  output: LoudnessMeasure;
  /** Total gain applied before limiting, dB (target − input loudness, plus any correction). */
  gainDb: number;
  /**
   * Limiting the gain called for on the loudest true peak: input true peak + gain − ceiling, dB
   * (0 when the gained piece already fits). The dialog warns above 6 dB.
   */
  limitDb: number;
  /** Measure-and-correct rounds run. */
  rounds: number;
}

const LOG10_2 = 0.3010299956639812;
/** 10·log10(x) with portable math. */
const db10 = (x: number): number => (x > 0 ? 10 * LOG10_2 * pmath.log2(x) : -Infinity);
const db20 = (x: number): number => 2 * db10(x);

/** BS.1770-4 block length and step (seconds). */
const BLOCK = 0.4;
const STEP = 0.1;
const ABS_GATE = -70;
const REL_GATE = -10;
/** The −0.691 dB offset that makes a 1 kHz sine read its RMS level. */
const K_OFFSET = -0.691;

/**
 * The two K-weighting stages for a sample rate: a +4 dB high shelf (head effects) and the RLB
 * high-pass. Bilinear designs of the analog prototypes behind Annex 1's 48 kHz table.
 */
export function kWeighting(sampleRate: number): { shelf: Biquad; highpass: Biquad } {
  // Stage 1: high shelf.
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  let K = pmath.tan((pmath.PI * f0) / sampleRate);
  const Vh = pmath.dbToGain(G);
  const Vb = pmath.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass (numerator 1, −2, 1 as published).
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  K = pmath.tan((pmath.PI * f1) / sampleRate);
  a0 = 1 + K / Q1 + K * K;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q1 + K * K) / a0,
  };
  return { shelf, highpass };
}

/**
 * Annex 2's 4× interpolator: 48 taps as 4 phases of 12. Phase k at input index n estimates the
 * signal between samples n − 6 and n − 5.
 */
export const TP_PHASES: readonly (readonly number[])[] = [
  [
    0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875,
    0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125,
    0.014892578125, -0.00830078125,
  ],
  [
    -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  ],
  [
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
    0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875,
  ],
  [
    -0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875,
    0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125,
    0.001708984375,
  ],
];
const TAPS = 12;

/** Frames per true-peak envelope cell (the limiter's resolution). */
const ENV_CELL = 8;

/** Per-pass scratch: block energies and the true-peak envelope. */
interface Pass {
  lufs: number;
  truePeak: number;
  samplePeak: number;
  /** Max true peak (either channel) per ENV_CELL frames, if asked for. */
  env: Float32Array | null;
}

/**
 * One pass over the channels: K-weighted energy per 100 ms step, sample and true peak, and
 * optionally the true-peak envelope `normalize`'s limiter reads.
 */
function analyse(ch: Channels, sampleRate: number, wantEnv: boolean): Pass {
  const n = ch.left.length;
  const step = Math.round(STEP * sampleRate);
  const steps = Math.floor(n / step);
  const energy = new Float64Array(steps);
  const env = wantEnv ? new Float32Array(Math.ceil((n + TAPS) / ENV_CELL)) : null;
  const { shelf, highpass } = kWeighting(sampleRate);
  let truePeak = 0;
  let samplePeak = 0;
  const list = ch.right ? [ch.left, ch.right] : [ch.left];
  for (const x of list) {
    let s1 = 0;
    let s2 = 0;
    let h1 = 0;
    let h2 = 0;
    // Stage 1 in direct form II transposed, then stage 2.
    const { b0, b1, b2, a1, a2 } = shelf;
    const c1 = highpass.a1;
    const c2 = highpass.a2;
    let acc = 0;
    let k = 0;
    let at = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const y = b0 * v + s1;
      s1 = b1 * v - a1 * y + s2;
      s2 = b2 * v - a2 * y;
      const z = y + h1;
      h1 = -2 * y - c1 * z + h2;
      h2 = y - c2 * z;
      acc += z * z;
      if (++at === step) {
        if (k < steps) energy[k] += acc;
        k++;
        acc = 0;
        at = 0;
      }
      const a = v < 0 ? -v : v;
      if (a > samplePeak) samplePeak = a;
    }
    const tp = truePeakOf(x, env);
    if (tp > truePeak) truePeak = tp;
  }
  if (samplePeak > truePeak) truePeak = samplePeak;
  return { lufs: gatedLoudness(energy, Math.round(BLOCK / STEP), step), truePeak, samplePeak, env };
}

/**
 * The 4× oversampled peak of one channel (outputs for i = 0 … n + 10, the input zero-padded);
 * folds per-cell maxima into `env` (cell of frame i − 6, and of i − 5, either side of the
 * interpolated points), with the sample peak of each frame too. Unrolled over a sliding window
 * of 12 samples (w0 = x[i] … w11 = x[i − 11]); phases 2 and 3 are phases 1 and 0 reversed.
 */
function truePeakOf(x: Float32Array, env: Float32Array | null): number {
  const n = x.length;
  let peak = 0;
  let w0 = 0,
    w1 = 0,
    w2 = 0,
    w3 = 0,
    w4 = 0,
    w5 = 0,
    w6 = 0,
    w7 = 0,
    w8 = 0,
    w9 = 0,
    w10 = 0;
  const end = n + TAPS - 1;
  for (let i = 0; i < end; i++) {
    const w11 = w10;
    w10 = w9;
    w9 = w8;
    w8 = w7;
    w7 = w6;
    w6 = w5;
    w5 = w4;
    w4 = w3;
    w3 = w2;
    w2 = w1;
    w1 = w0;
    w0 = i < n ? x[i] : 0;
    let y =
      0.001708984375 * w0 +
      0.010986328125 * w1 +
      -0.0196533203125 * w2 +
      0.033203125 * w3 +
      -0.0594482421875 * w4 +
      0.1373291015625 * w5 +
      0.97216796875 * w6 +
      -0.102294921875 * w7 +
      0.047607421875 * w8 +
      -0.026611328125 * w9 +
      0.014892578125 * w10 +
      -0.00830078125 * w11;
    let m = y < 0 ? -y : y;
    y =
      -0.0291748046875 * w0 +
      0.029296875 * w1 +
      -0.0517578125 * w2 +
      0.089111328125 * w3 +
      -0.16650390625 * w4 +
      0.465087890625 * w5 +
      0.77978515625 * w6 +
      -0.2003173828125 * w7 +
      0.1015625 * w8 +
      -0.0582275390625 * w9 +
      0.0330810546875 * w10 +
      -0.0189208984375 * w11;
    if (y > m) m = y;
    else if (-y > m) m = -y;
    y =
      -0.0189208984375 * w0 +
      0.0330810546875 * w1 +
      -0.0582275390625 * w2 +
      0.1015625 * w3 +
      -0.2003173828125 * w4 +
      0.77978515625 * w5 +
      0.465087890625 * w6 +
      -0.16650390625 * w7 +
      0.089111328125 * w8 +
      -0.0517578125 * w9 +
      0.029296875 * w10 +
      -0.0291748046875 * w11;
    if (y > m) m = y;
    else if (-y > m) m = -y;
    y =
      -0.00830078125 * w0 +
      0.014892578125 * w1 +
      -0.026611328125 * w2 +
      0.047607421875 * w3 +
      -0.102294921875 * w4 +
      0.97216796875 * w5 +
      0.1373291015625 * w6 +
      -0.0594482421875 * w7 +
      0.033203125 * w8 +
      -0.0196533203125 * w9 +
      0.010986328125 * w10 +
      0.001708984375 * w11;
    if (y > m) m = y;
    else if (-y > m) m = -y;
    if (m > peak) peak = m;
    if (env !== null) {
      // w6 = x[i − 6], w5 = x[i − 5].
      const f = i - 6;
      if (f >= 0) {
        const v = w6 < 0 ? -w6 : w6;
        const c = (f / ENV_CELL) | 0;
        const u = v > m ? v : m;
        if (u > env[c]) env[c] = u;
      }
      const g = i - 5;
      if (g >= 0 && g < n) {
        const c = (g / ENV_CELL) | 0;
        if (m > env[c]) env[c] = m;
      }
    }
  }
  return peak;
}

/** Gated loudness from per-step energies (summed over channels) and the block length in steps. */
function gatedLoudness(energy: Float64Array, perBlock: number, step: number): number {
  const blocks = energy.length - perBlock + 1;
  if (blocks <= 0) return -Infinity;
  const len = perBlock * step;
  const z = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let s = 0;
    for (let j = 0; j < perBlock; j++) s += energy[b + j];
    z[b] = s / len;
  }
  const loud = (e: number) => K_OFFSET + db10(e);
  let sum = 0;
  let count = 0;
  for (let b = 0; b < blocks; b++) {
    if (loud(z[b]) > ABS_GATE) {
      sum += z[b];
      count++;
    }
  }
  if (count === 0) return -Infinity;
  const rel = loud(sum / count) + REL_GATE;
  sum = 0;
  count = 0;
  for (let b = 0; b < blocks; b++) {
    const l = loud(z[b]);
    if (l > ABS_GATE && l > rel) {
      sum += z[b];
      count++;
    }
  }
  return count === 0 ? -Infinity : loud(sum / count);
}

/** Integrated loudness (LUFS), true peak (dBTP) and sample peak (dBFS) of a render. */
export function measureLoudness(ch: Channels, sampleRate: number): LoudnessMeasure {
  const p = analyse(ch, sampleRate, false);
  return { lufs: p.lufs, truePeakDb: db20(p.truePeak), samplePeakDb: db20(p.samplePeak) };
}

/** Integrated loudness only (LUFS). */
export function integratedLoudness(ch: Channels, sampleRate: number): number {
  return measureLoudness(ch, sampleRate).lufs;
}

/** True peak of a render, dBTP. */
export function truePeakDb(ch: Channels): number {
  let tp = truePeakOf(ch.left, null);
  if (ch.right) tp = Math.max(tp, truePeakOf(ch.right, null));
  let sp = 0;
  for (const x of ch.right ? [ch.left, ch.right] : [ch.left])
    for (let i = 0; i < x.length; i++) sp = Math.max(sp, x[i] < 0 ? -x[i] : x[i]);
  return db20(Math.max(tp, sp));
}

/** Look-ahead and release of the true-peak limiter (seconds). */
const TP_LOOKAHEAD = 0.005;
const TP_RELEASE = 0.15;
/** Aim this far under the ceiling (dB): a moving gain nudges inter-sample peaks. */
const TP_MARGIN = 0.05;
const MAX_ROUNDS = 4;
/** Loudness tolerance of the correction rounds (LU). */
const LU_TOLERANCE = 0.1;

/**
 * Multiplies the channels by `gain` and limits them under `ceiling` (linear true peak), in place,
 * reading the input's true-peak envelope (per ENV_CELL frames, before the gain). Same smoothing as
 * the master limiter (fx/limiter.ts): sliding minimum over the look-ahead, instant attack and
 * exponential release, a box filter as long as the look-ahead; the envelope is first widened by a
 * cell either side, covering the interpolator's alignment.
 */
function gainAndLimit(
  ch: Channels,
  sampleRate: number,
  gain: number,
  ceiling: number,
  env: Float32Array,
): void {
  const n = ch.left.length;
  const L = ch.left;
  const R = ch.right;
  const D = Math.max(1, Math.round(TP_LOOKAHEAD * sampleRate));
  const rel = 1 - pmath.exp(-1 / (TP_RELEASE * sampleRate));
  const cells = env.length;
  const held = new Float32Array(cells);
  for (let c = 0; c < cells; c++) {
    let m = env[c];
    if (c > 0 && env[c - 1] > m) m = env[c - 1];
    if (c + 1 < cells && env[c + 1] > m) m = env[c + 1];
    held[c] = m * gain;
  }
  const dL = new Float64Array(D);
  const dR = new Float64Array(D);
  const box = new Float64Array(D).fill(1);
  const cap = D + 2;
  const vals = new Float64Array(cap);
  const idxs = new Float64Array(cap);
  let head = 0;
  let size = 0;
  let envG = 1;
  let boxSum = D;
  let boxPos = 0;
  let dPos = 0;
  for (let i = 0; i < n + D; i++) {
    let xl = 0;
    let xr = 0;
    let req = 1;
    if (i < n) {
      xl = L[i] * gain;
      xr = R ? R[i] * gain : 0;
      const p = held[(i / ENV_CELL) | 0];
      req = p > ceiling ? ceiling / p : 1;
    }
    while (size > 0) {
      const back = (head + size - 1) % cap;
      if (vals[back] >= req) size--;
      else break;
    }
    const slot = (head + size) % cap;
    vals[slot] = req;
    idxs[slot] = i;
    size++;
    while (idxs[head] <= i - (D + 1)) {
      head = (head + 1) % cap;
      size--;
    }
    const h = vals[head];
    envG = h < envG ? h : envG + (h - envG) * rel;
    boxSum += envG - box[boxPos];
    box[boxPos] = envG;
    boxPos = boxPos + 1 === D ? 0 : boxPos + 1;
    const g = boxSum / D;
    const out = i - D;
    if (out >= 0) {
      L[out] = dL[dPos] * g;
      if (R) R[out] = dR[dPos] * g;
    }
    dL[dPos] = xl;
    dR[dPos] = xr;
    dPos = dPos + 1 === D ? 0 : dPos + 1;
  }
}

/**
 * Brings a render to `targetLufs` integrated loudness with true peaks at or under `ceilingDbtp`,
 * **in place** (the buffers are the export's own render). Silence is left alone. Deterministic.
 */
export function normalize(
  mix: Channels,
  sampleRate: number,
  targetLufs: number,
  ceilingDbtp = -1,
): NormalizeReport {
  let pass = analyse(mix, sampleRate, true);
  const input: LoudnessMeasure = {
    lufs: pass.lufs,
    truePeakDb: db20(pass.truePeak),
    samplePeakDb: db20(pass.samplePeak),
  };
  if (!Number.isFinite(input.lufs)) {
    return { input, output: input, gainDb: 0, limitDb: 0, rounds: 0 };
  }
  const firstGain = targetLufs - input.lufs;
  const limitDb = Math.max(0, input.truePeakDb + firstGain - ceilingDbtp);
  let gainDb = 0;
  let stepDb = firstGain;
  let margin = TP_MARGIN;
  let rounds = 0;
  let out = input;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    const ceiling = pmath.dbToGain(ceilingDbtp - margin);
    gainAndLimit(mix, sampleRate, pmath.dbToGain(stepDb), ceiling, pass.env!);
    gainDb += stepDb;
    pass = analyse(mix, sampleRate, true);
    out = { lufs: pass.lufs, truePeakDb: db20(pass.truePeak), samplePeakDb: db20(pass.samplePeak) };
    const over = out.truePeakDb - ceilingDbtp;
    const short = targetLufs - out.lufs;
    if (over <= 0 && Math.abs(short) <= LU_TOLERANCE) break;
    // Another round: make up what limiting took, and limit again a little lower if a peak got
    // through.
    stepDb = Math.abs(short) <= LU_TOLERANCE ? 0 : short;
    if (over > 0) margin += over + 0.02;
  }
  return { input, output: out, gainDb, limitDb, rounds };
}

/** The gain and limiting `normalize` would start from, given a measurement (for the dialog). */
export function normalizePlan(
  m: LoudnessMeasure,
  targetLufs: number,
  ceilingDbtp = -1,
): { gainDb: number; limitDb: number } {
  if (!Number.isFinite(m.lufs)) return { gainDb: 0, limitDb: 0 };
  const gainDb = targetLufs - m.lufs;
  return { gainDb, limitDb: Math.max(0, m.truePeakDb + gainDb - ceilingDbtp) };
}
