/**
 * Context-aware palette (PLAN.md §11.3, revision 6): which moment types would change anything at
 * the playhead, and why not. The palette greys out a type with no effect there; its click and its
 * shortcut are disabled (dragging it elsewhere still works).
 *
 * `watchPaletteEffects` keeps `usePaletteEffects` current: a 200 ms poll recomputes when the
 * playhead time or the score changed. During playback it recomputes at most once a
 * second, at idle, so it costs no frame time.
 */

import { create } from 'zustand';
import { momentEffectAt, momentEffectsAt, type MomentEffect } from '../../core/effect';
import type { CompiledScore, MomentType, Piece, Seconds } from '../../core/types';
import { usePlayer } from '../store';
import { addTimeIn, defaultMoment } from './new-moment';
import { playheadTime } from './shortcuts';

/** Id of the throwaway moments built for effect checks and previews. */
export const PROBE_ID = '__probe';

export type PaletteEffects = Record<MomentType, MomentEffect>;

/**
 * The time whose state an add at `t` acts on: `t`, or just before the end when `t` is at or past
 * it (open-ended canvas: adding there extends the piece, and the voices hold until then).
 */
export function effectTime(score: CompiledScore, t: Seconds): Seconds {
  const last = Math.max(0, Math.round((score.duration - 0.01) * 1000) / 1000);
  return t > last ? last : t;
}

/**
 * Palette types core's `momentEffectsAt` leaves out (its EFFECT_MOMENT_TYPES predates them); the
 * app checks them one by one with `momentEffectAt` (R9-7, M6).
 */
const EXTRA_TYPES: readonly MomentType[] = ['pulse', 'tune', 'progression', 'timbre'];

/** Per type: would a default moment of that type at `t` have an effect? */
export function paletteEffects(piece: Piece, score: CompiledScore, t: Seconds): PaletteEffects {
  const at = effectTime(score, t);
  const out = momentEffectsAt(piece, score, at, (type, x) =>
    defaultMoment(type, x, PROBE_ID, piece, score),
  );
  for (const type of EXTRA_TYPES) {
    if (out[type]) continue;
    out[type] = momentEffectAt(piece, score, defaultMoment(type, at, PROBE_ID, piece, score));
  }
  return out;
}

/**
 * Where a palette click or shortcut adds a moment now: exactly the playhead (revision 7), or 0:00
 * for the first moment (`addTimeIn`).
 */
export function addTime(): Seconds {
  return addTimeIn(usePlayer.getState().piece, playheadTime());
}

/**
 * The effect of adding `type` at `at` (default: the playhead) now, computed fresh for clicks and
 * keys.
 */
export function playheadEffect(type: MomentType, at: Seconds = playheadTime()): MomentEffect {
  const { piece, compiled } = usePlayer.getState();
  const t = effectTime(compiled, addTimeIn(piece, at));
  return momentEffectAt(piece, compiled, defaultMoment(type, t, PROBE_ID, piece, compiled));
}

interface PaletteEffectsState {
  /** The time the effects were computed for (NaN before the first run). */
  t: Seconds;
  effects: PaletteEffects | null;
}

/** The palette's effects at the playhead, kept current by `watchPaletteEffects`. */
export const usePaletteEffects = create<PaletteEffectsState>()(() => ({ t: NaN, effects: null }));

let last: { t: Seconds; score: CompiledScore | null } = { t: NaN, score: null };

/** Recomputes the effects if the playhead or the score changed (or `force`). */
export function refreshPaletteEffects(force = false): void {
  const { piece, compiled } = usePlayer.getState();
  const t = addTime();
  if (!force && t === last.t && compiled === last.score) return;
  last = { t, score: compiled };
  let effects: PaletteEffects | null;
  try {
    effects = paletteEffects(piece, compiled, t);
  } catch {
    effects = null; // never block the palette on a check
  }
  usePaletteEffects.setState({ t, effects });
}

const POLL_MS = 200;
const PLAYING_MS = 1000;

function onIdle(fn: () => void): void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 500 });
  else setTimeout(fn, 0);
}

/** Starts keeping `usePaletteEffects` current; returns a stop function. */
export function watchPaletteEffects(): () => void {
  let lastPlaying = 0;
  let idlePending = false;
  refreshPaletteEffects(true);
  const timer = setInterval(() => {
    if (document.hidden) return;
    if (usePlayer.getState().transport.status !== 'playing') {
      refreshPaletteEffects();
      return;
    }
    const now = performance.now();
    if (idlePending || now - lastPlaying < PLAYING_MS) return;
    lastPlaying = now;
    idlePending = true;
    onIdle(() => {
      idlePending = false;
      refreshPaletteEffects();
    });
  }, POLL_MS);
  return () => clearInterval(timer);
}
