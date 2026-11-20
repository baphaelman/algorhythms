/**
 * Main-thread loader for the M0 test-tone worklet.
 *
 * How the worklet URL is produced (the part §14 calls fiddly):
 * - `?worker&url` makes Vite treat the TypeScript file as a worker entry and give back its URL,
 *   without constructing a Worker.
 * - In `vite dev` the URL points at the transformed module
 *   (/src/audio/worklet/test-tone.worklet.ts?worker_file&type=module); its imports of dsp/ and
 *   core/ are fetched as separate ES modules, which module worklets support.
 * - In `vite build` the worklet and everything it imports are bundled into one ES module under
 *   assets/, and the URL includes the configured base (/algorhythms/ on GitHub Pages).
 * A plain `new URL('./x.ts', import.meta.url)` would copy the .ts file into the build uncompiled.
 */

import testToneWorkletUrl from './worklet/test-tone.worklet.ts?worker&url';
import {
  TEST_TONE_PROCESSOR,
  type TestToneOptions,
  type TestToneStopMessage,
} from './worklet/test-tone-protocol';

export { TEST_TONE_PROCESSOR, testToneWorkletUrl };
export type { TestToneOptions };

/** Loads the worklet module into `ctx` (idempotent per context) and creates a stereo tone node. */
export async function createTestTone(
  ctx: BaseAudioContext,
  options: TestToneOptions = {},
): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule(testToneWorkletUrl);
  return new AudioWorkletNode(ctx, TEST_TONE_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: options,
  });
}

/** Asks the node to fade out over `fade` seconds. */
export function stopTestTone(node: AudioWorkletNode, fade = 0.02): void {
  const msg: TestToneStopMessage = { type: 'stop', fade };
  node.port.postMessage(msg);
}
