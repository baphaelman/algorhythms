/**
 * A span of the WAV render (video sections, PLAN.md §12 rev 15): the samples equal the whole
 * render's there (sounds already ringing included), apart from the 30 ms fades at the cuts, and
 * neither cut clicks.
 */

import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_MIX, stressScore } from '../../src/audio/fixtures/scores';
import { parseWavHeader } from '../../src/audio/wav';
import {
  SPAN_FADE,
  renderWav,
  spanFrames,
  spanGain,
  wavExportChunks,
  wavExportSize,
  type WavSpan,
} from '../../src/audio/wav-export';

vi.setConfig({ testTimeout: 60_000 });

const SR = 48000;
const score = stressScore(10, 8, 1.1, 4);
const input = { score, mix: FIXTURE_MIX };

/** Interleaved stereo float samples of a 32-bit WAV as [left, right]. */
function samples(bytes: Uint8Array): [Float32Array, Float32Array] {
  const info = parseWavHeader(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset + info.dataOffset);
  const l = new Float32Array(info.frames);
  const r = new Float32Array(info.frames);
  for (let i = 0; i < info.frames; i++) {
    l[i] = v.getFloat32(i * 8, true);
    r[i] = v.getFloat32(i * 8 + 4, true);
  }
  return [l, r];
}

const whole = samples(renderWav(input, { sampleRate: SR, bitDepth: 32 }));

function maxJump(x: Float32Array, a: number, b: number): number {
  let m = 0;
  for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

describe('spanFrames / spanGain', () => {
  it('frames kept and fades', () => {
    expect(spanFrames(1000, SR)).toEqual({ from: 0, to: 1000, fadeIn: 0, fadeOut: 0 });
    const n = Math.round(SPAN_FADE * SR);
    expect(spanFrames(500_000, SR, { start: 2, end: 5 })).toEqual({
      from: 96000,
      to: 240000,
      fadeIn: n,
      fadeOut: n,
    });
    // No end: to the render's end, no fade-out; a start at 0: no fade-in.
    expect(spanFrames(500_000, SR, { start: 2 })).toMatchObject({ to: 500_000, fadeOut: 0 });
    expect(spanFrames(500_000, SR, { start: 0, end: 5 })).toMatchObject({ fadeIn: 0, fadeOut: n });
    // Fades never longer than the span.
    expect(spanFrames(500_000, SR, { start: 1, end: 1.01 })).toMatchObject({
      fadeIn: 480,
      fadeOut: 480,
    });
  });

  it('gain: 0 at the cut samples, 1 inside, monotone in the fades', () => {
    const len = 10_000;
    expect(spanGain(0, len, 1440, 1440)).toBe(0);
    expect(spanGain(len - 1, len, 1440, 1440)).toBe(0);
    expect(spanGain(1440, len, 1440, 1440)).toBe(1);
    expect(spanGain(5000, len, 1440, 1440)).toBe(1);
    for (let i = 1; i < 1440; i++) {
      expect(spanGain(i, len, 1440, 1440)).toBeGreaterThan(spanGain(i - 1, len, 1440, 1440));
    }
    expect(spanGain(0, len, 0, 0)).toBe(1);
  });
});

describe('a span of the render', () => {
  const cases: [string, WavSpan][] = [
    ['mid-piece', { start: 2.3, end: 5.7 }],
    ['to the end (ring-out kept)', { start: 4.05 }],
    ['from 0', { start: 0, end: 3 }],
  ];

  it.each(cases)('%s: the whole render’s samples, fades aside, no click', (_, span) => {
    const bytes = renderWav(input, { sampleRate: SR, bitDepth: 32, span });
    expect(bytes.length).toBe(wavExportSize(input, { sampleRate: SR, bitDepth: 32, span }).bytes);
    const [l, r] = samples(bytes);
    const { from, to, fadeIn, fadeOut } = spanFrames(whole[0].length, SR, span);
    expect(l.length).toBe(to - from);
    const len = to - from;
    for (const [out, ref] of [
      [l, whole[0]],
      [r, whole[1]],
    ] as const) {
      // Equal outside the fades, exactly.
      for (let i = fadeIn; i < len - fadeOut; i++) {
        if (out[i] !== ref[from + i]) throw new Error(`sample ${i}: ${out[i]} vs ${ref[from + i]}`);
      }
      // Inside the fades: the whole render's samples times the fade.
      for (let i = 0; i < fadeIn; i++) {
        expect(out[i]).toBeCloseTo(ref[from + i] * spanGain(i, len, fadeIn, fadeOut), 6);
      }
      // No click: the cuts start and end at 0, and the fades step no more than the render
      // itself does there (plus the fade's own slope on a full-scale signal).
      // The fade's gain moves at most π / (2n) per sample (sin² ramp of n samples).
      const slope = (n: number) => (Math.PI / (2 * n)) * 1.01;
      if (fadeIn > 0) {
        expect(Math.abs(out[0])).toBe(0);
        expect(maxJump(out, 1, fadeIn)).toBeLessThanOrEqual(
          maxJump(ref, from, from + fadeIn) + slope(fadeIn),
        );
      }
      if (fadeOut > 0) {
        expect(Math.abs(out[len - 1])).toBe(0);
        expect(maxJump(out, len - fadeOut, len)).toBeLessThanOrEqual(
          maxJump(ref, to - fadeOut, to) + slope(fadeOut),
        );
      }
    }
    if (span.start > 0) {
      // The cut falls where something sounds (a hard cut would click).
      expect(Math.abs(whole[0][from]) + Math.abs(whole[1][from])).toBeGreaterThan(1e-4);
    }
  });

  it('is the same at any chunk size, and reports progress up to 1', () => {
    const span = { start: 2.3, end: 5.7 };
    const join = (chunkSeconds: number) =>
      Buffer.concat([
        ...wavExportChunks(input, { sampleRate: SR, bitDepth: 32, span, chunkSeconds }),
      ]);
    const a = join(1);
    expect(a.equals(join(0.37))).toBe(true);
    expect(a.equals(join(128 / SR))).toBe(true);
    const seen: number[] = [];
    for (const _ of wavExportChunks(input, { sampleRate: SR, bitDepth: 24, span }, (f) =>
      seen.push(f),
    )) {
      // drain
    }
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((f, i) => i === 0 || f > seen[i - 1])).toBe(true);
  });
});
