/**
 * The player's one `AudioEngine`: created lazily (at idle, or on the first gesture), loaded and
 * swapped through a serial queue so a play request can wait for "the latest piece is loaded".
 *
 * The AudioContext is created synchronously inside `primeAudio()`, and `resumeAudio()` resumes it
 * synchronously, so both can run in a click handler (Safari's autoplay rule).
 */

import { AudioEngine, type Meter } from '../audio/engine';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import { requestPlaybackSession } from './platform';

/** Callbacks the actions register before the engine is created. */
export interface AudioHandlers {
  onMeter?: (meter: Meter) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
}

let handlers: AudioHandlers = {};
let context: AudioContext | null = null;
let creating: Promise<AudioEngine> | null = null;
let engine: AudioEngine | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Jobs queued and not yet settled; at 0 a new job can start synchronously. */
let running = 0;

/** Registers the engine callbacks (applied to the engine when it is created, or right away). */
export function configureAudio(h: AudioHandlers): void {
  handlers = { ...handlers, ...h };
  if (engine) wire(engine);
}

function wire(e: AudioEngine): void {
  e.onMeter = (m) => handlers.onMeter?.(m);
  e.onEnded = () => handlers.onEnded?.();
  e.onError = (msg) => handlers.onError?.(msg);
}

/** The engine, once created; null before. */
export function getEngine(): AudioEngine | null {
  return engine;
}

/** The AudioContext, once created; null before. */
export function getAudioContext(): AudioContext | null {
  return context;
}

/**
 * Creates the AudioContext and engine (idempotent) and returns the engine's promise. Safe to call
 * at idle; call it from a click handler on the first gesture so Safari lets the context start.
 */
export function primeAudio(): Promise<AudioEngine> {
  if (creating) return creating;
  creating = createPlayback();
  // A failed creation must not be retried on every call; callers see the rejection through `whenReady`.
  creating.catch(() => undefined);
  return creating;
}

/** A 'playback' context and its engine (adopted unless live mode took over meanwhile). */
function createPlayback(): Promise<AudioEngine> {
  requestPlaybackSession(navigator);
  const ctx = new AudioContext({ latencyHint: 'playback' });
  context = ctx;
  return AudioEngine.create({ context: ctx }).then((e) => {
    if (context === ctx) {
      engine = e;
      wire(e);
    }
    return e;
  });
}

/** Set while live mode holds the audio; `release` lets the held jobs run on a new engine. */
let liveGate: { release: () => void } | null = null;

/** True while live mode holds the audio (§9): there is no playback engine then. */
export function isLiveAudio(): boolean {
  return liveGate !== null;
}

/**
 * Live mode starts (§9, §8.3): a job, queued after everything queued so far, closes the playback
 * engine and its context. Jobs queued after it wait until `endLiveAudio`, which creates a new
 * 'playback' engine for them, so only the live context is open meanwhile. (Waiting for the queue
 * from outside it could deadlock: a job still waiting to start would get the held engine.)
 */
export function beginLiveAudio(): Promise<void> {
  if (liveGate) return Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  liveGate = { release };
  return enqueue(async (e) => {
    engine = null;
    context = null;
    creating = gate.then(() => createPlayback());
    creating.catch(() => undefined);
    await e.dispose();
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** Live mode ended: a new 'playback' context and engine; the jobs held meanwhile run on it. */
export function endLiveAudio(): Promise<AudioEngine> {
  const g = liveGate;
  if (!g) return primeAudio();
  liveGate = null;
  g.release();
  return creating as Promise<AudioEngine>;
}

/** Resumes the context if it is suspended. Call synchronously in a user-gesture handler. */
export function resumeAudio(): void {
  if (context && context.state !== 'running' && context.state !== 'closed') void context.resume();
}

/**
 * Queues `job` after everything queued before it; resolves to the engine when the job is done.
 * With the engine created and the queue idle, the job starts now (an edit's swap is posted before
 * the caller returns, ahead of any render).
 */
function enqueue(job: (e: AudioEngine) => Promise<void>): Promise<AudioEngine> {
  let next: Promise<AudioEngine>;
  const ready = engine;
  if (running === 0 && ready) {
    let run: Promise<void>;
    try {
      run = job(ready);
    } catch (err) {
      run = Promise.reject(err);
    }
    next = run.then(() => ready);
  } else {
    next = queue.then(async () => {
      const e = await primeAudio();
      await job(e);
      return e;
    });
  }
  running++;
  // Each job waits for the one before, so the count reaches 0 only when all have settled.
  queue = next.then(
    () => void running--,
    () => void running--,
  );
  return next;
}

/** Loads a score into the engine (stops playback at 0). Resolves when it has been posted. */
export function loadAudio(
  compiled: CompiledScore,
  mix: MixSettings,
  timbres: Record<string, Timbre>,
): Promise<AudioEngine> {
  return enqueue((e) => e.load(compiled, mix, timbres));
}

/** Hot-swaps the score after an edit, building any new timbre tables first. */
export function swapAudio(
  compiled: CompiledScore,
  timbres: Record<string, Timbre>,
): Promise<AudioEngine> {
  return enqueue((e) => e.swap(compiled, timbres));
}

/** Sets the engine's loop range (null stops looping), after any queued load or swap. */
export function loopAudio(range: { start: number; end: number } | null): Promise<AudioEngine> {
  return enqueue(async (e) => e.loop(range));
}

/** Replaces the master mix (after an edit to `piece.mix`). */
export function mixAudio(mix: MixSettings): Promise<AudioEngine> {
  return enqueue(async (e) => e.setMix(mix));
}

/** Resolves with the engine once everything queued so far (the latest load or swap) is done. */
export function whenReady(): Promise<AudioEngine> {
  return enqueue(async () => undefined);
}

/**
 * Auditions a short score (../audition.ts) after any queued load or swap. `current()` says whether
 * this audition is still the latest one wanted: if not by its turn it is skipped; if it was stopped
 * meanwhile (`wanted()` false) it is ended at once. Resolves false if it did not start.
 */
export function auditionAudio(
  score: CompiledScore,
  timbres: Record<string, Timbre>,
  current: () => boolean,
  wanted: () => boolean,
): Promise<boolean> {
  let ok = false;
  return enqueue(async (e) => {
    if (!current()) return;
    ok = await e.audition(score, timbres);
    if (ok && !wanted()) e.endAudition();
  }).then(() => ok);
}

/** Ends the audition now if the engine exists (sync), so a following play starts on the piece. */
export function endAuditionAudio(): void {
  engine?.endAudition();
}
