/**
 * Video export's frame loop (PLAN.md §12 "Video export"): frame k drawn with `drawVideoFrame` on
 * an OffscreenCanvas, wrapped in a VideoFrame at k / fps and encoded. Shared by the video worker
 * and the main-thread fallback (video-export.ts).
 */

import type { CompiledScore } from '../core/types';
import { drawVideoFrame, videoSize, type VideoFrameOptions } from '../render/video';
import { chunkFrom, type Mp4Chunk, type Mp4DecoderConfig } from '../video/mp4';

export interface FrameJob {
  compiled: CompiledScore;
  frame: VideoFrameOptions;
  fps: number;
  /** Frames to encode (0..frames − 1). */
  frames: number;
  config: VideoEncoderConfig;
  /** A key frame every this many frames. */
  keyEvery: number;
}

export interface FrameHooks {
  /** Each encoded chunk, in decode order. */
  output(chunk: Mp4Chunk, meta: { decoderConfig?: Mp4DecoderConfig } | undefined): void;
  /** Called before frame k is drawn; may wait (consumer backpressure, yielding). */
  before(k: number): void | Promise<void>;
  /** Frames handed to the encoder so far. */
  progress?(done: number): void;
  aborted(): boolean;
}

/** WebCodecs metadata reduced to what the muxer reads (plain, cloneable). */
export function plainMeta(meta?: {
  decoderConfig?: {
    codec?: string;
    description?: AllowSharedBufferSource;
    colorSpace?: VideoColorSpaceInit;
  };
}): { decoderConfig?: Mp4DecoderConfig } | undefined {
  const dc = meta?.decoderConfig;
  if (!dc) return undefined;
  const out: Mp4DecoderConfig = {};
  if (dc.codec) out.codec = dc.codec;
  if (dc.colorSpace) {
    const { primaries, transfer, matrix, fullRange } = dc.colorSpace;
    out.colorSpace = { primaries, transfer, matrix, fullRange };
  }
  if (dc.description) {
    const d = dc.description;
    const view = ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      : new Uint8Array(d);
    out.description = view.slice();
  }
  return { decoderConfig: out };
}

/** Resolves once the encoder's queue is below `max` (dequeue event, or polling without it). */
export async function drain(
  enc: { encodeQueueSize: number; addEventListener?: unknown },
  max: number,
): Promise<void> {
  while (enc.encodeQueueSize > max) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 4);
      const target = enc as unknown as EventTarget;
      if (typeof target.addEventListener === 'function') {
        target.addEventListener(
          'dequeue',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      }
    });
  }
}

export function abortError(): DOMException {
  return new DOMException('Video export cancelled', 'AbortError');
}

/** Draws and encodes every frame; resolves after the encoder is flushed and closed. */
export async function encodeFrames(job: FrameJob, hooks: FrameHooks): Promise<void> {
  const { width, height } = videoSize(job.frame.aspect, job.frame.size);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) throw new Error('Video export: this browser cannot draw on an OffscreenCanvas.');
  let failure: Error | null = null;
  const enc = new VideoEncoder({
    output: (c, meta) => hooks.output(chunkFrom(c), plainMeta(meta)),
    error: (e) => (failure = new Error(`Video encoder: ${e.message}`)),
  });
  try {
    enc.configure(job.config);
    const frameUs = 1e6 / job.fps;
    for (let k = 0; k < job.frames; k++) {
      if (hooks.aborted()) throw abortError();
      if (failure) throw failure;
      await hooks.before(k);
      await drain(enc, 2);
      if (failure) throw failure;
      drawVideoFrame(g, job.compiled, job.frame, k, job.fps);
      const ts = Math.round(k * frameUs);
      const frame = new VideoFrame(canvas, {
        timestamp: ts,
        duration: Math.round((k + 1) * frameUs) - ts,
      });
      try {
        enc.encode(frame, { keyFrame: k % job.keyEvery === 0 });
      } finally {
        frame.close();
      }
      hooks.progress?.(k + 1);
    }
    await enc.flush();
    if (failure) throw failure;
  } catch (e) {
    throw (failure as Error | null) ?? e;
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
}
