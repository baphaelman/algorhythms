/**
 * WAV export worker (PLAN.md §8.1, §12): runs the DSP graph faster than real time and posts the
 * file as byte chunks (header first, then ~1 s of audio per chunk), each transferred, with
 * progress. Cancel by terminating the worker (export-client.ts does).
 */

import type { FlatScore } from '../core/flat';
import type { MixSettings, Timbre } from '../core/types';
import type { NormalizeReport } from '../dsp/loudness';
import { wavExportChunks, wavExportSize, type WavExportOptions } from './wav-export';

/** Start an export. */
export interface ExportRequest {
  score: FlatScore;
  mix: MixSettings;
  timbres?: Record<string, Timbre>;
  options: WavExportOptions;
}

/** Worker → client. */
export type ExportReply =
  | { type: 'size'; bytes: number; frames: number }
  | { type: 'chunk'; data: Uint8Array<ArrayBuffer>; progress: number }
  | { type: 'loudness'; report: NormalizeReport }
  | { type: 'done' }
  | { type: 'error'; message: string };

function reply(msg: ExportReply, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = (event: MessageEvent<ExportRequest>) => {
  const { score, mix, timbres, options } = event.data;
  try {
    const input = { score, mix, timbres };
    const { bytes, frames } = wavExportSize(input, options);
    reply({ type: 'size', bytes, frames });
    let progress = 0;
    const chunks = wavExportChunks(
      input,
      options,
      (f) => (progress = f),
      (report) => reply({ type: 'loudness', report }),
    );
    for (const data of chunks) {
      reply({ type: 'chunk', data, progress }, [data.buffer]);
    }
    reply({ type: 'done' });
  } catch (e) {
    reply({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
