/** The in-house WAV writer (PLAN.md §12): header and sample-format validity for 16/24/32-bit. */

import { describe, expect, it } from 'vitest';
import { parseWavHeader, WavEncoder, wavHeader, type WavBitDepth } from '../../../src/audio/wav';

function file(bitDepth: WavBitDepth, left: Float32Array, right: Float32Array, rate = 48000): Uint8Array {
  const format = { sampleRate: rate, bitDepth, channels: 2 } as const;
  const head = wavHeader(format, left.length);
  const data = new WavEncoder(format, 1).encode(left, right);
  const out = new Uint8Array(head.length + data.length);
  out.set(head);
  out.set(data, head.length);
  return out;
}

const L = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25, 2, -2]);
const R = Float32Array.from([0.1, -0.1, 0.9, -0.9, 0, 0.75, -0.75, 0.3]);

describe('wavHeader + WavEncoder', () => {
  it.each([16, 24, 32] as const)('writes a valid %i-bit stereo file', (bits) => {
    const bytes = file(bits, L, R);
    const info = parseWavHeader(bytes);
    expect(info.formatTag).toBe(bits === 32 ? 3 : 1);
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(48000);
    expect(info.bitDepth).toBe(bits);
    expect(info.blockAlign).toBe((bits / 8) * 2);
    expect(info.byteRate).toBe(48000 * (bits / 8) * 2);
    expect(info.frames).toBe(L.length);
    expect(info.dataOffset).toBe(bits === 32 ? 58 : 44);
    if (bits === 32) expect(info.factFrames).toBe(L.length);
  });

  it('writes 44.1 kHz headers', () => {
    const info = parseWavHeader(file(24, L, R, 44100));
    expect(info.sampleRate).toBe(44100);
    expect(info.byteRate).toBe(44100 * 6);
  });

  it('stores 32-bit float samples exactly, interleaved L/R', () => {
    const bytes = file(32, L, R);
    const v = new DataView(bytes.buffer, 58);
    for (let i = 0; i < L.length; i++) {
      expect(v.getFloat32(i * 8, true)).toBe(L[i]);
      expect(v.getFloat32(i * 8 + 4, true)).toBe(R[i]);
    }
  });

  it('stores 24-bit samples rounded and clamped, little-endian', () => {
    const bytes = file(24, L, R);
    const at = (i: number) => {
      const o = 44 + i * 6;
      const u = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
      return (u << 8) >> 8; // sign-extend
    };
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(Math.round(0.5 * 8388607));
    expect(at(3)).toBe(8388607);
    expect(at(4)).toBe(-8388607);
    expect(at(6)).toBe(8388607); // +2 clamps
    expect(at(7)).toBe(-8388608); // −2 clamps
  });

  it('dithers 16-bit with seeded TPDF noise of at most ±1 LSB, and clamps', () => {
    const n = 20000;
    const x = new Float32Array(n).fill(0.25);
    const bytes = file(16, x, x);
    const v = new DataView(bytes.buffer, 44);
    const ideal = 0.25 * 32767;
    let sum = 0;
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const s = v.getInt16(i * 4, true);
      expect(Math.abs(s - ideal)).toBeLessThanOrEqual(1.5);
      sum += s;
      seen.add(s);
    }
    expect(Math.abs(sum / n - ideal)).toBeLessThan(0.02); // unbiased
    expect(seen.size).toBeGreaterThan(1); // really dithered
    const loud = file(16, Float32Array.from([2, -2]), Float32Array.from([1, -1]));
    const w = new DataView(loud.buffer, 44);
    expect(w.getInt16(0, true)).toBe(32767);
    expect(w.getInt16(4, true)).toBe(-32768);
  });

  it('gives the same bytes whether encoded at once or in chunks', () => {
    const n = 1000;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.8);
    const format = { sampleRate: 48000, bitDepth: 16, channels: 2 } as const;
    const whole = new WavEncoder(format, 42).encode(x, x);
    const enc = new WavEncoder(format, 42);
    const a = enc.encode(x.subarray(0, 333), x.subarray(0, 333));
    const b = enc.encode(x.subarray(333), x.subarray(333));
    expect(Buffer.from([...a, ...b]).equals(Buffer.from(whole))).toBe(true);
  });

  it('rejects malformed files', () => {
    const bytes = file(16, L, R);
    expect(() => parseWavHeader(bytes.subarray(0, bytes.length - 2))).toThrow();
    const bad = bytes.slice();
    bad[8] = 0x58;
    expect(() => parseWavHeader(bad)).toThrow();
  });
});
