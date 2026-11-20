/**
 * Palette hover preview (PLAN.md §11.3, revision 6): plays about 3 s from the playhead with a
 * default moment of the hovered type inserted, then restores the real score.
 *
 * The preview compiles a temporary piece and hot-swaps it into the engine, plays it, and on stop
 * pauses (the engine's 5 ms pause crossfade, so no click) and swaps the real score back while
 * paused. The store, the undo history and the saved piece are never touched. Only while the
 * transport is not playing; any transport or piece change stops it first.
 */

import { compile } from '../core/compiler/compile';
import type { MomentType, Seconds } from '../core/types';
import { getEngine, primeAudio, resumeAudio, swapAudio } from './audio';
import { insertMoments } from './editor/ops';
import { defaultMoment } from './editor/new-moment';
import { PROBE_ID, addTime } from './editor/palette-effects';
import { usePlayer } from './store';

/** Preview length, seconds. */
export const PREVIEW_SECONDS = 3;
/** Hover time before a preview starts, ms. */
export const PREVIEW_DELAY_MS = 300;

/** What the preview is doing (read by tests through the debug hook). */
export const previewState = {
  /** The type being previewed, or null. */
  type: null as MomentType | null,
  /** The engine was told to play the preview. */
  playing: false,
  /** Previews started so far. */
  count: 0,
  /** Where the latest preview starts, seconds. */
  from: NaN as Seconds,
};

let token = 0;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

/** Starts a preview of `type` at the playhead; false if the transport is busy. */
export function startPreview(type: MomentType): boolean {
  stopPreview();
  const { piece, compiled, transport } = usePlayer.getState();
  if (transport.status === 'playing' || transport.scrubbing || transport.audio !== 'ready') {
    return false;
  }
  const t = addTime();
  let score;
  try {
    const m = defaultMoment(type, t, PROBE_ID, piece, compiled);
    score = compile(insertMoments(piece, [m]));
  } catch {
    return false;
  }
  const my = ++token;
  previewState.type = type;
  previewState.playing = false;
  previewState.count++;
  previewState.from = t;
  void primeAudio().catch(() => undefined);
  resumeAudio();
  swapAudio(score, piece.timbres).then(
    (e) => {
      if (my !== token) return;
      e.play(t);
      previewState.playing = true;
      stopTimer = setTimeout(stopPreview, PREVIEW_SECONDS * 1000);
    },
    () => {
      if (my === token) stopPreview();
    },
  );
  return true;
}

/** Stops the preview (if any) and puts the real score back into the engine. */
export function stopPreview(): void {
  if (previewState.type === null) return;
  token++;
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = null;
  if (previewState.playing) getEngine()?.pause();
  previewState.type = null;
  previewState.playing = false;
  const { piece, compiled } = usePlayer.getState();
  void swapAudio(compiled, piece.timbres).catch(() => undefined);
}

// Play, seek-to-play, scrubbing, loads and edits all go back to the real score first. The restore
// swap is queued before play's own wait on the engine, so play never starts on the preview.
usePlayer.subscribe((s, prev) => {
  if (previewState.type === null) return;
  if (
    s.piece !== prev.piece ||
    s.compiled !== prev.compiled ||
    s.transport.status !== prev.transport.status ||
    s.transport.scrubbing !== prev.transport.scrubbing
  ) {
    stopPreview();
  }
});
