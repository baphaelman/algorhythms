/**
 * Share links (PLAN.md §11.4): `#p=<payload>`. The fragment never reaches a server.
 *
 * Two payload versions:
 * - **v1** (unmarked, the first links): base64url(deflate-raw(JSON of the piece)). Still opens.
 * - **v2** (`2.` + base64url): the piece with its defaults stripped (`stripDefaults`), unchanged
 *   built-in timbres written as `1`, moment ids that just count up from the previous one omitted,
 *   moment times as whole-millisecond steps from the previous moment, and tune notes as flat
 *   `[pitch, len, …]` lists (a rest's pitch is `null`, revision 10), progression chords as flat
 *   `[notes, len, …]` lists (revision 10), camera keys without an ease as flat
 *   `[at, window, place, pitch, range, …]` lists (M11.5) and Over-the-poster keys as `[at, x, y, h, …]`
 *   (M15), the video packed (M17: short names, flat section and placed readouts), and the
 *   poster packed (M14: default
 *   text boxes as their ids, boxes (per-row ones too) as `[x, y, w, h]`, linked margins as one number,
 *   a QR code with only a box as its box); then
 *   deflate-raw with a preset dictionary (share-dict.ts) via fflate.
 *   A piece the v2 packing can't express exactly is written as v1 (stripped JSON) instead.
 *
 * A poster's background picture (M14) is never in a link (`shareablePiece`): the link's poster
 * falls back to its background colour.
 *
 * A watch link (M17) is a share link with the watch flag first: `#w&p=<payload>`, or
 * `#w&<example-id>` for an unedited bundled example. It opens the piece to watch its video. An
 * example's may name the video's frame (`#w&<id>&f=poster` or `f=row`) when its maker's differs
 * from the bare example's (a poster doc makes it Over the poster); unknown values are ignored.
 *
 * Pieces are canonical (core/canonical.ts, applied on load and on every edit), so
 * `decode(encode(p))` is exactly `p` and `encode(decode(link))` gives the same link back.
 */

import { cloneJson } from '../core/defaults';
import { TimbreSchema, jsonEqual, parsePiece, stripDefaults } from '../core/schema';
import { BUILTIN_TIMBRES } from '../core/timbres';
import type { CameraFrame, Piece } from '../core/types';
import { DEFAULT_POSTER_TEXTS } from '../render/poster-layout';
import { SHARE_DICTIONARY_V2 } from './share-dict';

/** The fragment key: `#p=<payload>`. */
export const SHARE_KEY = 'p';

/** Decoded JSON larger than this is refused (a guard against decompression bombs). */
export const MAX_DECODED_BYTES = 8 * 1024 * 1024;

/** Links longer than this are truncated by some chat apps; the UI offers a file instead (§11.4). */
export const LONG_LINK_CHARS = 2000;

/** Marks a v2 payload ('.' is not in the base64url alphabet, so v1 payloads never start so). */
const V2 = '2.';

type Rec = Record<string, unknown>;

function isRec(x: unknown): x is Rec {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text))
    throw new Error('The link contains characters that are not base64url.');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const TOO_BIG = 'The link expands to more data than a piece can hold.';

/** Runs bytes through a (de)compression stream, stopping once the output exceeds `limit` bytes. */
async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit = Infinity,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Errors surface on the reader side; ignore the writer's copies of them.
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(TOO_BIG);
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

const dictionary = (): Uint8Array => new TextEncoder().encode(SHARE_DICTIONARY_V2);

/** fflate is loaded on demand: only sharing and opening a v2 link need it. */
async function deflateV2(bytes: Uint8Array): Promise<Uint8Array> {
  const { deflateSync } = await import('fflate');
  return deflateSync(bytes, { level: 9, mem: 9, dictionary: dictionary() });
}

async function inflateV2(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const { Inflate } = await import('fflate');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate({ dictionary: dictionary() }, (chunk) => {
    total += chunk.length;
    if (total > limit) throw new Error(TOO_BIG);
    chunks.push(chunk);
  });
  // Small input steps bound how far one push can overshoot the limit.
  const STEP = 1024;
  for (let i = 0; i < bytes.length || i === 0; i += STEP) {
    inflater.push(bytes.subarray(i, i + STEP), i + STEP >= bytes.length);
  }
  return concat(chunks, total);
}

// ---------------------------------------------------------------------------------------------
// v2 packing
// ---------------------------------------------------------------------------------------------

/** `kd0041` → `kd0042` (same width); null when the id has no digit suffix or would widen. */
export function nextId(id: string): string | null {
  const m = /^(.*?)(\d+)$/.exec(id);
  if (!m) return null;
  const n = String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return n.length > m[2].length || !Number.isSafeInteger(Number(m[2])) ? null : m[1] + n;
}

/** Whole milliseconds, or null when `t` is not on the 1 ms grid. */
function wholeMs(t: unknown): number | null {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  const k = Math.round(t * 1000);
  return k / 1000 === t && Number.isSafeInteger(k) ? k : null;
}

const parsedBuiltins = new Map<string, unknown>();

/** The built-in timbre `name` as `parsePiece` fills it, or undefined. */
function builtin(name: string): unknown {
  if (!Object.hasOwn(BUILTIN_TIMBRES, name)) return undefined;
  if (!parsedBuiltins.has(name)) {
    parsedBuiltins.set(name, TimbreSchema.parse(cloneJson(BUILTIN_TIMBRES[name])));
  }
  return parsedBuiltins.get(name);
}

/**
 * A tune note that packs into a `[pitch, len]` pair (no other fields); a rest (revision 10) into
 * `[null, len]`.
 */
function plainNote(n: unknown): n is { pitch: number; len: number } | { rest: true; len: number } {
  return (
    isRec(n) &&
    Object.keys(n).length === 2 &&
    (typeof n.pitch === 'number' || n.rest === true) &&
    typeof n.len === 'number'
  );
}

/** A progression chord that packs into a `[notes, len]` pair (no other fields). */
function plainChord(c: unknown): c is { notes: string; len: number } {
  return (
    isRec(c) &&
    Object.keys(c).length === 2 &&
    typeof c.notes === 'string' &&
    typeof c.len === 'number'
  );
}

/** The fields of a camera key, in its flat `[at, window, place, pitch, range]` packing. */
const KEY_FIELDS = ['at', 'window', 'place', 'pitch', 'range'] as const;

/** A key that packs flat: exactly the numbers of `fields` (no ease). */
function plainOf(fields: readonly string[]) {
  return (k: unknown): k is Record<string, number> =>
    isRec(k) &&
    Object.keys(k).length === fields.length &&
    fields.every((f) => typeof k[f] === 'number');
}

/** A camera key that packs flat: exactly the five numbers (no ease). */
const plainKey = plainOf(KEY_FIELDS);

/** The fields of an Over-the-poster key (M15), in its flat `[at, x, y, h]` packing. */
const POSTER_KEY_FIELDS = ['at', 'x', 'y', 'h'] as const;
const plainPosterKey = plainOf(POSTER_KEY_FIELDS);

/** Flat keys back to objects, or null when `v` isn't a flat list of `fields`. */
function keysOf(v: unknown, fields: readonly string[]): Rec[] | null {
  if (!Array.isArray(v) || v.length % fields.length !== 0) return null;
  if (!v.every((x) => typeof x === 'number')) return null;
  const keys: Rec[] = [];
  for (let i = 0; i < v.length; i += fields.length) {
    const k: Rec = {};
    fields.forEach((f, j) => (k[f] = v[i + j]));
    keys.push(k);
  }
  return keys;
}

const BOX_FIELDS = ['x', 'y', 'w', 'h'] as const;

/** A box that packs flat: exactly its four numbers. */
function plainBox(b: unknown): b is Record<(typeof BOX_FIELDS)[number], number> {
  return (
    isRec(b) &&
    Object.keys(b).length === BOX_FIELDS.length &&
    BOX_FIELDS.every((f) => typeof b[f] === 'number')
  );
}

const flatBox = (b: unknown): unknown => (plainBox(b) ? BOX_FIELDS.map((f) => b[f]) : b);

function boxOf(v: unknown): unknown {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => typeof x === 'number')) return v;
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}

/** A record of boxes, each packed flat (or unpacked). */
function boxesOf(v: unknown, f: (b: unknown) => unknown): unknown {
  if (!isRec(v)) return v;
  const out: Rec = {};
  for (const [k, b] of Object.entries(v)) out[k] = f(b);
  return out;
}

/** `o` with its `box` and per-row `rows` packed flat (or unpacked). */
function withBox(o: unknown, f: (b: unknown) => unknown): unknown {
  if (!isRec(o)) return o;
  const out: Rec = { ...o };
  if ('box' in o) out.box = f(o.box);
  if ('rows' in o) out.rows = boxesOf(o.rows, f);
  return out;
}

/** The poster's packing (M14): see the module comment. */
function packPoster(poster: Rec): Rec {
  const out: Rec = { ...poster };
  const m = out.margins;
  if (
    isRec(m) &&
    Object.keys(m).length === 4 &&
    typeof m.top === 'number' &&
    m.right === m.top &&
    m.bottom === m.top &&
    m.left === m.top
  )
    out.margins = m.top;
  if (Array.isArray(out.layers)) out.layers = out.layers.map((l) => withBox(l, flatBox));
  if (out.rowBoxes !== undefined) out.rowBoxes = boxesOf(out.rowBoxes, flatBox);
  if (Array.isArray(out.texts)) {
    out.texts = out.texts.map((t) => {
      const d = DEFAULT_POSTER_TEXTS.find((x) => jsonEqual(x, t));
      return d ? d.id : withBox(t, flatBox);
    });
  }
  // A QR code with only a box packs as the box (M17).
  const q = out.qr;
  if (isRec(q) && Object.keys(q).length === 1 && plainBox(q.box)) out.qr = flatBox(q.box);
  else if (isRec(q)) out.qr = withBox(q, flatBox);
  return out;
}

function unpackPoster(poster: Rec): Rec {
  const out: Rec = { ...poster };
  if (typeof out.margins === 'number') {
    const v = out.margins;
    out.margins = { top: v, right: v, bottom: v, left: v };
  }
  if (Array.isArray(out.layers)) out.layers = out.layers.map((l) => withBox(l, boxOf));
  if (out.rowBoxes !== undefined) out.rowBoxes = boxesOf(out.rowBoxes, boxOf);
  if (Array.isArray(out.texts)) {
    out.texts = out.texts.map((t) => {
      const d = typeof t === 'string' ? DEFAULT_POSTER_TEXTS.find((x) => x.id === t) : undefined;
      return d ? cloneJson(d) : withBox(t, boxOf);
    });
  }
  if (Array.isArray(out.qr)) out.qr = { box: boxOf(out.qr) };
  else if (isRec(out.qr)) out.qr = withBox(out.qr, boxOf);
  return out;
}

/** The video record's short names in a link (M17), by field. */
const VIDEO_KEYS: Readonly<Record<string, string>> = {
  aspect: 'a',
  whole: 'W',
  followAt: 'f',
  window: 'w',
  zoom: 'z',
  hud: 'h',
  hudLayout: 'H',
  ahead: 'A',
  section: 's',
  fadeIn: 'i',
  leadIn: 'L',
  titleCard: 'T',
  title: 't',
  subtitle: 'u',
  fadeOut: 'o',
  endCard: 'e',
  credit: 'c',
  look: 'l',
};
const VIDEO_LONG: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(VIDEO_KEYS).map(([k, v]) => [v, k]),
);

/** A placed readout `{anchor, x, y}` packs as `[anchor, x, y]`. */
function plainPos(p: unknown): p is { anchor: string; x: number; y: number } {
  return (
    isRec(p) &&
    Object.keys(p).length === 3 &&
    typeof p.anchor === 'string' &&
    typeof p.x === 'number' &&
    typeof p.y === 'number'
  );
}

/**
 * The video's packing (M17): short names, the section as `[start, end]`, the readout list as one
 * comma-separated string and placed readouts as `[anchor, x, y]`. A record with a field this
 * doesn't know stays as it is.
 */
function packVideo(video: Rec): Rec {
  if (!Object.keys(video).every((k) => Object.hasOwn(VIDEO_KEYS, k))) return video;
  const out: Rec = {};
  for (const [k, v] of Object.entries(video)) {
    let x: unknown = v;
    if (k === 'section' && isRec(v) && Object.keys(v).length === 2) x = [v.start, v.end];
    else if (
      k === 'hud' &&
      Array.isArray(v) &&
      v.every((h) => typeof h === 'string' && !h.includes(','))
    )
      x = v.join(',');
    else if (k === 'hudLayout' && isRec(v))
      x = boxesOf(v, (p) => (plainPos(p) ? [p.anchor, p.x, p.y] : p));
    out[VIDEO_KEYS[k]] = x;
  }
  return out;
}

function unpackVideo(video: Rec): Rec {
  if (!Object.keys(video).every((k) => Object.hasOwn(VIDEO_LONG, k))) return video;
  const out: Rec = {};
  for (const [s, v] of Object.entries(video)) {
    const k = VIDEO_LONG[s];
    let x: unknown = v;
    if (k === 'section' && Array.isArray(v) && v.length === 2) x = { start: v[0], end: v[1] };
    else if (k === 'hud' && typeof v === 'string') x = v === '' ? [] : v.split(',');
    else if (k === 'hudLayout' && isRec(v))
      x = boxesOf(v, (p) =>
        Array.isArray(p) && p.length === 3 ? { anchor: p[0], x: p[1], y: p[2] } : p,
      );
    out[k] = x;
  }
  return out;
}

/** The v2 form of a piece (JSON data), or null when it can't express this piece exactly. */
export function packPiece(piece: Piece): Rec | null {
  const out = stripDefaults(piece);
  if (isRec(out.timbres)) {
    const timbres: Rec = {};
    for (const [name, t] of Object.entries(out.timbres)) {
      const full = piece.timbres[name];
      const b = builtin(name);
      timbres[name] = b !== undefined && jsonEqual(full, b) ? 1 : t;
    }
    out.timbres = timbres;
  }
  if (Array.isArray(out.voices)) {
    out.voices = out.voices.map((v: unknown, i) => {
      if (!isRec(v) || v.id !== `v${i + 1}`) return v;
      const { id: _id, ...rest } = v;
      return rest;
    });
  }
  if (Array.isArray(out.moments)) {
    let prevId: unknown = null;
    let prevMs = 0;
    const moments: unknown[] = [];
    for (const raw of out.moments) {
      if (!isRec(raw)) return null;
      const ms = wholeMs(raw.at);
      if (ms === null) return null;
      const m: Rec = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'id' && typeof prevId === 'string' && v === nextId(prevId)) continue;
        if (k === 'at') m.at = ms - prevMs;
        else if (k === 'notes' && raw.type === 'tune' && Array.isArray(v) && v.every(plainNote))
          m.notes = v.flatMap((n) => ['pitch' in n ? n.pitch : null, n.len]);
        else if (
          k === 'chords' &&
          raw.type === 'progression' &&
          Array.isArray(v) &&
          v.every(plainChord)
        )
          m.chords = v.flatMap((c) => [c.notes, c.len]);
        else m[k] = v;
      }
      if (typeof raw.id !== 'string') return null;
      prevId = raw.id;
      prevMs = ms;
      moments.push(m);
    }
    out.moments = moments;
  }
  if (isRec(out.camera)) {
    const cam: Rec = { ...out.camera };
    if (Array.isArray(cam.keys) && cam.keys.every(plainKey))
      cam.keys = cam.keys.flatMap((k) => KEY_FIELDS.map((f) => k[f]));
    if (Array.isArray(cam.posterKeys) && cam.posterKeys.every(plainPosterKey))
      cam.posterKeys = cam.posterKeys.flatMap((k) => POSTER_KEY_FIELDS.map((f) => k[f]));
    out.camera = cam;
  }
  if (isRec(out.poster)) out.poster = packPoster(out.poster);
  if (isRec(out.video)) out.video = packVideo(out.video);
  return out;
}

/** The inverse of `packPiece`: JSON that `parsePiece` reads (defaults are filled there). */
export function unpackPiece(packed: unknown): unknown {
  if (!isRec(packed)) return packed;
  const out: Rec = { ...packed };
  if (isRec(out.timbres)) {
    const timbres: Rec = {};
    for (const [name, t] of Object.entries(out.timbres)) {
      timbres[name] =
        t === 1 && Object.hasOwn(BUILTIN_TIMBRES, name) ? cloneJson(BUILTIN_TIMBRES[name]) : t;
    }
    out.timbres = timbres;
  }
  if (Array.isArray(out.voices)) {
    out.voices = out.voices.map((v: unknown, i) =>
      isRec(v) && !('id' in v) ? { id: `v${i + 1}`, ...v } : v,
    );
  }
  if (Array.isArray(out.moments)) {
    let prevId: string | null = null;
    let prevMs = 0;
    out.moments = out.moments.map((raw: unknown) => {
      if (!isRec(raw)) return raw;
      const m: Rec = {};
      if (!('id' in raw) && prevId !== null) {
        const id = nextId(prevId);
        if (id !== null) m.id = id;
      }
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'at' && typeof v === 'number') {
          prevMs += v;
          m.at = prevMs / 1000;
        } else if (
          k === 'notes' &&
          raw.type === 'tune' &&
          Array.isArray(v) &&
          v.every((x, i) => typeof x === 'number' || (x === null && i % 2 === 0))
        ) {
          const notes: Rec[] = [];
          for (let i = 0; i + 1 < v.length; i += 2)
            notes.push(
              v[i] === null ? { rest: true, len: v[i + 1] } : { pitch: v[i], len: v[i + 1] },
            );
          m.notes = notes;
        } else if (
          k === 'chords' &&
          raw.type === 'progression' &&
          Array.isArray(v) &&
          v.length % 2 === 0 &&
          v.every((x, i) => typeof x === (i % 2 === 0 ? 'string' : 'number'))
        ) {
          const chords: Rec[] = [];
          for (let i = 0; i + 1 < v.length; i += 2) chords.push({ notes: v[i], len: v[i + 1] });
          m.chords = chords;
        } else m[k] = v;
      }
      if (typeof m.id === 'string') prevId = m.id;
      return m;
    });
  }
  if (isRec(out.camera)) {
    const cam: Rec = { ...out.camera };
    const keys = keysOf(cam.keys, KEY_FIELDS);
    if (keys) cam.keys = keys;
    const posterKeys = keysOf(cam.posterKeys, POSTER_KEY_FIELDS);
    if (posterKeys) cam.posterKeys = posterKeys;
    out.camera = cam;
  }
  if (isRec(out.poster)) out.poster = unpackPoster(out.poster);
  if (isRec(out.video)) out.video = unpackVideo(out.video);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Payloads and links
// ---------------------------------------------------------------------------------------------

/** The v1 payload, base64url(deflate-raw(JSON)), of any JSON value. */
export async function encodeSharePayload(value: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const packed = await pipe(json, new CompressionStream('deflate-raw'));
  return toBase64Url(packed);
}

/** The piece as links carry it: without its poster's background picture and save point. */
export function shareablePiece(full: Piece): Piece {
  const { posterSaved: _s, ...piece } = full;
  const poster = piece.poster;
  if (!poster?.picture) return _s === undefined ? full : piece;
  const { picture: _p, ...rest } = poster;
  if (Object.keys(rest).length > 0) return { ...piece, poster: rest };
  const { poster: _q, ...out } = piece;
  return out;
}

/** True when a link to the piece leaves out its poster's picture. */
export const linkDropsPicture = (piece: Piece): boolean => piece.poster?.picture !== undefined;

/**
 * The shortest exact payload for a piece (its poster picture left out): v2 when it packs, else
 * v1 of the stripped piece. A piece that is not canonical (not as `parsePiece` returns it) is
 * written as v1, unstripped.
 */
export async function encodePiecePayload(full: Piece): Promise<string> {
  const piece = shareablePiece(full);
  const read = (json: unknown): Piece | null => {
    const r = parsePiece(json);
    return r.ok ? r.piece : null;
  };
  // Belt and braces: each form is checked to read back as the piece, else the next is tried.
  const packed = packPiece(piece);
  if (packed !== null) {
    const text = JSON.stringify(packed);
    if (jsonEqual(read(unpackPiece(JSON.parse(text))), piece)) {
      return V2 + toBase64Url(await deflateV2(new TextEncoder().encode(text)));
    }
  }
  const stripped = stripDefaults(piece);
  return encodeSharePayload(jsonEqual(read(stripped), piece) ? stripped : piece);
}

/**
 * Decodes a payload (v1 or v2) to piece JSON for `parsePiece`. Throws an Error with a readable
 * message.
 */
export async function decodeSharePayload(payload: string): Promise<unknown> {
  const text = payload.trim();
  const v2 = text.startsWith(V2);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(v2 ? text.slice(V2.length) : text);
  } catch (e) {
    throw new Error(
      e instanceof Error && /base64url/.test(e.message)
        ? e.message
        : 'The link is damaged: it is not valid base64.',
      { cause: e },
    );
  }
  let json: Uint8Array;
  try {
    json = v2
      ? await inflateV2(bytes, MAX_DECODED_BYTES)
      : await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_DECODED_BYTES);
  } catch (e) {
    if (e instanceof Error && e.message === TOO_BIG) throw e;
    throw new Error('The link is damaged: it could not be decompressed.', { cause: e });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)) as unknown;
  } catch (e) {
    throw new Error('The link is damaged: its contents are not valid JSON.', { cause: e });
  }
  return v2 ? unpackPiece(value) : value;
}

/** The payload in a URL fragment (`#p=…`, with or without the `#`), or null when there is none. */
export function sharePayloadOf(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const p = params.get(SHARE_KEY);
  return p && p.length > 0 ? p : null;
}

/**
 * A share link for a piece: `base#p=<payload>`, defaults stripped. `base` defaults to the current
 * page without its fragment.
 */
export async function encodeShareLink(piece: Piece, base?: string): Promise<string> {
  const url = base ?? (typeof location === 'undefined' ? '' : location.href.split('#')[0]);
  return `${url}#${SHARE_KEY}=${await encodePiecePayload(piece)}`;
}

/** Decodes the piece JSON from a link or a bare fragment; null when it carries no `#p=`. */
export async function decodeShareLink(linkOrHash: string): Promise<unknown | null> {
  const hashAt = linkOrHash.indexOf('#');
  const payload = sharePayloadOf(hashAt >= 0 ? linkOrHash.slice(hashAt) : linkOrHash);
  return payload === null ? null : decodeSharePayload(payload);
}

/** The watch flag (M17): `#w&p=…`, `#w&kite-day`. */
export const WATCH_FLAG = 'w';

/** The fragment's `&`-separated parts, without the leading `#`. */
const partsOf = (hash: string): string[] =>
  (hash.startsWith('#') ? hash.slice(1) : hash).split('&').filter((s) => s !== '');

/** True when a fragment (or a link) carries the watch flag. */
export function isWatchHash(linkOrHash: string): boolean {
  const at = linkOrHash.indexOf('#');
  return partsOf(at >= 0 ? linkOrHash.slice(at) : linkOrHash).includes(WATCH_FLAG);
}

/** The watch link's frame key (`f=poster`, `f=row`). */
export const WATCH_FRAME_KEY = 'f';

/** The frame a watch link names (`&f=poster` / `&f=row`), or undefined (none, or unknown). */
export function watchFrameOf(linkOrHash: string): CameraFrame | undefined {
  const at = linkOrHash.indexOf('#');
  const parts = partsOf(at >= 0 ? linkOrHash.slice(at) : linkOrHash);
  if (!parts.includes(WATCH_FLAG)) return undefined;
  const f = parts.find((s) => s.startsWith(`${WATCH_FRAME_KEY}=`))?.slice(2);
  return f === 'poster' || f === 'row' ? f : undefined;
}

/** The fragment without the watch flag and frame (`#p=…`, `#kite-day`; '' when nothing is left). */
export function withoutWatch(hash: string): string {
  const rest = partsOf(hash).filter(
    (s) => s !== WATCH_FLAG && !s.startsWith(`${WATCH_FRAME_KEY}=`),
  );
  return rest.length > 0 ? `#${rest.join('&')}` : '';
}

/**
 * The watch link of a share link or fragment (`…#p=…` → `…#w&p=…`), with `frame` (default: the
 * one it names) last; idempotent.
 */
export function watchLinkOf(link: string, frame?: CameraFrame): string {
  const at = link.indexOf('#');
  const base = at >= 0 ? link.slice(0, at) : link;
  const f = frame ?? watchFrameOf(link);
  const rest = withoutWatch(at >= 0 ? link.slice(at) : '');
  return `${base}#${WATCH_FLAG}${rest === '' ? '' : `&${rest.slice(1)}`}${f ? `&${WATCH_FRAME_KEY}=${f}` : ''}`;
}

/**
 * The watch link for a piece: its share link with the watch flag (`base#w&p=<payload>`), or for
 * an unedited bundled example (`example`: its id) `base#w&<id>` (with `&f=<frame>` when given).
 */
export async function encodeWatchLink(
  piece: Piece,
  o: { base?: string; example?: string; frame?: CameraFrame } = {},
): Promise<string> {
  const url = o.base ?? (typeof location === 'undefined' ? '' : location.href.split('#')[0]);
  if (o.example !== undefined) return watchLinkOf(`${url}#${o.example}`, o.frame);
  return watchLinkOf(await encodeShareLink(piece, url));
}
