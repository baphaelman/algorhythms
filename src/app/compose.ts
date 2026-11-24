/**
 * Compose for me (PLAN.md §11.3 "Compose in New piece", "Compose builds in play order", "Compose
 * for me, directed"; M4.5-28, M4.5-38, M12): New opens the setup screen (./compose-setup.ts) over
 * the open piece; Compose opens an empty piece and a side panel, and the composer builds the piece
 * on screen, step by step (`composeDirected`), at the pace of ./compose-pace.ts. The structure
 * comes in play order: the camera follows the pen forward and the lines draw in up to it
 * (`composeView`). Then the whole piece is fitted in view and the detail sweep highlights each
 * detail as it is placed, left to right.
 *
 * The whole compose is one undo entry back to the empty piece: the build runs as one editor
 * gesture, closed when it finishes (or Skip, Stop). "Compose again" reopens the setup with the
 * last answers and a new seed; its build first undoes the last build's entry when it is still the
 * newest, so it stays one entry. The user's own edit (any history change not made here: an edit,
 * undo, drag) stops a build and closes the panel; so does loading another piece.
 *
 * Playback is not driven: the transport stays where it is, and playing while it builds plays the
 * piece as it grows (each step is hot-swapped like any edit); the camera then follows the playhead.
 */

import { create } from 'zustand';
import { composedPiece, type Composition } from '../core/generate';
import type { Piece } from '../core/types';
import type { ComposeBrief } from '../core/compose-brief';
import { composeDirected } from '../core/compose-directed';
import { composeTimeline, penAt, stepsAt, type Timeline } from './compose-pace';
import {
  buildBrief,
  loadAnswers,
  melodyOf,
  saveAnswers,
  type ComposeAnswers,
  type MelodyNote,
} from './compose-setup';
import { composeView } from './compose-view';
import {
  beginGesture,
  currentGesture,
  clearEdited,
  endGesture,
  lastEntry,
  undo,
  updateGesture,
  useEditor,
} from './editor/history';
import { newSeed } from './generate-options';
import { loadNewPiece } from './persist';
import { camera, cameraOf, fitWindow, onLoadPiece, runOpen, usePlayer } from './store';

/** `building`: steps are being placed; `done`: the whole piece; `stopped`: part of it. */
export type ComposeStatus = 'building' | 'done' | 'stopped';

export interface ComposeUi {
  /** The side panel (the build show). */
  open: boolean;
  /** The setup screen. */
  setup: boolean;
  /** The setup's answers (remembered per browser) and the next build's seed. */
  answers: ComposeAnswers;
  seed: number;
  /** Whether "The open piece's melody" can be offered. */
  hasMelody: boolean;
  /** The brief of the last build. */
  brief: ComposeBrief | null;
  status: ComposeStatus;
  /** Steps placed so far, and the total. */
  step: number;
  total: number;
  /** What the composer is doing: "Placing: Drift", "Adding details". */
  activity: string;
}

/** The panel's and setup's state; the answers outlive both. */
export const useCompose = create<ComposeUi>()(() => ({
  open: false,
  setup: false,
  answers: loadAnswers(),
  seed: 0,
  hasMelody: false,
  brief: null,
  status: 'done',
  step: 0,
  total: 0,
  activity: '',
}));

const run = {
  comp: null as Composition<string> | null,
  timeline: null as Timeline | null,
  /** `performance.now()` when the build began. */
  t0: 0,
  raf: 0,
  /** Steps shown. */
  applied: 0,
  /** The editor gesture the build runs in. */
  gesture: null as object | null,
  /** The undo entry the last finished or stopped build made, and the piece it left. */
  entry: null as object | null,
  result: null as Piece | null,
  /** True while Compose itself loads the empty piece. */
  loading: false,
  /** True while Compose itself changes the history (not the user's edit). */
  self: false,
  /** The melody of the piece open when New → Compose for me was chosen. */
  melody: null as MelodyNote[] | null,
};

/** Runs `f` as Compose's own history change. */
function ours(f: () => void): void {
  const was = run.self;
  run.self = true;
  try {
    f();
  } finally {
    run.self = was;
  }
}

function cancelFrame(): void {
  if (run.raf) cancelAnimationFrame(run.raf);
  run.raf = 0;
}

function clearView(): void {
  composeView.reveal = undefined;
  composeView.flash = null;
  composeView.pen = NaN;
  composeView.detail = false;
}

/** Shows the first `k` steps. False (and the build stops) if its gesture was taken over. */
function show(k: number): boolean {
  const comp = run.comp;
  if (!comp || run.gesture === null || currentGesture() !== run.gesture) {
    interrupted();
    return false;
  }
  run.applied = k;
  const piece = composedPiece(comp, k);
  ours(() => updateGesture(() => piece));
  const step = comp.steps[k - 1];
  composeView.flash = step?.phase === 'detail' ? step.moment.id : null;
  useCompose.setState({
    step: k,
    activity: !step
      ? 'Starting'
      : step.kind === 'add' && step.phase === 'structure'
        ? `Placing: ${step.section}`
        : 'Adding details',
  });
  return true;
}

/**
 * The build lost its gesture (the user's edit, undo or drag): it stops where it is, and the panel
 * closes, since the user is composing by hand now.
 */
function interrupted(): void {
  cancelFrame();
  clearView();
  run.gesture = null;
  run.entry = run.result = null;
  useCompose.setState({ status: 'stopped', open: false });
}

/** Ends the build: one undo entry for it, the lines all drawn. */
function settle(status: ComposeStatus): void {
  cancelFrame();
  clearView();
  if (run.gesture !== null && currentGesture() === run.gesture) {
    ours(endGesture);
    clearEdited();
    run.entry = lastEntry();
    run.result = usePlayer.getState().piece;
  }
  run.gesture = null;
  useCompose.setState({ status });
}

/** Moves the camera toward `target` (left-edge time); snaps under reduced motion. */
function steer(target: number): void {
  if (usePlayer.getState().transport.status === 'playing') return;
  const to = Math.max(0, target);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  camera.start = reduced ? to : camera.start + (to - camera.start) * 0.12;
}

function frame(now: number): void {
  run.raf = 0;
  const comp = run.comp;
  const tl = run.timeline;
  if (!comp || !tl) return;
  if (currentGesture() !== run.gesture) {
    interrupted();
    return;
  }
  const ms = now - run.t0;
  if (ms >= tl.total) {
    finish();
    return;
  }
  const k = stepsAt(tl, ms);
  if (k !== run.applied && !show(k)) return;
  const beat = tl.beats[k - 1];
  if (beat?.detail) {
    // The detail sweep: every line drawn, the whole piece in view (the camera holds still).
    if (!composeView.detail) {
      composeView.detail = true;
      composeView.reveal = undefined;
      if (usePlayer.getState().transport.status !== 'playing') fitWindow();
    }
    composeView.pen = beat.penFrom;
  } else {
    // The structure: the camera follows the pen forward.
    const pen = penAt(tl, ms);
    composeView.reveal = composeView.pen = pen;
    steer(pen - cameraOf().window * 0.65);
  }
  run.raf = requestAnimationFrame(frame);
}

/**
 * (Re)starts the build from `brief`. Mid-build it just starts over (same gesture); after a
 * finished or stopped build whose entry is still the newest and untouched, that entry is undone
 * first, so the compose stays one undo entry.
 */
function restartCompose(brief: ComposeBrief): void {
  cancelFrame();
  run.comp = composeDirected(brief);
  run.timeline = composeTimeline(run.comp);
  if (run.gesture === null || currentGesture() !== run.gesture) {
    ours(() => {
      if (
        run.entry !== null &&
        lastEntry() === run.entry &&
        usePlayer.getState().piece === run.result
      )
        undo();
      run.entry = run.result = null;
      beginGesture('Compose');
    });
    run.gesture = currentGesture();
  }
  clearView();
  useCompose.setState({ brief, status: 'building', total: run.comp.steps.length });
  run.t0 = performance.now();
  camera.start = 0;
  if (!show(0)) return;
  composeView.reveal = composeView.pen = 0;
  run.raf = requestAnimationFrame(frame);
}

/** Skip: the finished piece, all of it in view. */
export function finish(): void {
  if (!run.comp || useCompose.getState().status !== 'building') return;
  if (!show(run.comp.steps.length)) return;
  settle('done');
  fitWindow();
}

/** Stop: keeps what has been built so far (an ordinary piece with an automatic end). */
export function stopCompose(): void {
  if (useCompose.getState().status !== 'building') return;
  settle('stopped');
}

/** New → Compose for me: the setup screen over the open piece, with a fresh seed. */
export function openCompose(): void {
  run.melody = melodyOf(usePlayer.getState().piece);
  useCompose.setState({ setup: true, seed: newSeed(), hasMelody: run.melody !== null });
}

/** "Compose again" (after a finish or Stop): the setup with the last answers and a new seed. */
export function composeAgain(): void {
  if (useCompose.getState().status === 'building') return;
  useCompose.setState({ setup: true, seed: newSeed() });
}

/** Closes the setup screen without composing. */
export function closeSetup(): void {
  useCompose.setState({ setup: false });
}

/** Changes the setup's answers (remembered per browser). */
export function setComposeAnswers(patch: Partial<ComposeAnswers>): void {
  useCompose.setState((s) => ({ answers: { ...s.answers, ...patch } }));
  saveAnswers(useCompose.getState().answers);
}

/**
 * The setup's Compose: builds the brief, then starts the build show. From New it opens an empty
 * piece first; from "Compose again" it rebuilds in the open session.
 */
export function runCompose(): void {
  const { answers, seed, open } = useCompose.getState();
  const brief = buildBrief(answers, seed, run.melody);
  useCompose.setState({ setup: false });
  if (open) restartCompose(brief);
  else runOpen(() => startCompose(brief));
}

function startCompose(brief: ComposeBrief): void {
  cancelFrame();
  clearView();
  run.gesture = run.entry = run.result = null;
  run.loading = true;
  try {
    ours(loadNewPiece);
  } finally {
    run.loading = false;
  }
  useCompose.setState({ open: true });
  restartCompose(brief);
}

/** Closes the panel (a build in progress stops where it is). */
export function closeCompose(): void {
  stopCompose();
  useCompose.setState({ open: false, setup: false });
}

// The user's own history change after a build (an edit, undo or redo) closes the panel.
useEditor.subscribe(() => {
  const { open, status } = useCompose.getState();
  if (run.self || run.loading || !open || status === 'building') return;
  if (lastEntry() !== run.entry) closeCompose();
});

// Opening another piece ends the compose session (and closes the setup).
onLoadPiece(() => {
  if (run.loading) return;
  const { open, setup } = useCompose.getState();
  if (setup) useCompose.setState({ setup: false });
  if (!open) return;
  cancelFrame();
  clearView();
  run.gesture = run.entry = run.result = null;
  useCompose.setState({ open: false, status: 'stopped' });
});
