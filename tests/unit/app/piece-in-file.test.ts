/**
 * Pictures that open (PLAN.md §15 M17): the piece written into PNG, SVG, JPEG and MP4 files and
 * read back; chunks and segments well-formed; sniffing; files without a piece; the size guard.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzlibSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  crc32,
  embedJpeg,
  embedPng,
  embedSvg,
  jpegPiece,
  MP4_PIECE_BOX,
  mp4Piece,
  packPieceJson,
  PNG_SIGNATURE,
  pngPiece,
  readFilePiece,
  sniff,
  svgPiece,
  unpackPieceJson,
} from '../../../src/app/piece-in-file';
import { memorySink, Mp4Muxer } from '../../../src/video/mp4';

const ROOT = join(import.meta.dirname, '../../..');
const kite = (): Piece => {
  const r = parsePiece(
    readFileSync(join(ROOT, 'examples/songs/kite-day.algorhythms.json'), 'utf8'),
  );
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
};

/** Kite Day with a background picture (incompressible base64, like a real photo). */
function withPicture(bytes = 300_000): Piece {
  const raw = new Uint8Array(bytes);
  let x = 1;
  for (let i = 0; i < raw.length; i++) raw[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  const src = `data:image/jpeg;base64,${Buffer.from(raw).toString('base64')}`;
  const p = kite();
  return { ...p, poster: { ...p.poster, picture: { src, w: 800, h: 600 } } };
}

// --- a small real PNG (2×2 RGBA) ---------------------------------------------------------------
function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const c = new Uint8Array(12 + data.length);
  const v = new DataView(c.buffer);
  v.setUint32(0, data.length);
  c.set(t, 4);
  c.set(data, 8);
  v.setUint32(8 + data.length, crc32(t, data));
  return c;
}
const RAW = new Uint8Array([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 1, 2, 3, 4]);
function png(): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, 2);
  v.setUint32(4, 2);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(RAW)),
    chunk('IEND', new Uint8Array(0)),
  ];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

/** Every chunk of a PNG, its CRC checked. */
function chunks(b: Uint8Array): { type: string; data: Uint8Array }[] {
  const out: { type: string; data: Uint8Array }[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p < b.length) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    const data = b.subarray(p + 8, p + 8 + len);
    expect(v.getUint32(p + 8 + len), `${type} CRC`).toBe(crc32(b.subarray(p + 4, p + 8), data));
    out.push({ type, data });
    p += 12 + len;
  }
  expect(p).toBe(b.length);
  return out;
}

describe('PNG', () => {
  it('carries the piece in an iTXt chunk before IEND; the image is untouched', () => {
    const json = serializePiece(withPicture());
    const out = embedPng(png(), json);
    const cs = chunks(out);
    expect(cs.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'iTXt', 'IEND']);
    expect(unzlibSync(cs[1]!.data)).toEqual(RAW);
    const t = cs[2]!.data;
    expect(new TextDecoder().decode(t.subarray(0, 12))).toBe('algorhythms\0');
    expect([...t.subarray(12, 16)]).toEqual([1, 0, 0, 0]); // compressed, zlib, no language
    expect(pngPiece(out)).toBe(json);
    const r = parsePiece(pngPiece(out));
    expect(r.ok && r.piece.poster?.picture?.src).toBe(withPicture().poster?.picture?.src);
  });

  it('a PNG without the chunk has no piece', () => {
    expect(pngPiece(png())).toBeNull();
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('SVG', () => {
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

  it('carries the piece in <metadata>, first in the root, and still parses', () => {
    const json = serializePiece(kite());
    const out = embedSvg(svg, json);
    expect(out).toMatch(/<svg [^>]*><metadata><algorhythms:piece xmlns:algorhythms="[^"]+" /);
    expect(out.endsWith('<rect width="10" height="10"/></svg>')).toBe(true);
    // Well-formed: the metadata is one element, its text base64 only.
    expect(out).toMatch(/encoding="zlib-base64">[A-Za-z0-9+/=]+<\/algorhythms:piece><\/metadata>/);
    expect(svgPiece(out)).toBe(json);
    expect(svgPiece(svg)).toBeNull();
  });
});

describe('JPEG', () => {
  // SOI, APP0 (JFIF), a DQT stand-in, SOS, data, EOI.
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xdb, 0, 4,
    9, 9, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9,
  ]);

  it('splits a large piece over APP15 segments after APP0 and reads it back', () => {
    const json = serializePiece(withPicture());
    const out = embedJpeg(jpeg, json);
    expect([...out.subarray(0, 20)]).toEqual([...jpeg.subarray(0, 20)]);
    expect([out[20], out[21]]).toEqual([0xff, 0xef]);
    expect([...out.subarray(out.length - 15)]).toEqual([...jpeg.subarray(jpeg.length - 15)]);
    expect(jpegPiece(out)).toBe(json);
    expect(jpegPiece(jpeg)).toBeNull();
  });
});

describe('MP4', () => {
  it('reads the piece from moov/udta, box by box', async () => {
    const json = serializePiece(kite());
    for (const layout of ['streaming', 'faststart'] as const) {
      const sink = memorySink();
      const m = new Mp4Muxer({
        layout,
        sink,
        audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
        userData: [{ type: MP4_PIECE_BOX, data: packPieceJson(json) }],
      });
      await m.addAudioChunk({ data: new Uint8Array(50), timestamp: 0, duration: 20000, key: true });
      await m.finish();
      expect(await mp4Piece(new Blob([sink.bytes() as BlobPart]))).toBe(json);
      const plain = memorySink();
      const n = new Mp4Muxer({
        layout,
        sink: plain,
        audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
      });
      await n.addAudioChunk({ data: new Uint8Array(50), timestamp: 0, duration: 20000, key: true });
      await n.finish();
      expect(await mp4Piece(new Blob([plain.bytes() as BlobPart]))).toBeNull();
    }
  });
});

describe('sniffing and reading files', () => {
  const blob = (b: Uint8Array | string) => new Blob([b as BlobPart]);

  it('tells the kinds apart', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniff(png())).toBe('png');
    expect(sniff(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniff(Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]))).toBe('mp4');
    expect(sniff(enc('﻿  {"format": "algorhythms"}'))).toBe('json');
    expect(sniff(enc('<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="…">'))).toBe('svg');
    expect(sniff(enc('<svg>'))).toBe('svg');
    expect(sniff(enc('hello'))).toBe('other');
    expect(sniff(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBe('other');
  });

  it('reads each kind, and none from a file without a piece', async () => {
    const json = serializePiece(kite());
    expect(await readFilePiece(blob(embedPng(png(), json)))).toEqual({ kind: 'png', json });
    expect(await readFilePiece(blob(png()))).toEqual({ kind: 'png', json: null });
    expect(await readFilePiece(blob(embedSvg('<svg></svg>', json)))).toEqual({
      kind: 'svg',
      json,
    });
    expect(await readFilePiece(blob(json))).toEqual({ kind: 'json', json });
    expect(await readFilePiece(blob('plain text'))).toEqual({ kind: 'other', json: null });
  });

  it('refuses a piece that inflates past the limit, and a damaged one', () => {
    const bomb = packPieceJson(' '.repeat(5_000_000));
    expect(() => unpackPieceJson(bomb, 1_000_000)).toThrow(/too large/);
    expect(unpackPieceJson(bomb, 6_000_000).length).toBe(5_000_000);
    const z = packPieceJson(serializePiece(kite()));
    expect(() => unpackPieceJson(z.subarray(0, z.length >> 1))).toThrow(/damaged/);
  });

  it('a typical piece costs little', () => {
    const json = serializePiece(kite());
    // Kite Day: well under 10 KB compressed (base64 in an SVG: a third more).
    expect(packPieceJson(json).length).toBeLessThan(10_000);
  });
});
