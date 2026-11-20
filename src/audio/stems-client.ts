/**
 * Stems export from the main thread (PLAN.md §12): `exportStems(score, mix, opts)` renders in a
 * module worker and delivers one `.zip` either straight to disk (a `FileSystemFileHandle` from
 * `showSaveFilePicker`, or any `WritableStream`) or, with no target, as a Blob built from parts.
 * Backpressure: the worker waits for this side to finish each write. An AbortSignal cancels (the
 * worker is terminated and the writable aborted, so a partial file is discarded by the browser).
 *
 * The size estimate for the pre-export warning is `estimateStemsSize` (stems.ts, no worker).
 */

import { flatten, transferList } from '../core/flat';
import type { CompiledScore, MixSettings, Timbre } from '../core/types';
import type { StemsOptions, StemsPlan, StemsProgress, StemsSummary } from './stems';
import type { StemsReply, StemsRequest } from './stems.worker';

export { estimateStemsSize, planStems, STEMS_WARN_BYTES } from './stems';
export type { StemEntry, StemsOptions, StemsPlan, StemsProgress } from './stems';

/** Anything with `createWritable()`: a `FileSystemFileHandle` (showSaveFilePicker, OPFS). */
export interface StemsFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array<ArrayBuffer>>>;
}

/** Where the zip goes. */
export type StemsTarget = StemsFileHandle | WritableStream<Uint8Array<ArrayBuffer>>;

/** One stems export. */
export interface ExportStemsOptions extends StemsOptions {
  /** Piece timbres (Piece.timbres). */
  timbres?: Record<string, Timbre>;
  /**
   * A file handle or writable to stream the zip into. Omit to get a Blob (the whole zip is then
   * held in memory by the browser). Prefer a handle where `canSaveToDisk()` is true.
   */
  target?: StemsTarget;
  /** Called after each ~1 s chunk (throttled to ~1000 calls per export). */
  onProgress?: (p: StemsProgress) => void;
  /** Called once with the file list and exact size, before rendering starts. */
  onPlan?: (plan: StemsPlan) => void;
  /** Aborting terminates the render; the promise rejects with an AbortError. */
  signal?: AbortSignal;
}

/** The outcome. */
export interface ExportStemsResult extends StemsSummary {
  /** The zip, when no `target` was given; null when it was written to the target. */
  blob: Blob | null;
}

/** True where `showSaveFilePicker` exists (Chromium): stream straight to disk. */
export function canSaveToDisk(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

/**
 * Opens the browser's save dialog for the zip; call it from the click handler, before the export.
 * Resolves with a handle for `target`, or null if the browser has no picker or the user cancels.
 */
export async function pickStemsFile(suggestedName: string): Promise<StemsFileHandle | null> {
  const pick = (
    globalThis as {
      showSaveFilePicker?: (o: unknown) => Promise<StemsFileHandle>;
    }
  ).showSaveFilePicker;
  if (!pick) return null;
  try {
    return await pick.call(globalThis, {
      suggestedName,
      types: [{ description: 'Stems (zip)', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

function abortError(): DOMException {
  return new DOMException('Stems export cancelled', 'AbortError');
}

/** Renders the stems zip in a worker; see the file comment. */
export function exportStems(
  score: CompiledScore,
  mix: MixSettings,
  opts: ExportStemsOptions = {},
): Promise<ExportStemsResult> {
  return new Promise<ExportStemsResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const worker = new Worker(new URL('./stems.worker.ts', import.meta.url), { type: 'module' });
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | null = null;
    let settled = false;
    // Writes happen strictly in order, one at a time; each is acknowledged afterwards.
    let queue: Promise<void> = Promise.resolve();

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      opts.signal?.removeEventListener('abort', onAbort);
      const w = writer;
      writer = null;
      // Aborting the writable discards a half-written file; its own errors don't matter now.
      void (w ? w.abort(err).catch(() => undefined) : Promise.resolve());
      reject(err);
    };
    const onAbort = (): void => fail(abortError());
    opts.signal?.addEventListener('abort', onAbort);

    const { target, onProgress, onPlan, signal: _signal, timbres, ...options } = opts;
    void _signal;

    const start = async (): Promise<void> => {
      if (target) {
        const stream = 'createWritable' in target ? await target.createWritable() : target;
        writer = stream.getWriter();
      }
      if (settled) {
        void (writer as WritableStreamDefaultWriter | null)?.abort().catch(() => undefined);
        return;
      }
      worker.onmessage = (e: MessageEvent<StemsReply>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'plan':
            onPlan?.(msg.plan);
            break;
          case 'progress':
            onProgress?.(msg.progress);
            break;
          case 'chunk':
            queue = queue.then(async () => {
              if (settled) return;
              if (writer) await writer.write(msg.data);
              else parts.push(msg.data);
              worker.postMessage({
                type: 'ack',
                bytes: msg.data.byteLength,
              } satisfies StemsRequest);
            }, undefined);
            queue = queue.catch(fail);
            break;
          case 'done':
            queue = queue
              .then(async () => {
                if (settled) return;
                await writer?.close();
                writer = null;
                settled = true;
                worker.terminate();
                opts.signal?.removeEventListener('abort', onAbort);
                resolve({
                  ...msg.summary,
                  blob: target ? null : new Blob(parts, { type: 'application/zip' }),
                });
              })
              .catch(fail);
            break;
          case 'error':
            fail(new Error(msg.message));
            break;
        }
      };
      worker.onerror = (e) => fail(new Error(e.message || 'stems worker failed'));
      const flat = flatten(score);
      const request: StemsRequest = { type: 'start', score: flat, mix, timbres, options };
      worker.postMessage(request, transferList(flat));
    };
    start().catch(fail);
  });
}
