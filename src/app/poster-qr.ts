/**
 * The poster's QR code (PLAN.md §15 M17 "QR code"): the piece's watch link on the public site
 * (never the dev server's): `#w&<id>` for an unedited bundled example, else `#w&p=…`. Encoded by `qrcode-generator`, loaded only when a poster has a code.
 * Byte mode; error correction M when the code stays small enough, else L. Links over
 * `QR_MAX_CHARS` are not encoded (`tooLong`): the artboard says so and exports leave the code out.
 *
 * `qrInputOf(piece)` is synchronous for drawing: it returns what is known (the last code made
 * while a new one encodes) and starts the work; `useQrCodes` counts finished codes so the
 * artboard redraws. Exports `await qrReady(piece)` first.
 */

import { create } from 'zustand';
import { jsonEqual } from '../core/schema';
import type { Piece, PosterDoc } from '../core/types';
import { QR_MAX_CHARS, type QrInput, type QrMatrix } from '../render/poster-qr';
import { pieceVideoFrame } from '../render/poster-video';
import { encodeWatchLink } from './share';
import { loadInfo } from './store';
import { SITE_URL } from './youtube-description';

/** Error correction M up to this many modules across (version 22), else L: a smaller code. */
const M_MAX_MODULES = 105;

type Encoder = typeof import('qrcode-generator');
let encoder: Promise<Encoder> | null = null;

/** The encoder, loaded once on demand. */
function loadEncoder(): Promise<Encoder> {
  encoder ??= import('qrcode-generator').then((m) => (m.default ?? m) as Encoder);
  return encoder;
}

/**
 * `link` as QR modules: byte mode, the smallest version; level M unless that needs more than
 * `M_MAX_MODULES` across, then L.
 */
export async function encodeQr(link: string): Promise<QrMatrix & { level: 'M' | 'L' }> {
  const qrcode = await loadEncoder();
  const make = (level: 'M' | 'L') => {
    const q = qrcode(0, level);
    q.addData(link, 'Byte');
    q.make();
    return q;
  };
  let level: 'M' | 'L' = 'M';
  let q: ReturnType<Encoder> | null = null;
  try {
    q = make('M');
  } catch {
    // Too long for M at version 40.
  }
  if (!q || q.getModuleCount() > M_MAX_MODULES) {
    q = make('L');
    level = 'L';
  }
  const n = q.getModuleCount();
  let bits = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) bits += q.isDark(r, c) ? '1' : '0';
  return { n, bits, level };
}

/** The watch link a poster's code holds: on the public site. */
export const qrLinkOf = (piece: Piece): Promise<string> => {
  const example = exampleIdOf(piece);
  if (!example) return encodeWatchLink(piece, { base: SITE_URL });
  // The maker's frame, when the bare example's video would play another (a poster doc makes it
  // Over the poster).
  const frame = pieceVideoFrame(piece);
  const bare = loadInfo().exampleFrame ?? 'row';
  return encodeWatchLink(piece, { base: SITE_URL, example, ...(frame !== bare ? { frame } : {}) });
};

/** A poster doc without its QR code (undefined when nothing else is left). */
function docWithoutCode(doc: PosterDoc | undefined): PosterDoc | undefined {
  if (!doc) return undefined;
  const { qr: _q, ...rest } = doc;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The piece without its poster and poster save point. */
function withoutPoster(p: Piece): Piece {
  const { posterSaved: _s, poster: _p, ...rest } = p;
  return rest as Piece;
}

/**
 * The doc the workspace seeded (the viewer's poster settings) when the code was added to an
 * example without a doc, for the load it was made in: still unedited.
 */
let seed: { load: number; doc: PosterDoc } | null = null;

/** After adding a code: remember the seeded doc if the piece had none before (`before`). */
export function noteQrSeed(before: Piece, after: Piece): void {
  const doc = docWithoutCode(after.poster);
  seed = !before.poster && doc ? { load: loadInfo().count, doc } : seed;
}

/**
 * The id of the bundled example `piece` is, unedited apart from its QR code (and the poster
 * settings a first poster edit writes), else undefined: its watch link is then `#w&<id>`, a
 * small code.
 */
export function exampleIdOf(piece: Piece): string | undefined {
  const { example, examplePiece, count } = loadInfo();
  if (example === undefined || !examplePiece) return undefined;
  if (!jsonEqual(withoutPoster(piece), withoutPoster(examplePiece))) return undefined;
  const doc = docWithoutCode(piece.poster);
  const same =
    jsonEqual(doc, docWithoutCode(examplePiece.poster)) ||
    (seed !== null && seed.load === count && jsonEqual(doc, seed.doc));
  return same ? example : undefined;
}

/** Whether a watch link fits a code that scans easily. */
export const qrFits = (link: string): boolean => link.length <= QR_MAX_CHARS;

/** Finished codes counted, so a drawing waiting for one redraws. */
export const useQrCodes = create<{ made: number }>()(() => ({ made: 0 }));

const byPiece = new WeakMap<Piece, Promise<QrInput>>();
const done = new WeakMap<Piece, QrInput>();
/** Codes by link (the link of a piece is often unchanged by an edit). */
const byLink = new Map<string, QrMatrix>();
let last: QrInput | undefined;

/** The piece's code: its link, modules (or `tooLong`), made once per piece. */
export function qrReady(piece: Piece): Promise<QrInput> {
  let p = byPiece.get(piece);
  if (!p) {
    p = (async (): Promise<QrInput> => {
      const link = await qrLinkOf(piece);
      if (!qrFits(link)) return { link, tooLong: true };
      let matrix = byLink.get(link);
      if (!matrix) {
        const { n, bits } = await encodeQr(link);
        matrix = { n, bits };
        if (byLink.size > 32) byLink.clear();
        byLink.set(link, matrix);
      }
      return { link, matrix };
    })().then((q) => {
      done.set(piece, q);
      last = q;
      useQrCodes.setState((s) => ({ made: s.made + 1 }));
      return q;
    });
    byPiece.set(piece, p);
  }
  return p;
}

/** The newest piece waiting for its code, and whether one is being made: one at a time. */
let wanted: Piece | null = null;
let busy = false;

function pump(): void {
  if (busy || !wanted) return;
  const p = wanted;
  wanted = null;
  busy = true;
  void qrReady(p)
    .catch(() => undefined)
    .finally(() => {
      busy = false;
      pump();
    });
}

/**
 * What the layout draws now for the piece's code: its own when made, else (while it encodes)
 * the last one made, so the artboard doesn't flicker on each edit (undefined before any). A
 * drag makes a piece per frame: only the newest waiting one is encoded next.
 */
export function qrInputOf(piece: Piece): QrInput | undefined {
  const own = done.get(piece);
  if (own) return own;
  if (!byPiece.has(piece)) {
    wanted = piece;
    pump();
  }
  return last;
}

/** The watch link's length for a piece without a code (the toolbar's QR button). */
export async function qrLinkLength(piece: Piece): Promise<number> {
  const withCode: Piece = { ...piece, poster: { ...piece.poster, qr: piece.poster?.qr ?? {} } };
  return (await qrLinkOf(withCode)).length;
}
