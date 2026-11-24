/**
 * Loudness-normalised WAV exports (PLAN.md §15 M11 "Ready for YouTube", first acceptance line):
 * Crease, Night Sleeper and an example exported at −14 LUFS measure −14 ± 0.5 LUFS integrated with
 * a true peak ≤ −1 dBTP, through the export path itself (render, normalise, encode, decode). Also
 * times `normalize` on 10 minutes of stereo (reported, not gated).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { renderWav, wavExportChunks, type WavExportOptions } from '../../src/audio/wav-export';
import { wavHeaderSize } from '../../src/audio/wav';
import { measureLoudness, normalize, type NormalizeReport } from '../../src/dsp/loudness';

vi.setConfig({ testTimeout: 900_000 });

/** Decodes a stereo 24-bit or 32-bit float WAV from `renderWav`. */
function decode(
  bytes: Uint8Array,
  opts: WavExportOptions,
): { left: Float32Array; right: Float32Array } {
  const head = wavHeaderSize({ sampleRate: opts.sampleRate, bitDepth: opts.bitDepth, channels: 2 });
  const view = new DataView(bytes.buffer, bytes.byteOffset + head);
  const step = opts.bitDepth / 8;
  const n = Math.floor(view.byteLength / (2 * step));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const read = (o: number) => {
    if (opts.bitDepth === 32) return view.getFloat32(o, true);
    const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
    return v / 8388608;
  };
  for (let i = 0; i < n; i++) {
    left[i] = read(2 * i * step);
    right[i] = read((2 * i + 1) * step);
  }
  return { left, right };
}

function load(file: string) {
  const p = parsePiece(JSON.parse(readFileSync(`examples/${file}.algorhythms.json`, 'utf8')));
  if (!p.ok) throw new Error(p.errors.join('; '));
  return p.piece;
}

describe('−14 LUFS exports', () => {
  const cases: [string, WavExportOptions][] = [
    ['experiments/crease', { sampleRate: 48000, bitDepth: 32, loudness: -14 }],
    ['experiments/night-sleeper', { sampleRate: 48000, bitDepth: 32, loudness: -14 }],
    ['clockwork-heron', { sampleRate: 44100, bitDepth: 24, loudness: -14 }],
  ];
  for (const [file, opts] of cases) {
    it(`${file}: −14 ± 0.5 LUFS, true peak ≤ −1 dBTP`, () => {
      const piece = load(file);
      const input = { score: compile(piece), mix: piece.mix, timbres: piece.timbres };
      let report: NormalizeReport | null = null;
      const t0 = performance.now();
      const parts = [...wavExportChunks(input, opts, undefined, (r) => (report = r))];
      const ms = performance.now() - t0;
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.byteLength;
      }
      const m = measureLoudness(decode(bytes, opts), opts.sampleRate);
      const r = report as unknown as NormalizeReport;
      console.info(
        `${file}: ${r.input.lufs.toFixed(2)} LUFS / ${r.input.truePeakDb.toFixed(2)} dBTP → ` +
          `${m.lufs.toFixed(2)} LUFS / ${m.truePeakDb.toFixed(2)} dBTP; gain ` +
          `${r.gainDb.toFixed(2)} dB, limiting ${r.limitDb.toFixed(2)} dB, ${r.rounds} rounds; ` +
          `export ${(ms / 1000).toFixed(1)} s`,
      );
      expect(Math.abs(m.lufs + 14)).toBeLessThanOrEqual(0.5);
      expect(m.truePeakDb).toBeLessThanOrEqual(-1);
    });
  }

  it("'off' is the plain export, byte for byte", () => {
    const piece = load('experiments/crease');
    const input = { score: compile(piece), mix: piece.mix, timbres: piece.timbres };
    const span = { start: 10, end: 14 };
    const a = renderWav(input, { sampleRate: 48000, bitDepth: 24, span });
    const b = renderWav(input, { sampleRate: 48000, bitDepth: 24, span, loudness: 'off' });
    expect(b).toEqual(a);
    // A normalised span keeps its length (and the header's).
    const c = renderWav(input, { sampleRate: 48000, bitDepth: 24, span, loudness: -16 });
    expect(c.byteLength).toBe(a.byteLength);
  });
});

describe('normalize speed', () => {
  it('10 minutes of stereo 48 kHz (reported)', () => {
    const rate = 48000;
    const n = 600 * rate;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const noise = (s / 4294967296 - 0.5) * 0.1;
      left[i] = 0.2 * Math.sin(i * 0.05) + noise;
      right[i] = 0.2 * Math.sin(i * 0.031) - noise;
    }
    const t0 = performance.now();
    const r = normalize({ left, right }, rate, -14);
    const ms = performance.now() - t0;
    console.info(
      `normalize, 10 min stereo 48 kHz: ${(ms / 1000).toFixed(1)} s, ${r.rounds} rounds`,
    );
    expect(Math.abs(r.output.lufs + 14)).toBeLessThanOrEqual(0.5);
  });
});
