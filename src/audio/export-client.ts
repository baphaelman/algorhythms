/**
 * WAV export from the main thread (PLAN.md §12): renders in a module worker and returns the file
 * as a Blob, or as a ReadableStream of byte chunks for streaming to disk. Progress is reported
 * per ~1 s chunk; an AbortSignal cancels (the worker is terminated).
 */

import { flatten, transferList } from '../core/flat';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import type { NormalizeReport } from '../dsp/loudness';
import type { ExportReply, ExportRequest } from './export.worker';
import type { WavExportOptions } from './wav-export';

/** One WAV export. */
export interface ExportWavRequest extends WavExportOptions {
  score: CompiledScore;
  mix: MixSettings;
  /** Piece timbres (Piece.timbres). */
  timbres?: Record<string, Timbre>;
  /** Fraction of the export rendered, 0..1. */
  onProgress?: (fraction: number) => void;
  /** Aborting terminates the render; the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** With `loudness` on: what normalising measured and did (before the audio chunks). */
  onLoudness?: (report: NormalizeReport) => void;
}

function abortError(): DOMException {
  return new DOMException('WAV export cancelled', 'AbortError');
}

/** The export as a stream of byte chunks (header first). Total size is known up front. */
export function exportWavStream(req: ExportWavRequest): ReadableStream<Uint8Array<ArrayBuffer>> {
  let worker: Worker | null = null;
  const stop = () => {
    worker?.terminate();
    worker = null;
  };
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      if (req.signal?.aborted) {
        controller.error(abortError());
        return;
      }
      const w = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
      worker = w;
      req.signal?.addEventListener('abort', () => {
        stop();
        controller.error(abortError());
      });
      w.onmessage = (e: MessageEvent<ExportReply>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'chunk':
            controller.enqueue(msg.data);
            req.onProgress?.(msg.progress);
            break;
          case 'loudness':
            req.onLoudness?.(msg.report);
            break;
          case 'done':
            stop();
            controller.close();
            break;
          case 'error':
            stop();
            controller.error(new Error(msg.message));
            break;
        }
      };
      w.onerror = (e) => {
        stop();
        controller.error(new Error(e.message || 'export worker failed'));
      };
      const flat = flatten(req.score);
      const request: ExportRequest = {
        score: flat,
        mix: req.mix,
        timbres: req.timbres,
        options: {
          sampleRate: req.sampleRate,
          bitDepth: req.bitDepth,
          chunkSeconds: req.chunkSeconds,
          ...(req.span ? { span: req.span } : {}),
          ...(req.loudness && req.loudness !== 'off' ? { loudness: req.loudness } : {}),
        },
      };
      w.postMessage(request, transferList(flat));
    },
    cancel() {
      stop();
    },
  });
}

/** Renders a WAV file and resolves with it as a Blob (built from the chunks, not one buffer). */
export async function exportWav(req: ExportWavRequest): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const reader = exportWavStream(req).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return new Blob(parts, { type: 'audio/wav' });
}
