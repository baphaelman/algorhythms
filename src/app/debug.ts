/**
 * A small window hook for end-to-end tests (tests/e2e/app*.spec.ts) and for the next builders'
 * experiments in the console. Read-mostly: it exposes the store, the engine and the frame timings.
 */

import type { AudioEngine } from '../audio/engine';
import { getAudioContext, getEngine } from './audio';
import { redo, select, undo, useEditor } from './editor/history';
import { frameStats } from './loop';
import { auditionState } from './audition';
import { previewState } from './preview';
import { encodeShareLink } from './share';
import { loadPiece, recompileNow, seekTo, setPiece, usePlayer } from './store';

export interface AlgoRhythmsDebug {
  /** The player store (`getState()`, `setState`, `subscribe`). */
  store: typeof usePlayer;
  /** The AudioEngine, once created. */
  engine(): AudioEngine | null;
  context(): AudioContext | null;
  /** Taps the engine's output with an analyser (created once). */
  analyser(): AnalyserNode | null;
  /** Frame timings; set `enabled` then read `work` / `interval` (ms). */
  frameStats: typeof frameStats;
  /** Store actions the editor and Generate builders will call (and tests exercise). */
  actions: {
    loadPiece: typeof loadPiece;
    setPiece: typeof setPiece;
    recompileNow: typeof recompileNow;
    /** Editor selection (moment ids). */
    select: typeof select;
    /** Moves the playhead (the editor layout has no scrubber). */
    seek: typeof seekTo;
  };
  /** `encodeShareLink`, for round-trip tests. */
  encodeShareLink: typeof encodeShareLink;
  /** Editor state and selection (M4b), for tests that can't use the lane. */
  editor: { state: typeof useEditor; select: typeof select; undo: typeof undo; redo: typeof redo };
  /** Palette hover and drag preview state (revision 6; silent since 2026-11-21). */
  preview: typeof previewState;
  /** Audition state (§11.3 auditioning). */
  audition: typeof auditionState;
}

declare global {
  interface Window {
    __algorhythms?: AlgoRhythmsDebug;
  }
}

let tap: AnalyserNode | null = null;

/** Installs `window.__algorhythms`. */
export function installDebug(): void {
  window.__algorhythms = {
    store: usePlayer,
    engine: getEngine,
    context: getAudioContext,
    analyser() {
      const e = getEngine();
      if (!e) return null;
      if (!tap || tap.context !== e.context) {
        tap = e.context.createAnalyser();
        tap.fftSize = 8192;
        e.node.connect(tap);
      }
      return tap;
    },
    frameStats,
    actions: { loadPiece, setPiece, recompileNow, select, seek: seekTo },
    encodeShareLink,
    editor: { state: useEditor, select, undo, redo },
    preview: previewState,
    audition: auditionState,
  };
}
