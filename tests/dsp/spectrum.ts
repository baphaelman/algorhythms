/** Spectral helpers for the M6 DSP tests: windowed DFT at a frequency, peak search, FFT. */

/** Hann-windowed amplitude of the component at `hz` in x[from, from + n). */
export function toneAmp(
  x: Float32Array,
  hz: number,
  rate: number,
  from: number,
  n: number,
): number {
  let re = 0;
  let im = 0;
  let wsum = 0;
  const w0 = (2 * Math.PI * hz) / rate;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const v = x[from + i] * w;
    re += v * Math.cos(w0 * i);
    im -= v * Math.sin(w0 * i);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

/** Frequency of the strongest component within hz ± span (golden-section search). */
export function peakNear(
  x: Float32Array,
  hz: number,
  span: number,
  rate: number,
  from: number,
  n: number,
): { hz: number; amp: number } {
  // Coarse scan first, then refine: the Hann main lobe is ±2 bins wide.
  const bin = rate / n;
  let best = hz;
  let bestA = -1;
  for (let f = hz - span; f <= hz + span; f += bin / 4) {
    const a = toneAmp(x, f, rate, from, n);
    if (a > bestA) {
      bestA = a;
      best = f;
    }
  }
  let lo = best - bin / 4;
  let hi = best + bin / 4;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 30; k++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (toneAmp(x, a, rate, from, n) > toneAmp(x, b, rate, from, n)) hi = b;
    else lo = a;
  }
  const f = (lo + hi) / 2;
  return { hz: f, amp: toneAmp(x, f, rate, from, n) };
}

/** In-place radix-2 FFT (re, im of length 2^k). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2];
        const ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi;
        const ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

/** Hann-windowed power spectrum of x[from, from + n) (n a power of two), bins 0..n/2. */
export function powerSpectrum(x: ArrayLike<number>, from: number, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const p = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

/**
 * Share of a spectrum's power more than `guard` bins from every expected component: what
 * aliasing (or any other stray component) adds. `expected` in Hz.
 */
export function strayShare(p: Float64Array, expected: number[], rate: number, guard = 6): number {
  const n = (p.length - 1) * 2;
  const keep = new Uint8Array(p.length);
  for (const hz of expected) {
    const k = Math.round((Math.abs(hz) * n) / rate);
    for (let j = k - guard; j <= k + guard; j++) if (j >= 0 && j < p.length) keep[j] = 1;
  }
  let total = 0;
  let stray = 0;
  for (let k = 1; k < p.length; k++) {
    total += p[k];
    if (!keep[k]) stray += p[k];
  }
  return stray / total;
}

/** Bessel function of the first kind J_k(x), by its power series (small x). */
export function besselJ(k: number, x: number): number {
  const m = Math.abs(k);
  let term = Math.pow(x / 2, m);
  for (let i = 1; i <= m; i++) term /= i;
  let sum = term;
  for (let j = 1; j < 60; j++) {
    term *= -(x * x) / 4 / (j * (j + m));
    sum += term;
  }
  return k < 0 && m % 2 === 1 ? -sum : sum;
}
