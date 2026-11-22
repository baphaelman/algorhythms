/**
 * A small window hook for end-to-end tests (tests/e2e/app*.spec.ts) and for the next builders'
 * experiments in the console. Read-mostly: it exposes the store, the engine and the frame timings.
 */

import type { AudioEngine } from '../audio/engine';
import type { LiveEngine } from '../audio/live-engine';
import { getAudioContext, getEngine } from './audio';
import { redo, select, undo, useEditor } from './editor/history';
import { enterLive, exitLive, live } from './live';
import { connectMidi, disconnectMidi, liveInputs, midiSink, useLive } from './live-ui';
import { frameStats } from './loop';
import { auditionState } from './audition';
import { composeView } from './compose-view';
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
  /** Compose for me's pen and phase (M4.5-38). */
  compose: typeof composeView;
  /** Live mode (M7): enter/exit, the LiveEngine (noteOn, …), and an analyser on its output. */
  live: {
    enter: typeof enterLive;
    exit: typeof exitLive;
    engine(): LiveEngine;
    analyser(): AnalyserNode | null;
    /** The Live drawer, typing and panel state (M7-b). */
    ui: typeof useLive;
    /** The live inputs' hub (held pitches by source). */
    inputs: typeof liveInputs;
    /** Web MIDI: connect with a fake MIDIAccess, the sink, disconnect. */
    midi: { connect: typeof connectMidi; sink: typeof midiSink; disconnect: typeof disconnectMidi };
  };
}

declare global {
  interface Window {
    __algorhythms?: AlgoRhythmsDebug;
  }
}

let tap: AnalyserNode | null = null;
let liveTap: AnalyserNode | null = null;

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
    compose: composeView,
    live: {
      enter: enterLive,
      exit: exitLive,
      engine: () => live,
      analyser() {
        const e = live.engine;
        if (!e) return null;
        if (!liveTap || liveTap.context !== e.context) {
          liveTap = e.context.createAnalyser();
          liveTap.fftSize = 2048;
          e.node.connect(liveTap);
        }
        return liveTap;
      },
      ui: useLive,
      inputs: liveInputs,
      midi: { connect: connectMidi, sink: midiSink, disconnect: disconnectMidi },
    },
  };
}
