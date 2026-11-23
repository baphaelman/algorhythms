/**
 * Stems export (PLAN.md §12 "Stems: exact sums and memory"): a store-mode ZIP holding the mix, one
 * stereo (panned) WAV per sounding voice, and one FX-returns WAV. Pure apart from computing (no
 * Worker, no DOM): stems.worker.ts runs it off the main thread, stems-client.ts is the API for the
 * UI, and the Node tests call it directly.
 *
 * Exact sums: pass 1 renders the whole mix (that is `mix.wav`) and records the limiter's per-sample
 * gain g_L (the glue compressor's gain included). Each voice then gets its own pass: its dry
 * signal → master tone → width (linear) → the limiter's 5 ms delay → × g_L (graph render mode
 * `Voice`, limiter replay). One more pass does the same for the reverb and delay returns (`Fx`).
 * Σ voice stems + FX stem = mix, up to float rounding. Memory: one pass at a time, so one chunk
 * of audio plus g_L (4 bytes per frame) is all that is held.
 *
 * Output order: `mix.wav`, the voices in pool order, `fx-returns.wav`. A voice that never sounds,
 * or is muted (or not soloed while another voice is), contributes nothing to the mix and gets no
 * stem.
 */

import { flatten, type FlatScore } from '../core/flat';
import { VOICE_MUTE, VOICE_SOLO, VOICE_STRIDE } from '../core/segment';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import { BLOCK_FRAMES } from '../dsp/constants';
import { createLoadedGraph, exportFrameCount } from './offline';
import { RenderMode } from '../dsp/graph';
import { WavEncoder, wavBlockAlign, wavHeader, wavHeaderSize, type WavBitDepth } from './wav';
import { ZipWriter, zipNeedsZip64, zipSize, type ZipSink, type ZipOptions } from './zip';

/** Warn the user above this estimated size (PLAN.md §12: "about 1 GB"). */
export const STEMS_WARN_BYTES = 1e9;

/** Options for the export (callbacks and the output target live on the client request). */
export interface StemsOptions {
  /** Output sample rate. @default 48000 */
  sampleRate?: 44100 | 48000;
  /**
   * Sample format of every WAV: 32 = float (default, what DAWs want), 24 = PCM, 16 = PCM with
   * seeded TPDF dither (the sum is then exact only to ±1 LSB).
   */
  bitDepth?: WavBitDepth;
  /**
   * Mono stems: each voice and the FX returns are written as (L + R) / 2, half the size. Σ stems
   * then equals the mono downmix of the mix. `mix.wav` stays stereo. @default false
   */
  mono?: boolean;
  /** Display names by voice id; used for file names, else the id is. */
  voiceNames?: Record<string, string>;
  /** Seconds of audio per chunk handed to the zip (whole blocks). @default 1 */
  chunkSeconds?: number;
}

/** What to export. */
export interface StemsInput {
  score: CompiledScore | FlatScore;
  mix: MixSettings;
  /** Piece timbres (Piece.timbres); built-ins are always available. */
  timbres?: Record<string, Timbre>;
}

/** One file in the archive. */
export interface StemEntry {
  /** File name inside the zip, e.g. `bass.wav`. */
  name: string;
  kind: 'mix' | 'voice' | 'fx';
  /** Pool index and id, for voice stems. */
  voiceIndex?: number;
  voiceId?: string;
  /** Size of the WAV file in bytes. */
  bytes: number;
}

/** The archive an export would produce, known before rendering. */
export interface StemsPlan {
  sampleRate: number;
  bitDepth: WavBitDepth;
  mono: boolean;
  /** Frames in every WAV (the piece plus its FX tail). */
  frames: number;
  entries: StemEntry[];
  /** Exact byte length of the zip. */
  bytes: number;
  /** True when any ZIP64 record is used (archive over 4 GiB). */
  zip64: boolean;
  /** True when `bytes` is above STEMS_WARN_BYTES: the UI should warn. */
  large: boolean;
}

/** Progress after each chunk. */
export interface StemsProgress {
  /** Fraction of the whole export done, 0..1 (each file counts the same). */
  fraction: number;
  /** The file being rendered. */
  entry: string;
  /** Zero-based position of that file, and the number of files. */
  index: number;
  total: number;
}

/** What `writeStemsZip` returns. */
export interface StemsSummary {
  bytes: number;
  entries: string[];
  zip64: boolean;
}

const MIX_NAME = 'mix.wav';
const FX_NAME = 'fx-returns.wav';

function isFlat(score: CompiledScore | FlatScore): score is FlatScore {
  return 'layout' in score;
}

/** Voices that make sound in the mix: ever alive, not muted, and soloed if anything is. */
export function soundingVoices(score: CompiledScore | FlatScore): { index: number; id: string }[] {
  const out: { index: number; id: string }[] = [];
  if (isFlat(score)) {
    let anySolo = false;
    for (let i = 0; i < score.voiceIds.length; i++) {
      if (score.voiceParams[i * VOICE_STRIDE + VOICE_SOLO] === 1) anySolo = true;
    }
    score.voiceIds.forEach((id, i) => {
      const p = i * VOICE_STRIDE;
      const muted = score.voiceParams[p + VOICE_MUTE] === 1;
      const solo = score.voiceParams[p + VOICE_SOLO] === 1;
      if (score.voices[i].lives.length > 0 && !muted && (!anySolo || solo)) {
        out.push({ index: i, id });
      }
    });
  } else {
    const anySolo = score.voices.some((v) => v.solo);
    for (const v of score.voices) {
      if (v.lives.length > 0 && !v.mute && (!anySolo || v.solo)) {
        out.push({ index: v.index, id: v.id });
      }
    }
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const UNSAFE_IN_FILE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** A file-name-safe version of `name`: no separators or control characters, at most 80 chars. */
export function safeStemName(name: string): string {
  const s = name.replace(UNSAFE_IN_FILE_NAME, '_').replace(/\s+/g, ' ').trim();
  return s.replace(/^\.+/, '_').slice(0, 80);
}

function wavBytes(frames: number, bitDepth: WavBitDepth, channels: 1 | 2): number {
  const format = { sampleRate: 48000, bitDepth, channels } as const;
  return wavHeaderSize(format) + frames * wavBlockAlign(format);
}

/**
 * The archive an export would produce: its files, exact size and whether it needs ZIP64. Cheap
 * (no rendering); the UI calls it to warn above `STEMS_WARN_BYTES` and to show the file list.
 */
export function planStems(
  input: StemsInput,
  options: StemsOptions = {},
  zipOptions: ZipOptions = {},
): StemsPlan {
  const sampleRate = options.sampleRate ?? 48000;
  const bitDepth = options.bitDepth ?? 32;
  const mono = options.mono ?? false;
  const frames = exportFrameCount(input.score, input.mix, sampleRate);
  const used = new Set<string>([MIX_NAME, FX_NAME]);
  const entries: StemEntry[] = [
    { name: MIX_NAME, kind: 'mix', bytes: wavBytes(frames, bitDepth, 2) },
  ];
  for (const v of soundingVoices(input.score)) {
    const base = safeStemName(options.voiceNames?.[v.id] ?? v.id) || `voice-${v.index + 1}`;
    let name = `${base}.wav`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}.wav`;
    used.add(name.toLowerCase());
    entries.push({
      name,
      kind: 'voice',
      voiceIndex: v.index,
      voiceId: v.id,
      bytes: wavBytes(frames, bitDepth, mono ? 1 : 2),
    });
  }
  entries.push({ name: FX_NAME, kind: 'fx', bytes: wavBytes(frames, bitDepth, mono ? 1 : 2) });
  const specs = entries.map((e) => ({ name: e.name, size: e.bytes }));
  const bytes = zipSize(specs, zipOptions);
  return {
    sampleRate,
    bitDepth,
    mono,
    frames,
    entries,
    bytes,
    zip64: zipNeedsZip64(specs, zipOptions),
    large: bytes > STEMS_WARN_BYTES,
  };
}

/** Size estimate for the UI (see `planStems`). */
export function estimateStemsSize(
  input: StemsInput,
  options: StemsOptions = {},
): { bytes: number; files: number; large: boolean; zip64: boolean } {
  const p = planStems(input, options);
  return { bytes: p.bytes, files: p.entries.length, large: p.large, zip64: p.zip64 };
}

/** Hooks for a running export. */
export interface StemsHooks {
  onProgress?: (p: StemsProgress) => void;
  /** Checked between chunks; aborting rejects with an AbortError. */
  signal?: AbortSignal;
  /** Test hook: forwarded to the zip writer (a lowered ZIP64 threshold). */
  zip?: ZipOptions;
}

function abortError(): DOMException {
  return new DOMException('Stems export cancelled', 'AbortError');
}

/**
 * Renders the whole export and writes the zip to `sink`, in order, awaiting it (so a slow sink
 * slows the render: backpressure). Resolves with the archive's size and file list.
 */
export async function writeStemsZip(
  input: StemsInput,
  options: StemsOptions,
  sink: ZipSink,
  hooks: StemsHooks = {},
): Promise<StemsSummary> {
  const flat = isFlat(input.score) ? input.score : flatten(input.score);
  const plan = planStems({ ...input, score: flat }, options, hooks.zip);
  const { sampleRate, bitDepth, frames } = plan;
  const blocksPerChunk = Math.max(
    1,
    Math.round(((options.chunkSeconds ?? 1) * sampleRate) / BLOCK_FRAMES),
  );
  const chunkFrames = blocksPerChunk * BLOCK_FRAMES;
  const left = new Float32Array(chunkFrames);
  const right = new Float32Array(chunkFrames);
  const bl = new Float32Array(BLOCK_FRAMES);
  const br = new Float32Array(BLOCK_FRAMES);
  const renderInput = { score: flat, mix: input.mix, timbres: input.timbres, sampleRate };
  const zip = new ZipWriter(sink, hooks.zip);
  /** g_L from pass 1, replayed by every stem pass. */
  const gain = new Float32Array(frames);
  const total = plan.entries.length;

  for (let index = 0; index < total; index++) {
    const entry = plan.entries[index];
    if (hooks.signal?.aborted) throw abortError();
    const channels = entry.kind === 'mix' || !plan.mono ? 2 : 1;
    const format = { sampleRate, bitDepth, channels } as const;
    const graph = createLoadedGraph(renderInput);
    if (entry.kind === 'mix') {
      graph.setLimiterCapture(gain);
    } else {
      graph.setRenderMode(
        entry.kind === 'voice' ? RenderMode.Voice : RenderMode.Fx,
        entry.voiceIndex ?? -1,
      );
      graph.setLimiterReplay(gain);
    }
    graph.play(0);
    // A different dither stream per file, so 16-bit dither doesn't add coherently across stems.
    const encoder = new WavEncoder(format, (flat.seed + Math.imul(index, 0x9e3779b1)) >>> 0);

    await zip.begin(entry.name, entry.bytes);
    await zip.write(wavHeader(format, frames));
    for (let done = 0; done < frames;) {
      const n = Math.min(chunkFrames, frames - done);
      for (let f = 0; f < n; f += BLOCK_FRAMES) {
        graph.process(bl, br);
        if (channels === 1) {
          for (let i = 0; i < BLOCK_FRAMES; i++) left[f + i] = 0.5 * (bl[i] + br[i]);
        } else {
          left.set(bl, f);
          right.set(br, f);
        }
      }
      done += n;
      await zip.write(encoder.encode(left, channels === 1 ? null : right, n));
      hooks.onProgress?.({
        fraction: (index + done / frames) / total,
        entry: entry.name,
        index,
        total,
      });
      if (hooks.signal?.aborted) throw abortError();
    }
    await zip.end();
  }
  await zip.finish();
  return { bytes: zip.bytesWritten, entries: plan.entries.map((e) => e.name), zip64: plan.zip64 };
}
