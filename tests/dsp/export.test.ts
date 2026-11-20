/**
 * WAV export determinism (PLAN.md §8.1, §8.10, §15 M2): two exports are byte-identical, and the
 * export chunk size changes nothing. Also: the export equals playback from t = 0.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FIXTURE_MIX, stressScore, unisonChordScore } from '../../src/audio/fixtures/scores';
import { parseWavHeader } from '../../src/audio/wav';
import { renderWav, wavExportChunks, wavExportSize } from '../../src/audio/wav-export';
import { renderOffline } from '../../src/audio/offline';

const score = stressScore(10, 8, 1.1, 4);
const input = { score, mix: FIXTURE_MIX };

function digest(parts: Iterable<Uint8Array>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

describe('WAV export', () => {
  it.each([16, 24, 32] as const)('two %i-bit exports are byte-identical', (bitDepth) => {
    const a = renderWav(input, { sampleRate: 48000, bitDepth });
    const b = renderWav(input, { sampleRate: 48000, bitDepth });
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const info = parseWavHeader(a);
    expect(info.frames).toBe(wavExportSize(input, { sampleRate: 48000, bitDepth }).frames);
    expect(a.length).toBe(wavExportSize(input, { sampleRate: 48000, bitDepth }).bytes);
  });

  it('gives identical bytes for every chunk size', () => {
    const sizes = [1, 0.37, 128 / 48000, 2.5];
    const hashes = sizes.map((chunkSeconds) =>
      digest(wavExportChunks(input, { sampleRate: 48000, bitDepth: 16, chunkSeconds })),
    );
    expect(new Set(hashes).size).toBe(1);
  });

  it('a unison phrase (locked groups) exports byte-identically, at any chunk size', () => {
    const phrase = { score: unisonChordScore('glass'), mix: FIXTURE_MIX };
    const hashes = [1, 0.37, 128 / 48000].map((chunkSeconds) =>
      digest(wavExportChunks(phrase, { sampleRate: 48000, bitDepth: 24, chunkSeconds })),
    );
    hashes.push(digest([renderWav(phrase, { sampleRate: 48000, bitDepth: 24 })]));
    expect(new Set(hashes).size).toBe(1);
  }, 30_000);

  it('reports progress up to 1', () => {
    const seen: number[] = [];
    for (const _ of wavExportChunks(input, { sampleRate: 44100, bitDepth: 24 }, (f) =>
      seen.push(f),
    )) {
      // drain
    }
    expect(seen.length).toBeGreaterThan(5);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((f, i) => i === 0 || f > seen[i - 1])).toBe(true);
  });

  it('exports at 44.1 kHz with the right length (piece + FX tail)', () => {
    const bytes = renderWav(input, { sampleRate: 44100, bitDepth: 32 });
    const info = parseWavHeader(bytes);
    expect(info.sampleRate).toBe(44100);
    expect(info.frames / 44100).toBeGreaterThan(score.duration + FIXTURE_MIX.reverb.decay);
  });

  it('a 32-bit float export carries exactly the samples of a render from t = 0', () => {
    const bytes = renderWav(input, { sampleRate: 48000, bitDepth: 32 });
    const info = parseWavHeader(bytes);
    const out = renderOffline({ score, mix: FIXTURE_MIX, sampleRate: 48000 }, info.frames);
    const v = new DataView(bytes.buffer, info.dataOffset);
    for (let i = 0; i < info.frames; i += 97) {
      expect(v.getFloat32(i * 8, true)).toBe(out.left[i]);
      expect(v.getFloat32(i * 8 + 4, true)).toBe(out.right[i]);
    }
  });
});
