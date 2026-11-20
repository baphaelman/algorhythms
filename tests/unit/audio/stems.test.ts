/**
 * Stems export (src/audio/stems.ts, PLAN.md §12): the zip's entries and WAV headers, the exact sum
 * (Σ voice stems + FX stem = mix with the limiter engaged), mono and PCM variants, size
 * estimates, ZIP64 on a real export, and cancel.
 */

import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FIXTURE_MIX, stressScore } from '../../../src/audio/fixtures/scores';
import {
  estimateStemsSize,
  planStems,
  safeStemName,
  soundingVoices,
  STEMS_WARN_BYTES,
  writeStemsZip,
  type StemsInput,
  type StemsOptions,
} from '../../../src/audio/stems';
import { renderOffline } from '../../../src/audio/offline';
import type { CompiledScore } from '../../../src/core/types';
import { parseWavHeader } from '../../../src/audio/wav';
import { renderWav } from '../../../src/audio/wav-export';

function fixture(): StemsInput & { score: CompiledScore } {
  const score = stressScore(8, 6, 1, 9);
  for (const v of score.voices) v.gain = 3; // push the limiter
  score.voices[2].mute = true; // no stem for a muted voice
  return { score, mix: { ...FIXTURE_MIX, tone: { tilt: 1.5, lowpassHz: 9000 } } };
}

async function exportZip(
  input: StemsInput,
  options: StemsOptions = {},
  hooks: Parameters<typeof writeStemsZip>[3] = {},
): Promise<{ zip: Uint8Array; summary: Awaited<ReturnType<typeof writeStemsZip>> }> {
  const parts: Uint8Array[] = [];
  const summary = await writeStemsZip(input, options, (c) => void parts.push(c), hooks);
  const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    zip.set(p, o);
    o += p.length;
  }
  return { zip, summary };
}

function floats(wav: Uint8Array): { left: Float32Array; right: Float32Array | null } {
  const info = parseWavHeader(wav);
  expect(info.bitDepth).toBe(32);
  const v = new DataView(wav.buffer, wav.byteOffset + info.dataOffset, info.dataBytes);
  const left = new Float32Array(info.frames);
  const right = info.channels === 2 ? new Float32Array(info.frames) : null;
  for (let i = 0; i < info.frames; i++) {
    left[i] = v.getFloat32(i * info.blockAlign, true);
    if (right) right[i] = v.getFloat32(i * info.blockAlign + 4, true);
  }
  return { left, right };
}

function dbfs(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

describe('planStems', () => {
  it('lists mix, sounding voices in pool order, then the FX returns', () => {
    const input = fixture();
    const [a, b] = [input.score.voices[0].id, input.score.voices[1].id];
    const plan = planStems(input, { voiceNames: { [a]: 'Bass / low', [b]: 'Bass / low' } });
    const names = plan.entries.map((e) => e.name);
    expect(names[0]).toBe('mix.wav');
    expect(names.at(-1)).toBe('fx-returns.wav');
    // voice 2 is muted: no stem
    expect(plan.entries.filter((e) => e.kind === 'voice')).toHaveLength(7);
    expect(plan.entries.some((e) => e.voiceIndex === 2)).toBe(false);
    // names: sanitised and de-duplicated
    expect(names[1]).toBe('Bass _ low.wav');
    expect(names[2]).toBe('Bass _ low-2.wav');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('skips voices that never sound, honours solo, and avoids reserved names', () => {
    const score = stressScore(4, 4, 1, 3);
    score.voices[1].lives = [];
    score.voices[3].solo = true;
    expect(soundingVoices(score).map((v) => v.index)).toEqual([3]);
    score.voices[3].solo = false;
    const plan = planStems(
      { score, mix: FIXTURE_MIX },
      { voiceNames: { [score.voices[0].id]: 'MIX' } },
    );
    expect(plan.entries[1].name).toBe('MIX-2.wav');
    expect(safeStemName('..a:b\u0001c ')).toBe('_a_b_c');
  });

  it('estimates sizes that grow with bit depth and shrink for mono; warns above 1 GB', () => {
    const input = fixture();
    const f32 = estimateStemsSize(input, { bitDepth: 32 });
    const p24 = estimateStemsSize(input, { bitDepth: 24 });
    const p16 = estimateStemsSize(input, { bitDepth: 16 });
    const mono = estimateStemsSize(input, { bitDepth: 32, mono: true });
    expect(p16.bytes).toBeLessThan(p24.bytes);
    expect(p24.bytes).toBeLessThan(f32.bytes);
    expect(mono.bytes).toBeLessThan(f32.bytes * 0.6);
    expect(f32.large).toBe(false);
    // 24 voices, 5 min, 48 kHz, float stereo: ~2.8 GB, flagged
    const long = stressScore(24, 300, 1, 5);
    const big = estimateStemsSize({ score: long, mix: FIXTURE_MIX }, {});
    expect(big.bytes).toBeGreaterThan(STEMS_WARN_BYTES);
    expect(big.large).toBe(true);
    expect(big.zip64).toBe(false);
  });
});

describe('writeStemsZip', () => {
  it('writes the planned entries with valid WAV headers and the planned size', async () => {
    const input = fixture();
    const plan = planStems(input);
    const { zip, summary } = await exportZip(input);
    expect(zip.length).toBe(plan.bytes);
    expect(summary.bytes).toBe(plan.bytes);
    expect(summary.entries).toEqual(plan.entries.map((e) => e.name));
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(plan.entries.map((e) => e.name));
    for (const e of plan.entries) {
      const wav = files[e.name];
      expect(wav.length).toBe(e.bytes);
      const info = parseWavHeader(wav);
      expect(info).toMatchObject({ formatTag: 3, channels: 2, sampleRate: 48000, bitDepth: 32 });
      expect(info.frames).toBe(plan.frames);
    }
  });

  it('mix.wav is byte-identical to the plain WAV export', async () => {
    const input = fixture();
    const { zip } = await exportZip(input);
    const plain = renderWav(input, { sampleRate: 48000, bitDepth: 32 });
    expect(Buffer.from(unzipSync(zip)['mix.wav']).equals(Buffer.from(plain))).toBe(true);
  });

  it('float stems + FX stem sum to the mix within −90 dBFS with the limiter engaged', async () => {
    const input = fixture();
    const { zip } = await exportZip(input);
    const files = unzipSync(zip);
    const mix = floats(files['mix.wav']);
    const frames = mix.left.length;
    const sumL = new Float64Array(frames);
    const sumR = new Float64Array(frames);
    for (const [name, wav] of Object.entries(files)) {
      if (name === 'mix.wav') continue;
      const s = floats(wav);
      for (let i = 0; i < frames; i++) {
        sumL[i] += s.left[i];
        sumR[i] += s.right![i];
      }
    }
    let worst = 0;
    let level = 0;
    for (let i = 0; i < frames; i++) {
      worst = Math.max(worst, Math.abs(sumL[i] - mix.left[i]), Math.abs(sumR[i] - mix.right![i]));
      level = Math.max(level, Math.abs(mix.left[i]));
    }
    // The limiter is engaged: the mix sits at its −1 dBFS ceiling ...
    expect(level).toBeGreaterThan(0.85);
    expect(level).toBeLessThan(0.9);
    // ... and pulls the gain well below unity (g_L from the same render).
    const gain = new Float32Array(frames);
    renderOffline({ score: input.score, mix: input.mix, sampleRate: 48000 }, frames, {
      kind: 'mix',
      captureGain: gain,
    });
    expect(gain.reduce((m, g) => Math.min(m, g), 1)).toBeLessThan(0.8);
    console.info(
      `stems residual: ${dbfs(worst).toFixed(1)} dBFS (mix peak ${dbfs(level).toFixed(1)})`,
    );
    expect(dbfs(worst)).toBeLessThanOrEqual(-90);
  });

  it('mono stems are half-size downmixes; the mix stays stereo', async () => {
    const input = fixture();
    const stereo = await exportZip(input);
    const mono = await exportZip(input, { mono: true });
    expect(mono.zip.length).toBeLessThan(stereo.zip.length * 0.6);
    const files = unzipSync(mono.zip);
    const full = unzipSync(stereo.zip);
    expect(parseWavHeader(files['mix.wav']).channels).toBe(2);
    const name = planStems(input).entries[1].name;
    expect(parseWavHeader(files[name]).channels).toBe(1);
    const m = floats(files[name]).left;
    const s = floats(full[name]);
    let worst = 0;
    for (let i = 0; i < m.length; i++) {
      worst = Math.max(worst, Math.abs(m[i] - 0.5 * (s.left[i] + s.right![i])));
    }
    expect(dbfs(worst)).toBeLessThanOrEqual(-120);
  });

  it('writes 24-bit and 16-bit PCM at 44.1 kHz', async () => {
    const input = fixture();
    for (const bitDepth of [24, 16] as const) {
      const { zip } = await exportZip(input, { bitDepth, sampleRate: 44100 });
      const files = unzipSync(zip);
      for (const wav of Object.values(files)) {
        expect(parseWavHeader(wav)).toMatchObject({ formatTag: 1, bitDepth, sampleRate: 44100 });
      }
    }
  });

  it('24-bit stems sum to the 24-bit mix within a few LSB', async () => {
    const input = fixture();
    const { zip } = await exportZip(input, { bitDepth: 24 });
    const files = unzipSync(zip);
    const read = (wav: Uint8Array): Int32Array => {
      const info = parseWavHeader(wav);
      const out = new Int32Array(info.frames * 2);
      for (let i = 0; i < out.length; i++) {
        const o = info.dataOffset + i * 3;
        out[i] = ((wav[o] | (wav[o + 1] << 8) | (wav[o + 2] << 16)) << 8) >> 8;
      }
      return out;
    };
    const mix = read(files['mix.wav']);
    const sum = new Float64Array(mix.length);
    let n = 0;
    for (const [name, wav] of Object.entries(files)) {
      if (name === 'mix.wav') continue;
      n++;
      const s = read(wav);
      for (let i = 0; i < s.length; i++) sum[i] += s[i];
    }
    let worst = 0;
    for (let i = 0; i < mix.length; i++) worst = Math.max(worst, Math.abs(sum[i] - mix[i]));
    // each file rounds by at most half an LSB
    expect(worst).toBeLessThanOrEqual((n + 1) / 2 + 1);
  });

  it('uses ZIP64 records when a size threshold is crossed, and the zip still reads back', async () => {
    const input = fixture();
    const zip64Threshold = 3_000_000; // entries are ~2.3 MB; the later offsets pass 3 MB
    const { zip, summary } = await exportZip(input, {}, { zip: { zip64Threshold } });
    expect(summary.zip64).toBe(true);
    expect(zip.length).toBe(planStems(input, {}, { zip64Threshold }).bytes);
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(summary.entries);
    expect(
      Buffer.from(files['mix.wav']).equals(
        Buffer.from(renderWav(input, { sampleRate: 48000, bitDepth: 32 })),
      ),
    ).toBe(true);
  });

  it('cancels mid-export: rejects with AbortError and stops writing', async () => {
    const input = fixture();
    const plan = planStems(input);
    const ac = new AbortController();
    let writes = 0;
    let writesAtAbort = -1;
    let lastEntry = '';
    const p = writeStemsZip(input, {}, () => void writes++, {
      signal: ac.signal,
      onProgress: (pr) => {
        lastEntry = pr.entry;
        if (pr.fraction > 0.3 && !ac.signal.aborted) {
          writesAtAbort = writes;
          ac.abort();
        }
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(writesAtAbort).toBeGreaterThan(0);
    // at most the chunk that was being written when the abort landed
    expect(writes - writesAtAbort).toBeLessThanOrEqual(1);
    expect(lastEntry).not.toBe(plan.entries.at(-1)?.name);
  });

  it('rejects immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      writeStemsZip(fixture(), {}, () => undefined, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
