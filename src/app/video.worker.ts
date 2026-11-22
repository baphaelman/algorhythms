/**
 * Video export worker (PLAN.md §12): draws and encodes the frames (video-frames.ts) and posts the
 * encoded chunks to the page, which muxes them with the audio. The page acks each chunk once the
 * muxer has taken it; the worker stays at most `CREDIT` chunks ahead. Cancel: terminate.
 */

import { encodeFrames, type FrameJob } from './video-frames';
import type { Mp4Chunk, Mp4DecoderConfig } from '../video/mp4';

export type VideoWorkerRequest = { type: 'start'; job: FrameJob } | { type: 'ack'; count: number };

export type VideoWorkerReply =
  | { type: 'unsupported' }
  | { type: 'chunk'; chunk: Mp4Chunk; meta?: { decoderConfig?: Mp4DecoderConfig } }
  | { type: 'progress'; done: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** Chunks the worker may be ahead of the page's acks (about a second of frames). */
const CREDIT = 48;

let sent = 0;
let acked = 0;
let wake: (() => void) | null = null;

function reply(msg: VideoWorkerReply, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function canEncode(): boolean {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false;
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    return new OffscreenCanvas(1, 1).getContext('2d') !== null;
  } catch {
    return false;
  }
}

async function run(job: FrameJob): Promise<void> {
  await encodeFrames(job, {
    output(chunk, meta) {
      sent++;
      reply({ type: 'chunk', chunk, meta }, [chunk.data.buffer]);
    },
    async before() {
      while (sent - acked > CREDIT) await new Promise<void>((r) => (wake = r));
    },
    progress(done) {
      if (done % 4 === 0 || done === job.frames) reply({ type: 'progress', done });
    },
    aborted: () => false,
  });
}

self.onmessage = (e: MessageEvent<VideoWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'ack') {
    acked = msg.count;
    wake?.();
    wake = null;
    return;
  }
  if (!canEncode()) {
    reply({ type: 'unsupported' });
    return;
  }
  run(msg.job).then(
    () => reply({ type: 'done' }),
    (err: unknown) =>
      reply({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
};
