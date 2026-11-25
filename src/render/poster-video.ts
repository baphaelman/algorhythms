/**
 * Play the poster (PLAN.md §15 M15): the video as a window over the poster's layout.
 *
 * - **Frames.** `pieceVideoFrame`: Over the poster (`poster`) when the piece has a poster, else
 *   One row (`row`, today's video). A frame on the poster is a `Rect` in artboard px whose
 *   aspect is the video's.
 * - **Camera** (`posterCameraAt`, pure in t): Follow keeps the playhead's slice (`posterTimeAt`)
 *   in frame row by row, with the row-break transition between rows; Whole fits the poster;
 *   Keys ease between frames stored in poster space (`PosterCameraKey`).
 */

import type {
  CameraFrame,
  EaseRef,
  Piece,
  PosterCameraKey,
  RowBreak,
  Seconds,
} from '../core/types';
import type { PosterLayout, Rect } from './poster-layout';
import { VIDEO_RATIO, type VideoAspect, type VideoCameraMode } from './video';

/** The frame a piece's video shows (absent: Over the poster when it has a poster, else One row). */
export function pieceVideoFrame(piece: Pick<Piece, 'camera' | 'poster'>): CameraFrame {
  const f = piece.camera?.frame;
  if (f === 'poster' || f === 'row') return f;
  return piece.poster ? 'poster' : 'row';
}

/** A piece's row-break transition (absent: a pan). */
export function pieceRowBreak(piece: Pick<Piece, 'camera'>): RowBreak {
  const b = piece.camera?.rowBreak;
  return b === 'scroll' || b === 'cut' ? b : 'pan';
}

export interface PosterCameraOptions {
  aspect: VideoAspect;
  /** `auto` plays as `follow`; `keys` without keys as `follow`. */
  mode: VideoCameraMode;
  /** Follow: seconds shown, as seen at 16:9 (`videoWindow`); absent = one row's height. */
  window?: Seconds;
  /** Follow: the playhead's place across the frame, 0..1. @default 0.35 */
  followAt?: number;
  /** @default 'pan' */
  rowBreak?: RowBreak;
  /** `keys`: the frames in poster space, sorted by `at`. */
  keys?: readonly PosterCameraKey[];
}

/** The frame at `aspect` (width / height) that fits the whole artboard, centred. */
export function posterWholeFrame(layout: PosterLayout, aspect: VideoAspect): Rect {
  const r = VIDEO_RATIO[aspect];
  const { width: W, height: H } = layout;
  if (W / H > r) {
    const h = W / r;
    return { x: 0, y: (H - h) / 2, w: W, h };
  }
  const w = H * r;
  return { x: (W - w) / 2, y: 0, w, h: H };
}

/** The frame on the poster (artboard px) the video shows at time t. */
export function posterCameraAt(layout: PosterLayout, _t: Seconds, opts: PosterCameraOptions): Rect {
  return posterWholeFrame(layout, opts.aspect);
}

/** The frame a key holds at `aspect` (artboard px). */
export function posterKeyFrame(
  layout: PosterLayout,
  key: Pick<PosterCameraKey, 'x' | 'y' | 'h'>,
  aspect: VideoAspect,
): Rect {
  const h = key.h * layout.height;
  const w = h * VIDEO_RATIO[aspect];
  return { x: key.x * layout.width - w / 2, y: key.y * layout.height - h / 2, w, h };
}

/** A key from a frame on the poster (artboard px) at time t: its centre and height. */
export function posterKeyOfFrame(
  layout: PosterLayout,
  frame: Rect,
  t: Seconds,
  easeRef?: EaseRef,
): PosterCameraKey {
  const k: PosterCameraKey = {
    at: t,
    x: (frame.x + frame.w / 2) / layout.width,
    y: (frame.y + frame.h / 2) / layout.height,
    h: frame.h / layout.height,
  };
  if (easeRef !== undefined) k.ease = easeRef;
  return k;
}
