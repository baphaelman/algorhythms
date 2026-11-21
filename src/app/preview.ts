/**
 * Score previews (PLAN.md §11.3; owner 2026-11-21: silent): hovering a palette item or a next-move
 * suggestion, or dragging a palette item over the score or lane, shows what the moment would do
 * as ghost lines on the score from its time. Nothing sounds.
 *
 * A preview compiles a temporary piece with the moment inserted; the score loop (./loop.ts) draws
 * its lines from `from` on top of the real score. The store, the undo history, the saved piece and
 * the engine are never touched. Any piece change clears it (it would be stale).
 */

import { compile } from '../core/compiler/compile';
import type { CompiledScore, Moment, MomentType, Piece, Seconds } from '../core/types';
import { extendEnd } from './editor/end';
import { insertMoments } from './editor/ops';
import { defaultMoment } from './editor/new-moment';
import { PROBE_ID, addTime } from './editor/palette-effects';
import { usePlayer } from './store';

/** Hover time before a preview starts, ms. */
export const PREVIEW_DELAY_MS = 300;

/** The previewed score and where its ghost lines start. */
export interface PreviewGhost {
  score: CompiledScore;
  from: Seconds;
}

/** What the preview is doing (read by the score loop, and by tests through the debug hook). */
export const previewState = {
  /** The type being previewed, or null. */
  type: null as MomentType | null,
  /** The ghost the score draws (a new object per preview), or null. */
  ghost: null as PreviewGhost | null,
  /** Previews started so far. */
  count: 0,
  /** Where the latest preview starts, seconds. */
  from: NaN as Seconds,
  /** The suggestion label being previewed (next-move suggestions), or null. */
  label: null as string | null,
  /** The preview comes from a palette drag. */
  drag: false,
};

/** Previews a default `type` at `t` (default: the playhead); false if it cannot be built. */
export function startPreview(type: MomentType, t: Seconds = addTime(), drag = false): boolean {
  const { piece, compiled } = usePlayer.getState();
  let m: Moment;
  try {
    m = defaultMoment(type, Math.max(0, t), PROBE_ID, piece, compiled);
  } catch {
    return false;
  }
  return startMomentPreview(m, null, undefined, drag);
}

/**
 * Previews `moment` (a next-move suggestion, `label`) from its time; false if it does not compile.
 * `build` makes the temporary piece (default: the moment inserted).
 */
export function startMomentPreview(
  moment: Moment,
  label: string | null,
  build: (piece: Piece, m: Moment) => Piece = (p, m) => extendEnd(insertMoments(p, [m]), [m]),
  drag = false,
): boolean {
  const { piece } = usePlayer.getState();
  let score: CompiledScore;
  try {
    score = compile(build(piece, { ...moment, id: PROBE_ID }));
  } catch {
    stopPreview();
    return false;
  }
  previewState.type = moment.type;
  previewState.label = label;
  previewState.count++;
  previewState.from = moment.at;
  previewState.drag = drag;
  previewState.ghost = { score, from: moment.at };
  return true;
}

/** Clears the preview (if any). */
export function stopPreview(): void {
  if (previewState.type === null) return;
  previewState.type = null;
  previewState.label = null;
  previewState.ghost = null;
  previewState.drag = false;
}

usePlayer.subscribe((s, prev) => {
  if (previewState.type !== null && (s.piece !== prev.piece || s.compiled !== prev.compiled)) {
    stopPreview();
  }
});
