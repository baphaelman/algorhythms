/**
 * Compose for me (PLAN.md §11.3 "Compose in New piece", M4.5-28): New opens an empty piece and a
 * side panel with Generate's inputs, and the composer builds the piece on screen, step by step
 * (`composeSteps`), at the pace of ./compose-pace.ts. The camera follows the pen and the lines draw
 * in up to it (`composeView`); an adjustment pass highlights the moment it edits.
 *
 * The whole compose is one undo entry back to the empty piece: the build runs as one editor
 * gesture, closed when it finishes (or Skip, Stop). Changing an input restarts the build; after it
 * finished, the restart first undoes that entry when it is still the newest, so it stays one entry.
 * An edit, undo, drag or load from outside while it builds stops the build where it is.
 *
 * Playback is not driven: the transport stays where it is, and playing while it builds plays the
 * piece as it grows (each step is hot-swapped like any edit); the camera then follows the playhead.
 */

import { create } from 'zustand';
import { composeSteps, composedPiece, type Composition } from '../core/generate';
import type { Piece } from '../core/types';
import { composeTimeline, penAt, stepsAt, type Timeline } from './compose-pace';
import { composeView } from './compose-view';
import {
  beginGesture,
  currentGesture,
  endGesture,
  lastEntry,
  undo,
  updateGesture,
} from './editor/history';
import {
  DEFAULT_FORM,
  checkForm,
  newSeed,
  type FieldErrors,
  type GenerateForm,
} from './generate-options';
import { newPieceNow } from './persist';
import { camera, cameraOf, fitWindow, onLoadPiece, usePlayer } from './store';

/** `building`: steps are being placed; `done`: the whole piece; `stopped`: part of it. */
export type ComposeStatus = 'building' | 'done' | 'stopped';

export interface ComposeUi {
  open: boolean;
  form: GenerateForm;
  errors: FieldErrors;
  status: ComposeStatus;
  /** Steps placed so far, and the total. */
  step: number;
  total: number;
  /** What the composer is doing: "Placing: Drift", "Adjusting: register". */
  activity: string;
}

/** The panel's state; the form outlives the panel (reopening keeps the choices, with a new seed). */
export const useCompose = create<ComposeUi>()(() => ({
  open: false,
  form: { ...DEFAULT_FORM, seed: '0' },
  errors: {},
  status: 'done',
  step: 0,
  total: 0,
  activity: '',
}));

const run = {
  comp: null as Composition | null,
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
};

const PASS_NAMES = { register: 'register', fit: 'fit to length' } as const;

function cancelFrame(): void {
  if (run.raf) cancelAnimationFrame(run.raf);
  run.raf = 0;
}

function clearView(): void {
  composeView.reveal = undefined;
  composeView.flash = null;
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
  updateGesture(() => piece);
  const step = comp.steps[k - 1];
  composeView.flash = step?.kind === 'edit' ? step.moment.id : null;
  useCompose.setState({
    step: k,
    activity: !step
      ? 'Starting'
      : step.kind === 'add'
        ? `Placing: ${step.section}`
        : `Adjusting: ${PASS_NAMES[step.pass]}`,
  });
  return true;
}

/** The build lost its gesture (an edit, undo or drag from outside): it stops where it is. */
function interrupted(): void {
  cancelFrame();
  clearView();
  run.gesture = null;
  run.entry = run.result = null;
  useCompose.setState({ status: 'stopped' });
}

/** Ends the build: one undo entry for it, the lines all drawn. */
function settle(status: ComposeStatus): void {
  cancelFrame();
  clearView();
  if (run.gesture !== null && currentGesture() === run.gesture) {
    endGesture();
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
  const pen = penAt(tl, ms);
  composeView.reveal = pen;
  const { window: win } = cameraOf();
  const step = comp.steps[k - 1];
  // Follow the pen; during a pass, the moment being edited.
  steer(step?.kind === 'edit' ? step.moment.at - win * 0.4 : pen - win * 0.65);
  run.raf = requestAnimationFrame(frame);
}

/**
 * (Re)starts the build from the panel's inputs. Mid-build it just starts over (same gesture);
 * after a finished build whose entry is still the newest and untouched, that entry is undone
 * first, so the compose stays one undo entry. Invalid inputs stop it and show the errors.
 */
export function restartCompose(): void {
  const { form } = useCompose.getState();
  const check = checkForm(form, new Date().toISOString());
  if (!check.ok) {
    if (useCompose.getState().status === 'building') stopCompose();
    useCompose.setState({ errors: check.errors });
    return;
  }
  cancelFrame();
  run.comp = composeSteps(check.request.seed, check.request.options);
  run.timeline = composeTimeline(run.comp);
  if (run.gesture === null || currentGesture() !== run.gesture) {
    if (
      run.entry !== null &&
      lastEntry() === run.entry &&
      usePlayer.getState().piece === run.result
    )
      undo();
    run.entry = run.result = null;
    beginGesture('Compose');
    run.gesture = currentGesture();
  }
  useCompose.setState({ errors: {}, status: 'building', total: run.comp.steps.length });
  run.t0 = performance.now();
  camera.start = 0;
  if (!show(0)) return;
  composeView.reveal = 0;
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

/** New → Compose for me: an empty piece, the panel, and a build from a fresh seed. */
export function openCompose(): void {
  cancelFrame();
  clearView();
  run.gesture = run.entry = run.result = null;
  run.loading = true;
  try {
    newPieceNow();
  } finally {
    run.loading = false;
  }
  useCompose.setState((s) => ({
    open: true,
    errors: {},
    form: { ...s.form, seed: String(newSeed()) },
  }));
  restartCompose();
}

/** Closes the panel (a build in progress stops where it is). */
export function closeCompose(): void {
  stopCompose();
  useCompose.setState({ open: false });
}

/** Changes inputs and restarts the build from them (live). */
export function setComposeInput(patch: Partial<GenerateForm>): void {
  useCompose.setState((s) => ({ form: { ...s.form, ...patch } }));
  restartCompose();
}

// Opening another piece ends the compose session.
onLoadPiece(() => {
  if (run.loading || !useCompose.getState().open) return;
  cancelFrame();
  clearView();
  run.gesture = run.entry = run.result = null;
  useCompose.setState({ open: false, status: 'stopped' });
});
