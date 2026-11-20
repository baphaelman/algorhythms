/**
 * In-house WAV writer (PLAN.md §12, §14): stereo or mono, 44.1/48 kHz (any rate works),
 * 16-bit PCM with seeded TPDF dither, 24-bit PCM, or 32-bit IEEE float.
 *
 * - PCM files use the canonical 44-byte header (WAVE_FORMAT_PCM, 16-byte fmt chunk).
 * - Float files use WAVE_FORMAT_IEEE_FLOAT with an 18-byte fmt chunk (cbSize = 0) and a `fact`
 *   chunk, as the format requires for non-PCM data (58-byte header).
 * - The encoder is stateful only in its dither PRNG, so encoding a render in chunks of any size
 *   gives the same bytes as encoding it at once.
 */

import { Prng } from '../dsp/rng';

/** Supported sample formats. */
export type WavBitDepth = 16 | 24 | 32;

/** A WAV stream's format. */
export interface WavFormat {
  sampleRate: number;
  bitDepth: WavBitDepth;
  channels: 1 | 2;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;

/** Bytes per sample frame. */
export function wavBlockAlign(format: WavFormat): number {
  return (format.bitDepth / 8) * format.channels;
}

/** Header size in bytes for a format (44 for PCM, 58 for float). */
export function wavHeaderSize(format: WavFormat): number {
  return format.bitDepth === 32 ? 58 : 44;
}

function ascii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** The header for `frames` frames of audio. Throws if the file would exceed 4 GiB. */
export function wavHeader(format: WavFormat, frames: number): Uint8Array<ArrayBuffer> {
  const isFloat = format.bitDepth === 32;
  const size = wavHeaderSize(format);
  const dataBytes = frames * wavBlockAlign(format);
  if (size - 8 + dataBytes > 0xffffffff) throw new Error('WAV export exceeds 4 GiB');
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  ascii(v, 0, 'RIFF');
  v.setUint32(4, size - 8 + dataBytes, true);
  ascii(v, 8, 'WAVE');
  ascii(v, 12, 'fmt ');
  v.setUint32(16, isFloat ? 18 : 16, true);
  v.setUint16(20, isFloat ? FORMAT_FLOAT : FORMAT_PCM, true);
  v.setUint16(22, format.channels, true);
  v.setUint32(24, format.sampleRate, true);
  v.setUint32(28, format.sampleRate * wavBlockAlign(format), true);
  v.setUint16(32, wavBlockAlign(format), true);
  v.setUint16(34, format.bitDepth, true);
  let o = 36;
  if (isFloat) {
    v.setUint16(36, 0, true); // cbSize
    ascii(v, 38, 'fact');
    v.setUint32(42, 4, true);
    v.setUint32(46, frames, true);
    o = 50;
  }
  ascii(v, o, 'data');
  v.setUint32(o + 4, dataBytes, true);
  return out;
}

/** Converts float frames to WAV sample bytes. One instance per file (it carries dither state). */
export class WavEncoder {
  readonly format: WavFormat;
  private readonly dither: Prng;

  /** `seed` seeds the 16-bit TPDF dither (the piece seed, so exports repeat exactly). */
  constructor(format: WavFormat, seed: number) {
    this.format = format;
    this.dither = new Prng((seed ^ 0xd1a7e5) >>> 0);
  }

  /** Encodes `frames` frames (default: all) of `left` (and `right` for stereo). */
  encode(
    left: Float32Array,
    right: Float32Array | null,
    frames = left.length,
  ): Uint8Array<ArrayBuffer> {
    const { bitDepth, channels } = this.format;
    const out = new Uint8Array(frames * wavBlockAlign(this.format));
    const v = new DataView(out.buffer);
    let o = 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const x = c === 0 || right === null ? left[i] : right[i];
        if (bitDepth === 32) {
          v.setFloat32(o, x, true);
          o += 4;
        } else if (bitDepth === 24) {
          let s = Math.round(x * 8388607);
          s = s > 8388607 ? 8388607 : s < -8388608 ? -8388608 : s;
          v.setUint8(o, s & 0xff);
          v.setUint8(o + 1, (s >> 8) & 0xff);
          v.setUint8(o + 2, (s >> 16) & 0xff);
          o += 3;
        } else {
          // TPDF dither: the difference of two uniform values, ±1 LSB, triangular.
          const d = this.dither.next() - this.dither.next();
          let s = Math.round(x * 32767 + d);
          s = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
          v.setInt16(o, s, true);
          o += 2;
        }
      }
    }
    return out;
  }
}

/** Parsed header facts, for tests and the e2e check. */
export interface WavInfo {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitDepth: number;
  blockAlign: number;
  byteRate: number;
  dataOffset: number;
  dataBytes: number;
  frames: number;
  factFrames?: number;
}

/** Parses and validates a WAV header; throws on anything malformed. */
export function parseWavHeader(bytes: Uint8Array): WavInfo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  if (v.getUint32(4, true) !== bytes.byteLength - 8) throw new Error('RIFF size mismatch');
  let o = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataBytes' | 'frames'> | null = null;
  let factFrames: number | undefined;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = {
        formatTag: v.getUint16(o + 8, true),
        channels: v.getUint16(o + 10, true),
        sampleRate: v.getUint32(o + 12, true),
        byteRate: v.getUint32(o + 16, true),
        blockAlign: v.getUint16(o + 20, true),
        bitDepth: v.getUint16(o + 22, true),
      };
    } else if (id === 'fact') {
      factFrames = v.getUint32(o + 8, true);
    } else if (id === 'data') {
      if (!fmt) throw new Error('data before fmt');
      if (fmt.blockAlign !== (fmt.bitDepth / 8) * fmt.channels) throw new Error('bad blockAlign');
      if (fmt.byteRate !== fmt.sampleRate * fmt.blockAlign) throw new Error('bad byteRate');
      if (o + 8 + size !== bytes.byteLength) throw new Error('data size mismatch');
      return {
        ...fmt,
        dataOffset: o + 8,
        dataBytes: size,
        frames: size / fmt.blockAlign,
        factFrames,
      };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}
