/**
 * Video export (PLAN.md §12 "Video export", revision 11): the WAV export's offline mix (48 kHz,
 * float, same samples) through `AudioEncoder`, frames drawn with `drawVideoFrame` through
 * `VideoEncoder` in a worker (main thread with yielding where a worker can't), both muxed by
 * `Mp4Muxer` into the caller's sink. The video lasts as long as that render (last frame held).
 *
 * Audio priming (measured with this pipeline, docs/build-log.md "M8-c"):
 * - Opus: priming 0 (no edit list; dOps keeps the pre-skip 312). Chromium's and Firefox's
 *   decodeAudioData then match the WAV to the sample, and so does ffmpeg 6.1 (it takes the dOps
 *   pre-skip without an edit list). With the edit list (ffmpeg's own muxing) ffmpeg is still
 *   exact but both browsers cut the pre-skip twice and hear the audio 6.5 ms early.
 * - AAC: the encoder's delay is measured once per codec (`codecDelay`: a noise burst through
 *   AudioEncoder → AudioDecoder, cross-correlated) and cut with the edit list.
 */

import { exportWavStream } from '../audio/export-client';
import { exportFrameCount } from '../audio/offline';
import { compile } from '../core/compiler/compile';
import type { CompiledScore, LineColors, Piece, Seconds } from '../core/types';
import { supportsOklch } from '../render/palettes';
import {
  drawVideoFrame,
  videoFrameCount,
  videoMarkers,
  videoSize,
  videoStyle,
  type VideoAspect,
  type VideoCameraMode,
  type VideoFrameOptions,
  type VideoSize,
} from '../render/video';
import { Mp4Muxer, chunkFrom, memorySink, type Mp4Sink } from '../video/mp4';
import { abortError, drain, encodeFrames, plainMeta, type FrameJob } from './video-frames';
import type { VideoWorkerReply, VideoWorkerRequest } from './video.worker';

export interface VideoOptions {
  aspect: VideoAspect;
  size: VideoSize;
  fps: 30 | 60;
  camera: VideoCameraMode;
  /** Follow: the editor's zoom window (s), as seen at 16:9. */
  window?: Seconds;
  theme: 'light' | 'dark';
  hud: boolean;
  thickness: boolean;
  /** @default 'pitch' */
  colors?: LineColors;
  /** Voice colours by pool index, for `colors: 'custom'`. */
  customColors?: readonly (string | undefined)[];
}

/** Where the MP4 goes. `positioned`: the sink takes positioned writes (streaming layout). */
export interface VideoSink extends Mp4Sink {
  positioned?: boolean;
  /** Called once after the last write. */
  close?(): Promise<void>;
  /** Called on cancel or failure. */
  abort?(): Promise<void>;
}

export type VideoPhase = 'audio' | 'video' | 'finishing';

export interface VideoHooks {
  onProgress?(fraction: number, phase: VideoPhase): void;
  signal?: AbortSignal;
  /** Tests: draw on the main thread even where a worker could. */
  mainThread?: boolean;
  /** Tests: audio priming (samples) instead of the measured / chosen one. */
  primingSamples?: number;
  /** Tests: force a codec (must be supported) instead of the first supported one. */
  codecs?: { video?: string; audio?: string };
}

export type VideoSupport =
  { ok: true; video: string; audio: string } | { ok: false; reason: string };

/** The audio's sample rate (AAC and Opus both at 48 kHz). */
export const VIDEO_SAMPLE_RATE = 48000;
export const AUDIO_BITRATE = 192_000;
const KEY_SECONDS = 2;

/** About 8 Mb/s at 1080p30, scaled by pixels, ×1.5 at 60 fps. */
export function videoBitrate(opts: Pick<VideoOptions, 'aspect' | 'size' | 'fps'>): number {
  const { width, height } = videoSize(opts.aspect, opts.size);
  return Math.round(((8e6 * width * height) / (1920 * 1080)) * (opts.fps === 60 ? 1.5 : 1));
}

/** Upper estimate of the file size (the encoders' bitrates plus ~2 % container). */
export function estimateVideoBytes(
  durationSeconds: number,
  opts: Pick<VideoOptions, 'aspect' | 'size' | 'fps'>,
): number {
  const bits = (videoBitrate(opts) + AUDIO_BITRATE) * Math.max(0, durationSeconds);
  return Math.ceil((bits / 8) * 1.02 + 4096);
}

// H.264 levels: [level_idc, max frame size (MBs), max MB rate (MB/s)] (Table A-1).
const AVC_LEVELS: [number, number, number][] = [
  [0x1f, 3600, 108000],
  [0x20, 5120, 216000],
  [0x28, 8192, 245760],
  [0x2a, 8704, 522240],
  [0x32, 22080, 589824],
  [0x33, 36864, 983040],
];
// VP9 levels: [level ×10, max picture size, max luma sample rate].
const VP9_LEVELS: [number, number, number][] = [
  [31, 983040, 36864000],
  [40, 2228224, 83558400],
  [41, 2228224, 160432128],
  [50, 8912896, 311951360],
  [51, 8912896, 588251136],
];

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Candidate codec strings, best first: H.264 High, Main, Baseline at the fitting level; VP9. */
export function videoCodecs(width: number, height: number, fps: number): string[] {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const avc = AVC_LEVELS.find(([, fs, rate]) => mbs <= fs && mbs * fps <= rate) ?? AVC_LEVELS[5];
  const luma = width * height;
  const vp9 = VP9_LEVELS.find(([, ps, rate]) => luma <= ps && luma * fps <= rate) ?? VP9_LEVELS[4];
  const lv = hex2(avc[0]);
  return [`avc1.6400${lv}`, `avc1.4d00${lv}`, `avc1.4200${lv}`, `vp09.00.${vp9[0]}.08`];
}

function videoConfig(codec: string, opts: VideoOptions): VideoEncoderConfig {
  const { width, height } = videoSize(opts.aspect, opts.size);
  return {
    codec,
    width,
    height,
    bitrate: videoBitrate(opts),
    framerate: opts.fps,
    latencyMode: 'quality',
    ...(codec.startsWith('avc') ? { avc: { format: 'avc' as const } } : {}),
  };
}

function audioConfig(codec: string): AudioEncoderConfig {
  return {
    codec,
    sampleRate: VIDEO_SAMPLE_RATE,
    numberOfChannels: 2,
    bitrate: AUDIO_BITRATE,
  };
}

async function supported(
  check: () => Promise<{ supported?: boolean }> | undefined,
): Promise<boolean> {
  try {
    return (await check())?.supported === true;
  } catch {
    return false;
  }
}

/** The codecs this browser would use, or why it can't export video. */
export async function videoSupport(
  opts: Pick<VideoOptions, 'aspect' | 'size' | 'fps'>,
): Promise<VideoSupport> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return {
      ok: false,
      reason:
        'This browser has no video encoder (WebCodecs), so it can’t make videos. A recent Chrome, Edge, Firefox or Safari can.',
    };
  }
  if (typeof AudioEncoder === 'undefined') {
    return {
      ok: false,
      reason:
        'This browser has no audio encoder (WebCodecs), so it can’t make videos. A recent Chrome, Edge, Firefox or Safari can.',
    };
  }
  if (typeof OffscreenCanvas === 'undefined') {
    return { ok: false, reason: 'This browser can’t draw video frames (no OffscreenCanvas).' };
  }
  const full = { ...opts, camera: 'follow', theme: 'light', hud: true, thickness: true } as const;
  const { width, height } = videoSize(opts.aspect, opts.size);
  let video: string | null = null;
  for (const codec of videoCodecs(width, height, opts.fps)) {
    if (await supported(() => VideoEncoder.isConfigSupported(videoConfig(codec, full)))) {
      video = codec;
      break;
    }
  }
  if (!video) {
    return {
      ok: false,
      reason: `This browser can’t encode H.264 or VP9 video at ${width}×${height}, ${opts.fps} fps. Try a smaller size or 30 fps.`,
    };
  }
  let audio: string | null = null;
  for (const codec of ['mp4a.40.2', 'opus']) {
    if (await supported(() => AudioEncoder.isConfigSupported(audioConfig(codec)))) {
      audio = codec;
      break;
    }
  }
  if (!audio) {
    return {
      ok: false,
      reason: 'This browser can’t encode AAC or Opus audio, so it can’t make videos.',
    };
  }
  return { ok: true, video, audio };
}

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------

/**
 * The mix as the WAV export renders it (48 kHz, 32-bit float: the same samples), as interleaved
 * stereo chunks of about a second. Aborting the signal stops the render worker.
 */
export async function* mixChunks(
  compiled: CompiledScore,
  piece: Piece,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
): AsyncGenerator<Float32Array<ArrayBuffer>> {
  const reader = exportWavStream({
    score: compiled,
    mix: piece.mix,
    timbres: piece.timbres,
    sampleRate: VIDEO_SAMPLE_RATE,
    bitDepth: 32,
    signal,
    onProgress,
  }).getReader();
  let header = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (header) {
        header = false; // the worker sends the WAV header as its own first chunk
        continue;
      }
      yield new Float32Array(value.buffer, value.byteOffset, value.byteLength >> 2);
    }
  } finally {
    reader.releaseLock();
  }
}

/** The whole mix as [left, right] (tests compare the MP4's audio with it). */
export async function renderMix(piece: Piece): Promise<[Float32Array, Float32Array]> {
  const compiled = compile(piece);
  const frames = exportFrameCount(compiled, piece.mix, VIDEO_SAMPLE_RATE);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  let at = 0;
  for await (const c of mixChunks(compiled, piece, new AbortController().signal)) {
    for (let i = 0; i < c.length; i += 2, at++) {
      l[at] = c[i];
      r[at] = c[i + 1];
    }
  }
  return [l, r];
}

const delays = new Map<string, Promise<number>>();

/**
 * The encoder's delay in samples beyond what its chunk timestamps say: a noise burst encoded,
 * decoded with WebCodecs and cross-correlated with the input. Cached per codec.
 */
export function codecDelay(codec: string): Promise<number> {
  let p = delays.get(codec);
  if (!p) {
    p = measureDelay(codec);
    delays.set(codec, p);
  }
  return p;
}

async function measureDelay(codec: string): Promise<number> {
  const sr = VIDEO_SAMPLE_RATE;
  const n = sr / 2;
  const burstAt = 4800;
  const burst = 2400;
  const input = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < burst; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    input[burstAt + i] = ((s >>> 8) / 0x800000 - 1) * 0.5;
  }
  const chunks: { c: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
  let failed: unknown = null;
  const enc = new AudioEncoder({
    output: (c, meta) => chunks.push({ c, meta }),
    error: (e) => (failed = e),
  });
  enc.configure(audioConfig(codec));
  const block = 1024;
  for (let at = 0; at < n; at += block) {
    const m = Math.min(block, n - at);
    const data = new Float32Array(m * 2);
    for (let i = 0; i < m; i++) data[2 * i] = data[2 * i + 1] = input[at + i];
    const ad = new AudioData({
      format: 'f32',
      sampleRate: sr,
      numberOfChannels: 2,
      numberOfFrames: m,
      timestamp: Math.round((at * 1e6) / sr),
      data,
    });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
  const dc = chunks.find((x) => x.meta?.decoderConfig)?.meta?.decoderConfig;
  const out = new Float32Array(n + 8192);
  const dec = new AudioDecoder({
    output: (d) => {
      const m = d.numberOfFrames;
      const tmp = new Float32Array(m);
      d.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
      const start = Math.round((d.timestamp * sr) / 1e6);
      for (let i = 0; i < m; i++) {
        const j = start + i;
        if (j >= 0 && j < out.length) out[j] = tmp[i];
      }
      d.close();
    },
    error: (e) => (failed = e),
  });
  dec.configure({
    codec,
    sampleRate: sr,
    numberOfChannels: 2,
    ...(dc?.description ? { description: dc.description } : {}),
  });
  for (const { c } of chunks) dec.decode(c);
  await dec.flush();
  dec.close();
  if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
  return xcorrLag(input, out, -2048, 4096);
}

/** The lag (samples, in [lo, hi]) at which `b` best matches `a` delayed. */
export function xcorrLag(a: Float32Array, b: Float32Array, lo: number, hi: number): number {
  let best = 0;
  let bestV = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    let v = 0;
    const from = Math.max(0, -lag);
    const to = Math.min(a.length, b.length - lag);
    for (let i = from; i < to; i++) v += a[i] * b[i + lag];
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

/** The frame options for `drawVideoFrame` (tests draw reference frames with these). */
export function frameOptions(piece: Piece, opts: VideoOptions): VideoFrameOptions {
  const style = videoStyle({
    theme: opts.theme,
    hud: opts.hud,
    thickness: opts.thickness,
    colors: opts.colors,
    customColors: opts.customColors,
    oklch: supportsOklch(),
    ...videoMarkers(piece),
  });
  const o: VideoFrameOptions = { aspect: opts.aspect, size: opts.size, camera: opts.camera, style };
  if (opts.window !== undefined) o.window = opts.window;
  return o;
}

/** Frame k as the export draws it, on the main thread (tests). */
export function referenceFrame(piece: Piece, opts: VideoOptions, k: number): ImageData {
  const { width, height } = videoSize(opts.aspect, opts.size);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: false })!;
  drawVideoFrame(g, compile(piece), frameOptions(piece, opts), k, opts.fps);
  return g.getImageData(0, 0, width, height);
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/** An in-memory sink (faststart layout) with the result as a Blob. */
export function blobSink(): VideoSink & { blob(): Blob; size: number } {
  const m = memorySink();
  return {
    write: (b, p) => m.write(b, p),
    get size() {
      return m.size;
    },
    blob: () => new Blob(m.parts as BlobPart[], { type: 'video/mp4' }),
  };
}

/** A File System Access writable (streaming layout: positioned write for the mdat size). */
export function fileSink(w: FileSystemWritableFileStream): VideoSink {
  return {
    positioned: true,
    write: (data, position) =>
      position === undefined
        ? w.write(data as Uint8Array<ArrayBuffer>)
        : w.write({ type: 'write', position, data: data as Uint8Array<ArrayBuffer> }),
    close: () => w.close(),
    abort: () => w.abort(),
  };
}

/** What a finished export reports. */
export interface VideoResult {
  video: string;
  audio: string;
  frames: number;
  /** The audio's length (the WAV render's), s. */
  duration: number;
  /** Where the frames were drawn. */
  thread: 'worker' | 'main';
  primingSamples: number;
}

/** Yields to the event loop (main-thread fallback: keeps the page responsive). */
const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Exports `piece` as an MP4 into `sink`. Rejects with an AbortError when `signal` aborts (within
 * a frame or an audio chunk), or with a readable Error when the browser or an encoder fails.
 */
export async function exportVideo(
  piece: Piece,
  opts: VideoOptions,
  sink: VideoSink,
  hooks: VideoHooks = {},
): Promise<VideoResult> {
  const outer = hooks.signal;
  if (outer?.aborted) throw abortError();
  const support = await videoSupport(opts);
  if (!support.ok) throw new Error(support.reason);
  const videoCodec = hooks.codecs?.video ?? support.video;
  const audioCodec = hooks.codecs?.audio ?? support.audio;
  const priming =
    hooks.primingSamples ??
    (audioCodec.startsWith('mp4a') ? Math.max(0, await codecDelay(audioCodec)) : 0);
  if (outer?.aborted) throw abortError();

  const compiled = compile(piece);
  const sr = VIDEO_SAMPLE_RATE;
  const audioFrames = exportFrameCount(compiled, piece.mix, sr);
  const duration = audioFrames / sr;
  const frames = videoFrameCount(duration, opts.fps);
  const { width, height } = videoSize(opts.aspect, opts.size);

  const stop = new AbortController();
  let failure: unknown = null;
  const fail = (e: unknown) => {
    if (failure === null) failure = e;
    stop.abort();
  };
  const onAbort = () => fail(abortError());
  outer?.addEventListener('abort', onAbort);
  const stopped = new Promise<never>((_, reject) =>
    stop.signal.addEventListener('abort', () => reject(failure as Error)),
  );
  stopped.catch(() => undefined);

  const muxer = new Mp4Muxer({
    layout: sink.positioned ? 'streaming' : 'faststart',
    sink,
    video: { codec: videoCodec, width, height, frameRate: opts.fps },
    audio: { codec: audioCodec, sampleRate: sr, numberOfChannels: 2, primingSamples: priming },
  });
  const muxed = (p: Promise<void>) => p.catch(fail);

  let audioFrac = 0;
  let videoDone = 0;
  const report = (phase: VideoPhase) =>
    hooks.onProgress?.(Math.min(1, 0.1 * audioFrac + (0.88 * videoDone) / frames), phase);

  // Audio: the mix render, encoded as it arrives.
  const audioTask = async () => {
    let encErr: Error | null = null;
    const enc = new AudioEncoder({
      output: (c, meta) => void muxed(muxer.addAudioChunk(chunkFrom(c), plainMeta(meta))),
      error: (e) => fail((encErr = new Error(`Audio encoder: ${e.message}`))),
    });
    stop.signal.addEventListener('abort', () => enc.state !== 'closed' && enc.close());
    try {
      enc.configure(audioConfig(audioCodec));
      let sent = 0;
      for await (const data of mixChunks(compiled, piece, stop.signal, (f) => {
        audioFrac = f;
        report(videoDone < frames ? 'video' : 'audio');
      })) {
        if (stop.signal.aborted) return;
        const n = data.length >> 1;
        const ad = new AudioData({
          format: 'f32',
          sampleRate: sr,
          numberOfChannels: 2,
          numberOfFrames: n,
          timestamp: Math.round((sent * 1e6) / sr),
          data,
        });
        enc.encode(ad);
        ad.close();
        sent += n;
        await drain(enc, 4);
      }
      await enc.flush();
      if (encErr) throw encErr;
    } finally {
      if (enc.state !== 'closed') enc.close();
    }
  };

  const job: FrameJob = {
    compiled,
    frame: frameOptions(piece, opts),
    fps: opts.fps,
    frames,
    config: videoConfig(videoCodec, opts),
    keyEvery: KEY_SECONDS * opts.fps,
  };
  let thread: 'worker' | 'main' = 'worker';

  const mainFrames = () => {
    thread = 'main';
    return encodeFrames(job, {
      output: (chunk, meta) => void muxed(muxer.addVideoChunk(chunk, meta)),
      before: (k) => (k % 2 === 0 ? yieldTask() : undefined),
      progress: (done) => {
        videoDone = done;
        report('video');
      },
      aborted: () => stop.signal.aborted,
    });
  };

  const workerFrames = () =>
    new Promise<void>((resolve, reject) => {
      let w: Worker;
      try {
        w = new Worker(new URL('./video.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        mainFrames().then(resolve, reject);
        return;
      }
      let count = 0;
      let received = false;
      const end = () => w.terminate();
      stop.signal.addEventListener('abort', end);
      w.onmessage = (e: MessageEvent<VideoWorkerReply>) => {
        const msg = e.data;
        switch (msg.type) {
          case 'unsupported':
            end();
            mainFrames().then(resolve, reject);
            break;
          case 'chunk':
            received = true;
            void muxed(
              muxer.addVideoChunk(msg.chunk, msg.meta).then(() => {
                count++;
                w.postMessage({ type: 'ack', count } satisfies VideoWorkerRequest);
              }),
            );
            break;
          case 'progress':
            videoDone = msg.done;
            report('video');
            break;
          case 'done':
            end();
            resolve();
            break;
          case 'error':
            end();
            // Failed before its first chunk (a browser whose worker can't draw or encode what
            // the page can): the page tries itself. A real encoder error fails there again.
            if (!received) mainFrames().then(resolve, reject);
            else reject(new Error(msg.message));
            break;
        }
      };
      w.onerror = (e) => {
        end();
        if (!received) mainFrames().then(resolve, reject);
        else reject(new Error(e.message || 'Video export: the frame worker failed.'));
      };
      w.postMessage({ type: 'start', job } satisfies VideoWorkerRequest);
    });

  try {
    const tasks = Promise.all([audioTask(), hooks.mainThread ? mainFrames() : workerFrames()]);
    await Promise.race([tasks.catch((e: unknown) => fail(e)), stopped]);
    if (failure) throw failure;
    hooks.onProgress?.(0.98, 'finishing');
    await Promise.race([muxer.finish(), stopped]);
    if (failure) throw failure;
    await sink.close?.();
    hooks.onProgress?.(1, 'finishing');
    return {
      video: videoCodec,
      audio: audioCodec,
      frames,
      duration,
      thread,
      primingSamples: priming,
    };
  } catch (e) {
    stop.abort();
    await sink.abort?.().catch(() => undefined);
    throw (failure as unknown) ?? e;
  } finally {
    outer?.removeEventListener('abort', onAbort);
    if (!stop.signal.aborted) stop.abort();
  }
}
