/**
 * Stems export worker (PLAN.md §8.1, §12): runs `writeStemsZip` off the main thread and posts the
 * zip as byte chunks, each transferred. The client acknowledges every chunk after it has written
 * it (to disk or into a Blob), and the worker stops rendering while more than WINDOW bytes are
 * unacknowledged, so a slow disk never piles audio up in memory. Cancel by terminating the worker
 * (stems-client.ts does).
 */

import type { FlatScore } from '../core/flat';
import type { MixSettings, Timbre } from '../core/types';
import {
  planStems,
  writeStemsZip,
  type StemsOptions,
  type StemsPlan,
  type StemsProgress,
  type StemsSummary,
} from './stems';

/** Client → worker. */
export type StemsRequest =
  | {
      type: 'start';
      score: FlatScore;
      mix: MixSettings;
      timbres?: Record<string, Timbre>;
      options: StemsOptions;
    }
  | { type: 'ack'; bytes: number };

/** Worker → client. */
export type StemsReply =
  | { type: 'plan'; plan: StemsPlan }
  | { type: 'chunk'; data: Uint8Array<ArrayBuffer> }
  | { type: 'progress'; progress: StemsProgress }
  | { type: 'done'; summary: StemsSummary }
  | { type: 'error'; message: string };

/** Most unacknowledged bytes in flight (a few chunks). */
const WINDOW = 8 * 1024 * 1024;

function reply(msg: StemsReply, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

let inFlight = 0;
let wake: (() => void) | null = null;

async function run(req: Extract<StemsRequest, { type: 'start' }>): Promise<void> {
  try {
    const input = { score: req.score, mix: req.mix, timbres: req.timbres };
    reply({ type: 'plan', plan: planStems(input, req.options) });
    let lastSent = -1;
    const summary = await writeStemsZip(
      input,
      req.options,
      async (data) => {
        inFlight += data.byteLength;
        reply({ type: 'chunk', data }, [data.buffer]);
        while (inFlight > WINDOW) await new Promise<void>((resolve) => (wake = resolve));
      },
      {
        onProgress: (progress) => {
          // About 1000 updates per export is plenty for a progress bar.
          if (progress.fraction - lastSent >= 0.001 || progress.fraction >= 1) {
            lastSent = progress.fraction;
            reply({ type: 'progress', progress });
          }
        },
      },
    );
    reply({ type: 'done', summary });
  } catch (e) {
    reply({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = (event: MessageEvent<StemsRequest>) => {
  const msg = event.data;
  if (msg.type === 'ack') {
    inFlight -= msg.bytes;
    if (inFlight <= WINDOW) wake?.();
  } else {
    void run(msg);
  }
};
