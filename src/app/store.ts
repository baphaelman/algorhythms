/**
 * The player's state and actions (PLAN.md §11.3a, §11.4).
 *
 * `usePlayer` is a Zustand store `{ piece, compiled, view, transport, notices }`. React reads it
 * through selectors for panels and menus only; the score canvas and the time, scrubber and meter
 * readouts are driven by `loop.ts`, which reads `usePlayer.getState()` and `currentTime()`
 * directly every animation frame, outside React.
 *
 * Hooks for later builders (editor, Generate, Export):
 * - `loadPiece(piece)`: open a new piece (compiles now, loads the engine, resets the transport).
 * - `onLoadPiece(fn)`: run `fn` after every `loadPiece` (the editor resets its undo history).
 * - `setPiece(piece)`: replace the piece after an edit; recompiles once per animation frame and
 *   hot-swaps the engine. `usePlayer.getState().compiled` follows one frame later.
 *   `setPiece(piece, { now: true })` (one-off edits, undo) compiles and swaps before returning.
 * - `usePlayer.getState().compiled` / `.piece`: the current score and piece.
 * - `getEngine()` (from ./audio): the AudioEngine once created (null before); `whenReady()`
 *   resolves with it after the latest load or swap.
 */

import { create } from 'zustand';
import { canonicalPiece } from '../core/canonical';
import { createIncrementalCompiler } from '../core/compiler/incremental';
import { parsePiece } from '../core/schema';
import type {
  CompiledScore,
  FollowMode,
  LineColors,
  LoopRegion,
  Piece,
  Seconds,
} from '../core/types';
import {
  DEFAULT_FOLLOW,
  canvasEnd,
  clampStart,
  clampWindow,
  zoomAnchor,
  zoomAround,
} from '../render';
import {
  configureAudio,
  getEngine,
  isLiveAudio,
  loadAudio,
  loopAudio,
  mixAudio,
  primeAudio,
  resumeAudio,
  swapAudio,
  whenReady,
} from './audio';
import { writeMeter } from './dom';
import { foldOpeningKeys } from './editor/piece-key';
import { featuredExample } from './examples';
import { clampLoop, type LoopSpan } from './ruler';
import { decodeSharePayload, sharePayloadOf } from './share';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** User theme preference; `system` follows `prefers-color-scheme`. */
export type ThemePref = 'system' | 'light' | 'dark';

/** What the user controls about the picture. */
export interface ViewState {
  /** Visible time window, seconds (2 s up to the whole piece, log slider). */
  window: Seconds;
  /** Line colouring. */
  colors: LineColors;
  /** Theme preference (persisted in localStorage). */
  theme: ThemePref;
  /** How the view follows the playhead (§10); `camera.start` holds the view's position. */
  follow: FollowMode;
  /** Draw the canvas heads-up display. */
  hud: boolean;
}

/** Transport status. `idle` = loaded, nothing played yet (overview shown). */
export type TransportStatus = 'idle' | 'playing' | 'paused' | 'ended';

export interface TransportState {
  status: TransportStatus;
  /** True while the scrubber is being dragged (playback is silent meanwhile). */
  scrubbing: boolean;
  /** Audio engine: `cold` (not created), `loading`, `ready`, or `error`. */
  audio: 'cold' | 'loading' | 'ready' | 'error';
}

/** A dismissible message under the transport bar. */
export interface Notice {
  id: number;
  kind: 'error' | 'warning' | 'info';
  title: string;
  lines: string[];
}

export interface PlayerState {
  piece: Piece;
  compiled: CompiledScore;
  view: ViewState;
  transport: TransportState;
  notices: Notice[];
}

const THEME_KEY = 'algorhythms.theme';

function storedTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function parseOrThrow(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

function viewFor(piece: Piece, compiled: CompiledScore, theme: ThemePref): ViewState {
  return {
    window: clampWindow(piece.view.window, compiled.duration),
    colors: piece.view.colors,
    theme,
    follow: piece.view.follow ?? DEFAULT_FOLLOW,
    hud: piece.view.hud,
  };
}

const initialPiece = foldOpeningKeys(parseOrThrow(featuredExample().json));
/** Edits recompile from the last checkpoint before the first changed moment (§7.10). */
const incremental = createIncrementalCompiler();
const initialCompiled = incremental.compile(initialPiece);

/** The store. `usePlayer(selector)` in components; `usePlayer.getState()` everywhere else. */
export const usePlayer = create<PlayerState>()(() => ({
  piece: initialPiece,
  compiled: initialCompiled,
  view: viewFor(initialPiece, initialCompiled, storedTheme()),
  transport: { status: 'idle', scrubbing: false, audio: 'cold' },
  notices: [],
}));

const get = usePlayer.getState;
const set = usePlayer.setState;

function setTransport(patch: Partial<TransportState>): void {
  set((s) => ({ transport: { ...s.transport, ...patch } }));
}
function setView(patch: Partial<ViewState>): void {
  set((s) => ({ view: { ...s.view, ...patch } }));
}

// ---------------------------------------------------------------------------------------------
// Camera position (transient: written every frame while following, so not in the store)
// ---------------------------------------------------------------------------------------------

/**
 * The view's left-edge time (§10 camera `{ start, window }`; the window is `view.window`). The
 * loop applies the follow mode to it each frame (`followStart`) while playing or after the
 * playhead moved; pans and zooms write it here. Read it with the window through `cameraOf()`.
 */
export const camera = {
  start: 0,
  /**
   * True while the ruler is pressed: the view holds still instead of following (§10). On release
   * the ruler sets `release`; the loop clears both after one more held frame, so the seek itself
   * never scrolls the view.
   */
  hold: false,
  release: false,
  /**
   * The pitch range held during a dot or note drag (§11.3 revision 7): the view stops re-fitting
   * to the score, so a drag past the edge never rescales under the pointer. Null: auto-fit.
   */
  pitch: null as [number, number] | null,
};

/** The camera now: `{ start, window }`, both clamped to the open canvas (`canvasEnd`). */
export function cameraOf(): { start: Seconds; window: Seconds } {
  const { view, compiled } = get();
  const window = clampWindow(view.window, compiled.duration);
  return { start: clampStart(camera.start, window, compiled.duration), window };
}

// ---------------------------------------------------------------------------------------------
// Clock (transient: not in the store, read every frame)
// ---------------------------------------------------------------------------------------------

const clock = {
  /** Position while not playing (and until the engine confirms a play). */
  pos: 0,
  /** True once `engine.play()` has been called for the current play. */
  started: false,
  /** Position under the scrubber while dragging. */
  scrub: 0,
  /** Whether playback was running when the scrub began. */
  resume: false,
  /** Bumped by every pause, load and seek-while-pending, so stale async plays are dropped. */
  token: 0,
};

/**
 * A live take being recorded (src/app/live.ts `armRecord`): the transport shows 'playing' and the
 * playhead runs over the timeline on the live clock (silent: no playback in live mode, §9).
 */
let recording: { now: () => Seconds; stop: () => void } | null = null;

/** Starts the recording clock: the playhead follows `now`; pausing calls `stop`. */
export function startRecordClock(now: () => Seconds, stop: () => void): void {
  clock.token++;
  clock.started = false;
  recording = { now, stop };
  setTransport({ status: 'playing', scrubbing: false });
}

/** Stops the recording clock, leaving the playhead at `at`. */
export function stopRecordClock(at: Seconds): void {
  if (!recording) return;
  recording = null;
  clock.pos = Math.max(0, at);
  setTransport({ status: 'paused' });
}

/** True while a live take runs the transport. */
export function isRecordClock(): boolean {
  return recording !== null;
}

/** The playhead time, seconds: what the picture and readouts show right now. */
export function currentTime(): Seconds {
  if (recording) return recording.now();
  const { transport, compiled } = get();
  if (transport.scrubbing) return clock.scrub;
  if (transport.status === 'ended') return compiled.duration;
  if (transport.status === 'playing' && clock.started) {
    const e = getEngine();
    if (e) return Math.min(compiled.duration, e.currentTime());
  }
  return clock.pos;
}

// ---------------------------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------------------------

let noticeId = 0;

/** Shows a message under the transport bar. Returns its id. */
export function pushNotice(kind: Notice['kind'], title: string, lines: string[] = []): number {
  const id = ++noticeId;
  set((s) => ({ notices: [...s.notices, { id, kind, title, lines }] }));
  return id;
}

/** Removes one notice. */
export function dismissNotice(id: number): void {
  set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

// ---------------------------------------------------------------------------------------------
// Engine events and deferred audio loading
// ---------------------------------------------------------------------------------------------

configureAudio({
  onMeter(m) {
    writeMeter(Math.max(m.peakL, m.peakR));
  },
  onEnded() {
    const { transport, compiled } = get();
    if (transport.status !== 'playing') return;
    clock.started = false;
    clock.pos = compiled.duration;
    setTransport({ status: 'ended' });
  },
  onError(message) {
    pushNotice('error', 'The audio engine reported a problem', [message]);
  },
});

let deferredLoad: (() => void) | null = null;
let loadSeq = 0;

function onIdle(fn: () => void): void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 400 });
  else setTimeout(fn, 150);
}

/** Runs the pending engine load now (play calls this so it never waits for idle). */
function flushAudioLoad(): void {
  const f = deferredLoad;
  deferredLoad = null;
  f?.();
}

function queueAudioLoad(piece: Piece, compiled: CompiledScore): void {
  setTransport({ audio: 'loading' });
  const seq = ++loadSeq;
  deferredLoad = () => {
    const loading = loadAudio(compiled, piece.mix, piece.timbres);
    // The load clears the engine's loop; send the piece's after it.
    sentLoop = '';
    syncLoop();
    loading
      .then(() => {
        if (seq === loadSeq) setTransport({ audio: 'ready' });
      })
      .catch((e: unknown) => {
        setTransport({ audio: 'error' });
        pushNotice('error', 'Audio could not start', [e instanceof Error ? e.message : String(e)]);
      });
  };
  onIdle(flushAudioLoad);
}

/** Loads the current piece into the engine again (after live mode, §9). */
export function reloadAudio(): void {
  const { piece, compiled } = get();
  clock.started = false;
  queueAudioLoad(piece, compiled);
  flushAudioLoad();
}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

/** Options for `loadPiece`. */
export interface LoadOptions {
  /** A compile of this exact piece, to skip recompiling. */
  compiled?: CompiledScore;
  /** Keep the page's `#p=` fragment (set when the piece came from it). */
  keepHash?: boolean;
  /** Notices to show after loading (parse warnings). Replaces the current ones. */
  notices?: Omit<Notice, 'id'>[];
  /** Keep the notices already showing (and add `notices` after them). */
  keepNotices?: boolean;
  /** Where the piece came from, for autosave (persist/). @default 'other' */
  source?: 'generated' | 'new' | 'library' | 'other';
}

/** Counts `loadPiece` calls, so a `usePlayer.subscribe` listener can tell loads from edits. */
const lastLoad = { count: 0, source: 'other' as NonNullable<LoadOptions['source']> };

/** The number of loads so far and the latest one's source. */
export function loadInfo(): Readonly<typeof lastLoad> {
  return lastLoad;
}

function clearShareHash(): void {
  if (sharePayloadOf(location.hash) === null) return;
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* ignore */
  }
}

const loadListeners: (() => void)[] = [];

/** Calls `fn` after every `loadPiece` (the editor clears its history there). */
export function onLoadPiece(fn: () => void): void {
  loadListeners.push(fn);
}

/**
 * Opens a piece: compiles it, resets the transport (stopped at 0, overview shown) and the view
 * (window, colours and HUD from `piece.view`), and loads the audio engine (at idle, or when play
 * is pressed, whichever comes first). The theme choice is kept. Key moments opening the piece
 * at 0 are folded into `piece.key` (editor/piece-key.ts).
 */
export function loadPiece(loaded: Piece, opts: LoadOptions = {}): void {
  // The piece key is the key moment at 0:00 (M4.5-39): opening key moments fold into it. Numbers
  // are canonical (core/canonical.ts), so share links round-trip exactly.
  const piece = canonicalPiece(foldOpeningKeys(loaded));
  if (piece !== loaded) opts = { ...opts, compiled: undefined };
  recording = null; // a take being recorded is dropped (live.ts listens)
  clock.token++;
  clock.pos = 0;
  clock.started = false;
  clock.resume = false;
  incremental.reset();
  const compiled = opts.compiled ?? incremental.compile(piece);
  compiledPiece = piece;
  const notices: Notice[] = (opts.notices ?? []).map((n) => ({ ...n, id: ++noticeId }));
  const errors = compiled.diagnostics.filter((d) => d.level === 'error');
  if (errors.length > 0) {
    notices.push({
      id: ++noticeId,
      kind: 'warning',
      title: `${errors.length} ${errors.length === 1 ? 'moment was' : 'moments were'} not applied as written`,
      lines: errors.slice(0, 5).map((d) => d.message),
    });
  }
  lastLoad.count++;
  lastLoad.source = opts.source ?? 'other';
  camera.start = 0;
  set((s) => ({
    piece,
    compiled,
    view: viewFor(piece, compiled, s.view.theme),
    transport: { status: 'idle', scrubbing: false, audio: s.transport.audio },
    notices: opts.keepNotices ? [...s.notices, ...notices] : notices,
  }));
  if (!opts.keepHash) clearShareHash();
  document.title =
    piece.meta.title === 'Untitled' ? 'AlgoRhythms' : `${piece.meta.title} · AlgoRhythms`;
  queueAudioLoad(piece, compiled);
  for (const fn of loadListeners) fn();
}

let recompilePending = false;
/** The piece `compiled` was last built from (the rAF compile skips when it is current). */
let compiledPiece: Piece | null = null;
/** True from a `now` compile until the end of the current task (see `compiledThisTask`). */
let compiledInTask = false;

/**
 * Replaces the piece after an edit. The store's `piece` changes now; `compiled` follows within one
 * animation frame (several edits in a frame cost one compile), and the engine is hot-swapped.
 * With `now` (a one-off edit, not a drag) it compiles at once and posts the swap before the store
 * (and React) sees the change, so the edit is heard without waiting for a render or a frame.
 */
export function setPiece(next: Piece, opts: { now?: boolean } = {}): void {
  const prev = get().piece;
  // Canonical numbers (core/canonical.ts): copy-on-write, so unchanged moments keep identity.
  // The loop region and "Snap to beats" are view state, not edits: undo and edits keep the
  // current ones.
  let piece = canonicalPiece(next);
  if (next.view.loop !== prev.view.loop) {
    piece = { ...piece, view: withLoop(piece.view, prev.view.loop) };
  }
  if (next.view.snapBeats !== prev.view.snapBeats) {
    piece = { ...piece, view: withSnapBeats(piece.view, prev.view.snapBeats) };
  }
  if (piece.mix !== prev.mix) void mixAudio(piece.mix).catch(() => undefined);
  if (opts.now) {
    commitCompile(piece, true);
    return;
  }
  set({ piece });
  if (recompilePending) return;
  recompilePending = true;
  requestAnimationFrame(() => {
    recompilePending = false;
    if (compiledPiece !== get().piece) recompileNow();
  });
}

/** Compiles the current piece immediately and swaps it into the engine. */
export function recompileNow(): CompiledScore {
  return commitCompile(get().piece, false);
}

/** Compiles `piece`, posts the swap, then stores both (one store update, one render). */
function commitCompile(piece: Piece, now: boolean): CompiledScore {
  const compiled = incremental.compile(piece);
  compiledPiece = piece;
  void swapAudio(compiled, piece.timbres).catch(() => undefined);
  if (now && !compiledInTask) {
    compiledInTask = true;
    queueMicrotask(() => {
      compiledInTask = false;
    });
  }
  set(get().piece === piece ? { compiled } : { piece, compiled });
  syncLoop();
  return compiled;
}

/**
 * True if a `setPiece(…, { now: true })` compiled during the current task: the edit just made is
 * already in `compiled` (the audition after an inspector pick plays it at once).
 */
export function compiledThisTask(): boolean {
  return compiledInTask;
}

type OpenGate = (run: () => void) => void;
let openGate: OpenGate = (run) => run();

/**
 * Every way of replacing the open piece (New, Generate, Compose, an example, My pieces, a file, a
 * share link) goes through `runOpen`, so the "name it before moving on" question (§11.4) can hold
 * the open until it is answered. `setOpenGate` installs the question (ui/NamePrompt via naming.ts);
 * without one, `runOpen` runs at once.
 */
export function runOpen(run: () => void): void {
  openGate(run);
}

/** Installs the gate `runOpen` calls. */
export function setOpenGate(gate: OpenGate): void {
  openGate = gate;
}

/** Parses piece JSON (text or value) and opens it; shows errors and warnings as notices. */
export function openPieceJson(json: unknown, label: string, opts: LoadOptions = {}): boolean {
  const r = parsePiece(json);
  if (!r.ok) {
    pushNotice('error', `Could not open ${label}`, r.errors.slice(0, 8));
    return false;
  }
  const notices = [...(opts.notices ?? [])];
  if (r.warnings.length > 0) {
    notices.push({ kind: 'warning', title: `${label} opened with warnings`, lines: r.warnings });
  }
  const piece = r.piece;
  runOpen(() => loadPiece(piece, { ...opts, notices }));
  return true;
}

/** Opens a `.algorhythms.json` file. */
export async function openFile(file: File): Promise<boolean> {
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    pushNotice('error', `Could not read ${file.name}`, [
      e instanceof Error ? e.message : String(e),
    ]);
    return false;
  }
  return openPieceJson(text, file.name);
}

/** Opens a bundled example by its id. */
export function openExample(json: unknown): void {
  openPieceJson(json, 'the example');
}

/** Opens the piece in a `#p=` fragment; on failure shows an error and keeps the current piece. */
export async function openShareHash(hash: string): Promise<boolean> {
  const payload = sharePayloadOf(hash);
  if (payload === null) return false;
  let json: unknown;
  try {
    json = await decodeSharePayload(payload);
  } catch (e) {
    pushNotice('error', 'Could not open the shared link', [
      e instanceof Error ? e.message : String(e),
    ]);
    return false;
  }
  return openPieceJson(json, 'The shared piece', { keepHash: true });
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

/** Starts (or resumes) playback. Call from a user gesture. */
export function play(): void {
  const { transport, compiled } = get();
  if (transport.status === 'playing' && !transport.scrubbing) return;
  // v1: live mode and playback don't overlap (§9; leave live mode first).
  if (isLiveAudio()) return;
  // The synchronous part runs inside the gesture: create/resume the context before any await.
  void primeAudio().catch(() => undefined);
  resumeAudio();
  flushAudioLoad();
  if (transport.status === 'ended' || clock.pos >= compiled.duration - 1e-3) clock.pos = 0;
  clock.started = false;
  setTransport({ status: 'playing', scrubbing: false });
  const token = ++clock.token;
  void whenReady().then(
    (engine) => {
      if (token !== clock.token || get().transport.status !== 'playing') return;
      engine.play(clock.pos);
      clock.started = true;
      setTransport({ audio: 'ready' });
    },
    (e: unknown) => {
      if (token !== clock.token) return;
      setTransport({ status: 'paused', audio: 'error' });
      pushNotice('error', 'Audio could not start', [e instanceof Error ? e.message : String(e)]);
    },
  );
}

/** Pauses, keeping the position. */
export function pause(): void {
  // While recording, Pause (and Space) stops the take and keeps it.
  if (recording) {
    recording.stop();
    return;
  }
  const { transport } = get();
  if (transport.status !== 'playing') return;
  clock.pos = currentTime();
  clock.token++;
  if (clock.started) getEngine()?.pause();
  clock.started = false;
  setTransport({ status: 'paused' });
}

/** Play or pause. */
export function togglePlay(): void {
  if (get().transport.status === 'playing') pause();
  else play();
}

/**
 * Where the playhead may be put (open-ended canvas, §11.3 revision 7): anywhere on the canvas
 * while paused, so an Add can land past the end; within the piece while playing. Play from at or
 * past the end starts from 0.
 */
function seekable(t: Seconds, playing: boolean): Seconds {
  const D = get().compiled.duration;
  const hi = playing ? D : canvasEnd(D);
  return Math.min(hi, Math.max(0, Number.isFinite(t) ? t : 0));
}

/** Moves the playhead to `t` seconds (playing continues from there). */
export function seekTo(t: Seconds): void {
  if (recording) return;
  const { transport } = get();
  const to = seekable(t, transport.status === 'playing');
  clock.pos = to;
  if (transport.status === 'playing') {
    if (clock.started) getEngine()?.seek(to);
    return;
  }
  setTransport({ status: 'paused' });
}

/** Moves the playhead by `dt` seconds. */
export function seekBy(dt: Seconds): void {
  seekTo(currentTime() + dt);
}

/**
 * Scrubbing, as in the prototype: silent while dragging, the picture follows the handle; on
 * release it resumes from there if it was playing, else waits paused at the new position.
 */
export function scrubTo(t: Seconds): void {
  if (recording) return;
  const { transport } = get();
  if (!transport.scrubbing) {
    clock.resume = transport.status === 'playing';
    if (clock.resume) {
      clock.pos = currentTime();
      clock.token++;
      if (clock.started) getEngine()?.pause();
      clock.started = false;
    }
    setTransport({ status: 'paused', scrubbing: true });
  }
  clock.scrub = seekable(t, false);
}

/** Ends a scrub at `t`. */
export function scrubEnd(t?: Seconds): void {
  if (!get().transport.scrubbing) return;
  if (t !== undefined) scrubTo(t);
  clock.pos = clock.scrub;
  const resume = clock.resume;
  clock.resume = false;
  setTransport({ scrubbing: false });
  if (resume) play();
}

// ---------------------------------------------------------------------------------------------
// Loop region (§11.3 revision 6): stored in `piece.view.loop`, saved with the piece, not undone
// ---------------------------------------------------------------------------------------------

/**
 * A loop region being dragged on the ruler (transient: committed with `setLoop` on release). While
 * `span` is set, the overlay shows it instead of the stored region.
 */
export const loopDraft: { span: LoopSpan | null } = { span: null };

function withLoop(view: Piece['view'], loop: LoopRegion | undefined): Piece['view'] {
  const { loop: _old, ...rest } = view;
  return loop ? { ...rest, loop } : rest;
}

/** The stored loop region, clipped to the piece, with its on/off state; null when none. */
export function loopRegion(): (LoopSpan & { on: boolean }) | null {
  const { piece, compiled } = get();
  const span = clampLoop(piece.view.loop, compiled.duration);
  return span ? { ...span, on: piece.view.loop?.on !== false } : null;
}

/** The span playback loops now: the region when it is on, else null. */
export function activeLoop(): LoopSpan | null {
  const r = loopRegion();
  return r && r.on ? { start: r.start, end: r.end } : null;
}

/** The range the engine was last sent ('' = none). */
let sentLoop = '';

/** Sends the active loop to the engine if it changed (the pending load sends it otherwise). */
function syncLoop(): void {
  if (deferredLoad) return;
  const span = activeLoop();
  const key = span ? `${span.start}|${span.end}` : '';
  if (key === sentLoop) return;
  sentLoop = key;
  void loopAudio(span).catch(() => undefined);
}

function storeLoop(loop: LoopRegion | undefined): void {
  const { piece } = get();
  set({ piece: { ...piece, view: withLoop(piece.view, loop) } });
  syncLoop();
}

/** Sets the loop region (turned on), or clears it with null. */
export function setLoop(span: LoopSpan | null): void {
  loopDraft.span = null;
  storeLoop(span ? { start: span.start, end: span.end, on: true } : undefined);
}

/** Turns looping on or off, keeping the region; false when there is no region. */
export function toggleLoop(on?: boolean): boolean {
  const r = get().piece.view.loop;
  if (!r || !loopRegion()) return false;
  const next = on ?? r.on === false;
  if ((r.on !== false) !== next) storeLoop({ ...r, on: next });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Snap to beats (§11.3 revision 9): `piece.view.snapBeats`, saved with the piece, not undone
// ---------------------------------------------------------------------------------------------

function withSnapBeats(view: Piece['view'], snapBeats: boolean | undefined): Piece['view'] {
  const { snapBeats: _old, ...rest } = view;
  return snapBeats === undefined ? rest : { ...rest, snapBeats };
}

/**
 * Turns "Snap to beats" on or off for the piece (absent = on when the piece has a tempo; stored
 * only when off). Takes effect on the next edit gesture; the piece itself compiles the same.
 */
export function setSnapBeats(on: boolean): void {
  const { piece } = get();
  set({ piece: { ...piece, view: withSnapBeats(piece.view, on ? undefined : false) } });
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------

/**
 * Sets the visible window (clamped to 2 s … the open canvas), keeping the playhead's x when it is
 * in view, else the view's centre.
 */
export function setWindow(seconds: Seconds): void {
  const { compiled } = get();
  const cam = cameraOf();
  const next = zoomAround(
    cam,
    seconds,
    zoomAnchor(cam.start, cam.window, currentTime()),
    compiled.duration,
  );
  camera.start = next.start;
  setView({ window: next.window });
}

/** Multiplies the window (1.25 zooms out, 0.8 zooms in); see `setWindow`. */
export function zoomBy(factor: number): void {
  setWindow(cameraOf().window * factor);
}

/** Shows the whole piece, from 0. */
export function fitWindow(): void {
  camera.start = 0;
  setView({ window: clampWindow(get().compiled.duration, get().compiled.duration) });
}

/** Sets the follow mode. */
export function setFollow(follow: FollowMode): void {
  setView({ follow });
}

/** Sets the line colouring. */
export function setColors(colors: LineColors): void {
  setView({ colors });
}

/** Shows or hides the canvas heads-up display. */
export function setHud(hud: boolean): void {
  setView({ hud });
}

/**
 * Pans the view by `dt` seconds (positive looks later), within the open canvas. A pan during playback
 * turns Follow off.
 */
export function panBy(dt: Seconds): void {
  const { transport, view, compiled } = get();
  const cam = cameraOf();
  camera.start = clampStart(cam.start + dt, cam.window, compiled.duration);
  // The loop redraws when it sees `camera.start` change.
  if (transport.status === 'playing' && view.follow !== 'off') setView({ follow: 'off' });
}

/** Applies the theme preference to the document and stores it. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

/** Sets and persists the theme preference. */
export function setTheme(theme: ThemePref): void {
  setView({ theme });
  applyTheme(theme);
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

let started = false;

/**
 * Starts the player: opens the piece in the page's `#p=` link, else the featured example (loaded,
 * not playing); warms the audio engine at idle or on the first gesture; follows `hashchange`.
 */
export function startPlayer(): void {
  if (started) return;
  started = true;
  applyTheme(get().view.theme);
  const hash = location.hash;
  if (sharePayloadOf(hash) !== null) {
    void openShareHash(hash).then((ok) => {
      if (!ok) loadPiece(initialPiece, { compiled: initialCompiled, keepNotices: true });
    });
  } else {
    loadPiece(initialPiece, { compiled: initialCompiled });
  }
  window.addEventListener('hashchange', () => void openShareHash(location.hash));
  // First gesture: create the context and build wavetables if idle time hasn't already.
  window.addEventListener(
    'pointerdown',
    () => {
      void primeAudio().catch(() => undefined);
      flushAudioLoad();
    },
    { once: true, capture: true },
  );
}
