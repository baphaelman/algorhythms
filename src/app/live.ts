/**
 * Live mode in the app (PLAN.md §9, §8.3): the one `LiveEngine`, and entering and leaving it.
 * Entering stops the transport, closes the playback context and opens an 'interactive' one with
 * the piece's voices at the playhead, its timbres and mix; leaving closes it and loads the piece
 * into a new 'playback' engine. The inputs (musical typing, Web MIDI, the piano ruler) and the
 * Live drawer call `live.noteOn` etc. (src/audio/live-engine.ts).
 */

import { LiveEngine } from '../audio/live-engine';
import { liveSetupFrom } from '../audio/live-setup';
import type { LiveSettings } from '../core/live';
import { beginLiveAudio, endLiveAudio, isLiveAudio } from './audio';
import { currentTime, pause, reloadAudio, usePlayer } from './store';

/** The live instrument. */
export const live = new LiveEngine();

/** Enter and exit run one after another. */
let busy: Promise<void> = Promise.resolve();

/** True while live mode is on (or being entered). */
export function isLive(): boolean {
  return isLiveAudio();
}

/**
 * Enters live mode. Call from a user gesture: the 'interactive' context is created before
 * anything is awaited. Resolves once the live voices run.
 */
export function enterLive(settings?: Partial<LiveSettings>): Promise<void> {
  if (isLiveAudio()) return busy;
  const context = new AudioContext({ latencyHint: 'interactive' });
  pause();
  const { piece, compiled } = usePlayer.getState();
  const setup = liveSetupFrom(piece, compiled, currentTime());
  const run = busy.then(async () => {
    await beginLiveAudio();
    try {
      await live.enter({ context, setup, settings });
    } catch (e) {
      if (context.state !== 'closed') await context.close();
      void endLiveAudio();
      reloadAudio();
      throw e;
    }
  });
  busy = run.catch(() => undefined);
  return run;
}

/** Leaves live mode: closes the interactive context and reloads the piece for playback. */
export function exitLive(): Promise<void> {
  const run = busy.then(async () => {
    if (!isLiveAudio()) return;
    await live.exit();
    void endLiveAudio();
    reloadAudio();
  });
  busy = run.catch(() => undefined);
  return run;
}
