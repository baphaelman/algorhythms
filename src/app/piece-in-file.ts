/**
 * Pictures that open (PLAN.md §15 M17): exported files carry the whole piece (the JSON a saved
 * `.algorhythms.json` holds, background picture included), and a file is read back from it.
 * - PNG: a compressed `iTXt` chunk, keyword `algorhythms`, before IEND.
 * - SVG: `<metadata><algorhythms:piece encoding="zlib-base64">…</algorhythms:piece></metadata>`.
 * - MP4: `moov/udta/algr` holding the zlib stream (written by `Mp4Muxer`'s `userData`).
 * - JPEG (the video's thumbnail): APP15 segments `algorhythms\0` + index + count + a slice of
 *   the zlib stream (one segment holds under 64 KB).
 * Pixels are untouched. The store loads this module on demand (it carries fflate).
 */

import { Unzlib, zlibSync } from 'fflate';

/** The PNG iTXt keyword, the JPEG segment's tag and the SVG element's prefix. */
export const PIECE_KEYWORD = 'algorhythms';
/** The MP4 user-data box type. */
export const MP4_PIECE_BOX = 'algr';
/** The SVG metadata element's namespace. */
export const SVG_PIECE_NS = 'https://baphaelman.github.io/algorhythms/';

/**
 * A piece read from a file larger than this is refused (a decompression-bomb guard). Above the
 * share link's 8 MB: a background picture can be a large PNG data URL (16.7 M px at most).
 */
export const MAX_FILE_PIECE_BYTES = 128 * 1024 * 1024;
/** PNG, SVG and JPEG files over this are not read (an MP4 is read box by box). */
export const MAX_READ_BYTES = 512 * 1024 * 1024;

const TOO_BIG = 'The piece in this file is too large to open.';
const DAMAGED = 'The piece in this file is damaged.';

export type PieceFileKind = 'png' | 'svg' | 'mp4' | 'jpeg' | 'json' | 'other';

/** What a file holds: its kind and the piece's JSON text (null when it carries none). */
export interface FilePiece {
  kind: PieceFileKind;
  json: string | null;
}

const enc = new TextEncoder();
const latin1 = (b: Uint8Array): string => String.fromCharCode(...b);

/** The piece's JSON, zlib-compressed. */
export function packPieceJson(json: string): Uint8Array {
  return zlibSync(enc.encode(json), { level: 9 });
}

/** Inflates a zlib stream, refusing more than `limit` bytes out. */
export function unpackPieceJson(z: Uint8Array, limit = MAX_FILE_PIECE_BYTES): string {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const u = new Unzlib((chunk, final) => {
    total += chunk.length;
    if (total > limit) throw new Error(TOO_BIG);
    chunks.push(chunk);
    if (final) done = true;
  });
  // Small input steps bound how far one push can overshoot the limit.
  const STEP = 1024;
  try {
    for (let i = 0; i < z.length || i === 0; i += STEP) {
      u.push(z.subarray(i, i + STEP), i + STEP >= z.length);
    }
    if (!done) throw new Error(DAMAGED);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(out);
  } catch (e) {
    if (e instanceof Error && e.message === TOO_BIG) throw e;
    throw new Error(DAMAGED, { cause: e });
  }
}

// ---------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;

/** CRC-32 (ISO 3309), as PNG chunks use. */
export function crc32(...parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const p of parts)
    for (let i = 0; i < p.length; i++) c = crcTable[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const isPng = (b: Uint8Array): boolean => PNG_SIGNATURE.every((v, i) => b[i] === v);
const u32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** Chunks of a PNG: type, data offset and length. */
function* pngChunks(b: Uint8Array): Generator<{ type: string; at: number; len: number }> {
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32(b, p);
    const type = latin1(b.subarray(p + 4, p + 8));
    if (p + 12 + len > b.length) return;
    yield { type, at: p + 8, len };
    p += 12 + len;
  }
}

/** The PNG with the piece in a compressed iTXt chunk before IEND (pixels untouched). */
export function embedPng(png: Uint8Array, json: string): Uint8Array {
  if (!isPng(png)) throw new Error('Not a PNG.');
  let iend = -1;
  for (const c of pngChunks(png)) if (c.type === 'IEND') iend = c.at - 8;
  if (iend < 0) throw new Error('PNG without IEND.');
  const head = enc.encode(`${PIECE_KEYWORD}\0`);
  const z = packPieceJson(json);
  // keyword\0, compressed 1, method 0 (zlib), language "", translated keyword "", text.
  const data = new Uint8Array(head.length + 4 + z.length);
  data.set(head, 0);
  data.set([1, 0, 0, 0], head.length);
  data.set(z, head.length + 4);
  const type = enc.encode('iTXt');
  const chunk = new Uint8Array(12 + data.length);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  v.setUint32(8 + data.length, crc32(type, data));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, iend), 0);
  out.set(chunk, iend);
  out.set(png.subarray(iend), iend + chunk.length);
  return out;
}

/** The piece's JSON from a PNG's iTXt chunk, or null. */
export function pngPiece(png: Uint8Array): string | null {
  if (!isPng(png)) return null;
  const key = `${PIECE_KEYWORD}\0`;
  for (const c of pngChunks(png)) {
    if (c.type !== 'iTXt' || c.len < key.length + 4) continue;
    const d = png.subarray(c.at, c.at + c.len);
    if (latin1(d.subarray(0, key.length)) !== key) continue;
    const compressed = d[key.length] === 1;
    let p = key.length + 2;
    for (let n = 0; n < 2; n++) {
      while (p < d.length && d[p] !== 0) p++;
      p++;
    }
    const text = d.subarray(p);
    return compressed ? unpackPieceJson(text) : new TextDecoder().decode(text);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------------------------

function base64(b: Uint8Array): string {
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < b.length; i += STEP) s += String.fromCharCode(...b.subarray(i, i + STEP));
  return btoa(s);
}

function unbase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The SVG with the piece in `<metadata>` (base64 of the zlib stream), after the root's tag. */
export function embedSvg(svg: string, json: string): string {
  const m = /<svg\b[^>]*>/.exec(svg);
  if (!m) throw new Error('Not an SVG.');
  const meta =
    `<metadata><${PIECE_KEYWORD}:piece xmlns:${PIECE_KEYWORD}="${SVG_PIECE_NS}" ` +
    `encoding="zlib-base64">${base64(packPieceJson(json))}</${PIECE_KEYWORD}:piece></metadata>`;
  const at = m.index + m[0].length;
  return svg.slice(0, at) + meta + svg.slice(at);
}

const SVG_PIECE = new RegExp(
  `<${PIECE_KEYWORD}:piece\\b[^>]*encoding="zlib-base64"[^>]*>([A-Za-z0-9+/=\\s]*)</${PIECE_KEYWORD}:piece>`,
);

/** The piece's JSON from an SVG's metadata, or null. */
export function svgPiece(svg: string): string | null {
  const m = SVG_PIECE.exec(svg);
  return m ? unpackPieceJson(unbase64(m[1]!)) : null;
}

const looksSvg = (head: string): boolean =>
  /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg\b/i.test(head);

// ---------------------------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------------------------

const JPEG_APP = 0xef; // APP15
const JPEG_TAG = enc.encode(`${PIECE_KEYWORD}\0`);
/** Data bytes per segment: 65535 − length (2) − tag − index and count (4). */
const JPEG_SLICE = 65535 - 2 - JPEG_TAG.length - 4;

const isJpeg = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Markers before the scan: [offset of 0xFF, marker, segment length incl. its 2 bytes]. */
function* jpegSegments(b: Uint8Array): Generator<{ at: number; marker: number; len: number }> {
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1]!;
    if (marker === 0xda || marker === 0xd9) return; // start of scan, end of image
    const len = (b[p + 2]! << 8) | b[p + 3]!;
    yield { at: p, marker, len };
    p += 2 + len;
  }
}

/** The JPEG with the piece in APP15 segments after its APPn header segments. */
export function embedJpeg(jpeg: Uint8Array, json: string): Uint8Array {
  if (!isJpeg(jpeg)) throw new Error('Not a JPEG.');
  let at = 2;
  for (const s of jpegSegments(jpeg)) {
    if (s.marker < 0xe0 || s.marker > 0xef) break;
    at = s.at + 2 + s.len;
  }
  const z = packPieceJson(json);
  const count = Math.max(1, Math.ceil(z.length / JPEG_SLICE));
  const segs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const data = z.subarray(i * JPEG_SLICE, (i + 1) * JPEG_SLICE);
    const s = new Uint8Array(4 + JPEG_TAG.length + 4 + data.length);
    const v = new DataView(s.buffer);
    s[0] = 0xff;
    s[1] = JPEG_APP;
    v.setUint16(2, s.length - 2);
    s.set(JPEG_TAG, 4);
    v.setUint16(4 + JPEG_TAG.length, i);
    v.setUint16(6 + JPEG_TAG.length, count);
    s.set(data, 8 + JPEG_TAG.length);
    segs.push(s);
  }
  const extra = segs.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(jpeg.length + extra);
  out.set(jpeg.subarray(0, at), 0);
  let o = at;
  for (const s of segs) {
    out.set(s, o);
    o += s.length;
  }
  out.set(jpeg.subarray(at), o);
  return out;
}

/** The piece's JSON from a JPEG's APP15 segments, or null (also when one is missing). */
export function jpegPiece(jpeg: Uint8Array): string | null {
  if (!isJpeg(jpeg)) return null;
  const parts: Uint8Array[] = [];
  let count = 0;
  for (const s of jpegSegments(jpeg)) {
    if (s.marker !== JPEG_APP) continue;
    const body = jpeg.subarray(s.at + 4, s.at + 2 + s.len);
    if (!JPEG_TAG.every((v, i) => body[i] === v)) continue;
    const v = new DataView(body.buffer, body.byteOffset, body.length);
    const i = v.getUint16(JPEG_TAG.length);
    count = v.getUint16(JPEG_TAG.length + 2);
    parts[i] = body.subarray(JPEG_TAG.length + 4);
  }
  if (count === 0) return null;
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (!parts[i]) throw new Error(DAMAGED);
    n += parts[i]!.length;
  }
  const z = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < count; i++) {
    z.set(parts[i]!, o);
    o += parts[i]!.length;
  }
  return unpackPieceJson(z);
}

// ---------------------------------------------------------------------------------------------
// MP4 (the box is written by Mp4Muxer's `userData`; read here box by box, so a large file is
// not read whole)
// ---------------------------------------------------------------------------------------------

/** The muxer's `userData` entry for this piece. */
export function mp4PieceBox(json: string): { type: string; data: Uint8Array } {
  return { type: MP4_PIECE_BOX, data: packPieceJson(json) };
}

/** Reads `len` bytes at `at` of a Blob. */
async function bytesAt(file: Blob, at: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(at, at + len).arrayBuffer());
}

/** Child boxes of `b` in [from, to): type, payload offset and payload length. */
function* boxes(
  b: Uint8Array,
  from = 0,
  to = b.length,
): Generator<{ type: string; at: number; len: number }> {
  let p = from;
  while (p + 8 <= to) {
    let size = u32(b, p);
    const type = latin1(b.subarray(p + 4, p + 8));
    let head = 8;
    if (size === 1) {
      if (p + 16 > to) return;
      size = u32(b, p + 8) * 0x100000000 + u32(b, p + 12);
      head = 16;
    } else if (size === 0) size = to - p;
    if (size < head || p + size > to) return;
    yield { type, at: p + head, len: size - head };
    p += size;
  }
}

/** The piece's JSON from an MP4's `moov/udta/algr`, or null. */
export async function mp4Piece(file: Blob): Promise<string | null> {
  let p = 0;
  while (p + 8 <= file.size) {
    const h = await bytesAt(file, p, 16);
    let size = u32(h, 0);
    const type = latin1(h.subarray(4, 8));
    let head = 8;
    if (size === 1) {
      size = u32(h, 8) * 0x100000000 + u32(h, 12);
      head = 16;
    } else if (size === 0) size = file.size - p;
    if (size < head) return null;
    if (type === 'moov') {
      if (size > MAX_READ_BYTES) return null;
      const moov = await bytesAt(file, p + head, size - head);
      for (const u of boxes(moov)) {
        if (u.type !== 'udta') continue;
        for (const a of boxes(moov, u.at, u.at + u.len)) {
          if (a.type === MP4_PIECE_BOX) return unpackPieceJson(moov.subarray(a.at, a.at + a.len));
        }
      }
      return null;
    }
    p += size;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------------------------

/** The kind of a file from its first bytes. */
export function sniff(head: Uint8Array): PieceFileKind {
  if (isPng(head)) return 'png';
  if (isJpeg(head)) return 'jpeg';
  if (latin1(head.subarray(4, 8)) === 'ftyp') return 'mp4';
  const text = new TextDecoder().decode(head).replace(/^\uFEFF/, '');
  if (/^\s*[{[]/.test(text)) return 'json';
  if (looksSvg(text)) return 'svg';
  return 'other';
}

/**
 * What a file holds. Throws a readable Error when its piece is damaged or too large, or the
 * file too large to read.
 */
export async function readFilePiece(file: Blob): Promise<FilePiece> {
  const kind = sniff(await bytesAt(file, 0, 1024));
  if (kind === 'mp4') return { kind, json: await mp4Piece(file) };
  if (kind === 'other') return { kind, json: null };
  if (file.size > MAX_READ_BYTES) throw new Error('This file is too large to open.');
  if (kind === 'json') return { kind, json: await file.text() };
  if (kind === 'svg') return { kind, json: svgPiece(await file.text()) };
  const b = new Uint8Array(await file.arrayBuffer());
  return { kind, json: kind === 'png' ? pngPiece(b) : jpegPiece(b) };
}
