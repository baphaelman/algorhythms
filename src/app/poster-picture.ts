/**
 * Background pictures (PLAN.md §15 M14 "Backgrounds"): a picked image file becomes a
 * `PosterPicture` (a data URL, downscaled to fit the poster's size cap), and a stored one is
 * decoded once for canvas drawing (`setPictureImage`). `usePictures` counts decodes, so the
 * artboard redraws when one lands; exports await `picturesReady` first.
 */

import { create } from 'zustand';
import type { Piece, PosterPicture } from '../core/types';
import { pictureImage, setPictureImage } from '../render/background';
import { POSTER_MAX_AREA, POSTER_MAX_SIDE } from './export-options';

/** The scale (≤ 1) that fits w × h inside the poster's size cap. */
export function pictureScale(w: number, h: number): number {
  if (!(w > 0 && h > 0)) return 1;
  return Math.min(
    1,
    POSTER_MAX_SIDE / w,
    POSTER_MAX_SIDE / h,
    Math.sqrt(POSTER_MAX_AREA / (w * h)),
  );
}

/** Kept as the file's own bytes when no downscale is needed. */
const KEEP = new Set(['image/jpeg', 'image/png', 'image/webp']);

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the picture.'));
    r.readAsDataURL(blob);
  });
}

async function decode(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/**
 * A picture from an image file: its own bytes when it fits the cap (JPEG, PNG or WebP), else
 * downscaled and re-encoded (JPEG stays JPEG, anything else PNG). Throws a readable Error when
 * the file is not an image this browser decodes.
 */
export async function pictureFromFile(file: Blob): Promise<PosterPicture> {
  const url = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await decode(url);
  } catch (e) {
    throw new Error('That file is not a picture this browser can open.', { cause: e });
  } finally {
    URL.revokeObjectURL(url);
  }
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!(w0 > 0 && h0 > 0)) throw new Error('That picture has no pixels.');
  const k = pictureScale(w0, h0);
  let src: string;
  let w = w0;
  let h = h0;
  if (k === 1 && KEEP.has(file.type)) src = await readDataUrl(file);
  else {
    w = Math.max(1, Math.round(w0 * k));
    h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) throw new Error('This browser cannot resize the picture.');
    g.drawImage(img, 0, 0, w, h);
    src = file.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
  }
  const done = await decode(src);
  setPictureImage(src, done);
  bump();
  return { src, w, h };
}

/** Decodes counted, so a drawing waiting for one redraws. */
export const usePictures = create<{ decoded: number }>()(() => ({ decoded: 0 }));
const bump = (): void => usePictures.setState((s) => ({ decoded: s.decoded + 1 }));

const pending = new Map<string, Promise<void>>();

/** Decodes a stored picture for canvas drawing (once per URL). */
export function ensurePicture(src: string): Promise<void> {
  if (pictureImage(src)) return Promise.resolve();
  let p = pending.get(src);
  if (!p) {
    p = decode(src).then(
      (img) => {
        setPictureImage(src, img);
        bump();
      },
      () => undefined,
    );
    pending.set(src, p);
    void p.finally(() => pending.delete(src));
  }
  return p;
}

/** Resolves once the piece's poster picture (if any) is decoded. */
export function picturesReady(piece: Pick<Piece, 'poster'>): Promise<void> {
  const src = piece.poster?.picture?.src;
  return src ? ensurePicture(src) : Promise.resolve();
}
