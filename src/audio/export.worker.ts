/**
 * WAV export worker (PLAN.md §8.1, §12): runs the DSP graph faster than real time and posts the
 * file as byte chunks (header first, then ~1 s of audio per chunk), each transferred, with
 * progress. Cancel by terminating the worker (export-client.ts does).
 */

import type { FlatScore } from '../core/flat';
import type { MixSettings, Timbre } from '../core/types';
import type { LoudnessMeasure, NormalizeReport } from '../dsp/loudness';
import { measureExport, wavExportChunks, wavExportSize, type WavExportOptions } from './wav-export';

/** Start an export. */
export interface ExportRequest {
  score: FlatScore;
  mix: MixSettings;
  timbres?: Record<string, Timbre>;
  options: WavExportOptions;
  /** Measure the render's loudness only (`measureExport`): no file, one `measure` reply. */
  measure?: boolean;
}

/** Worker → client. */
export type ExportReply =
  | { type: 'size'; bytes: number; frames: number }
  | { type: 'chunk'; data: Uint8Array<ArrayBuffer>; progress: number }
  | { type: 'loudness'; report: NormalizeReport }
  | { type: 'progress'; progress: number }
  | { type: 'measure'; measure: LoudnessMeasure }
  | { type: 'done' }
  | { type: 'error'; message: string };

function reply(msg: ExportReply, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = (event: MessageEvent<ExportRequest>) => {
  const { score, mix, timbres, options, measure } = event.data;
  try {
    const input = { score, mix, timbres };
    if (measure) {
      let last = 0;
      const m = measureExport(input, options, (f) => {
        if (f - last >= 0.02 || f === 1) {
          last = f;
          reply({ type: 'progress', progress: f });
        }
      });
      reply({ type: 'measure', measure: m });
      return;
    }
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
