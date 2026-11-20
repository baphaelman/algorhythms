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
  requestPlaybackSession(navigator);
  context = new AudioContext({ latencyHint: 'playback' });
  creating = AudioEngine.create({ context }).then((e) => {
    engine = e;
    wire(e);
    return e;
  });
  // A failed creation must not be retried on every call; callers see the rejection through `whenReady`.
  creating.catch(() => undefined);
  return creating;
}

/** Resumes the context if it is suspended. Call synchronously in a user-gesture handler. */
export function resumeAudio(): void {
  if (context && context.state !== 'running' && context.state !== 'closed') void context.resume();
}

/** Queues `job` after everything queued before it; resolves to the engine when the job is done. */
function enqueue(job: (e: AudioEngine) => Promise<void>): Promise<AudioEngine> {
  const next = queue.then(async () => {
    const e = await primeAudio();
    await job(e);
    return e;
  });
  queue = next.catch(() => undefined);
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

/** Replaces the master mix (after an edit to `piece.mix`). */
export function mixAudio(mix: MixSettings): Promise<AudioEngine> {
  return enqueue(async (e) => e.setMix(mix));
}

/** Resolves with the engine once everything queued so far (the latest load or swap) is done. */
export function whenReady(): Promise<AudioEngine> {
  return enqueue(async () => undefined);
}
