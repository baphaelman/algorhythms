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
import { spanFrames, type ExportLoudness, type WavSpan } from '../audio/wav-export';
import { compile } from '../core/compiler/compile';
import type {
  CameraFrame,
  CameraKey,
  CompiledScore,
  LineColors,
  Piece,
  PosterCameraKey,
  RowBreak,
  Seconds,
} from '../core/types';
import { autoCameraKeys } from '../render/auto-camera';
import { pieceLook, type Look } from '../render/look';
import { supportsOklch } from '../render/palettes';
import { drawScore, hudPlacement, type Ctx2D } from '../render/draw';
import type { HudPlacement } from '../render/hud';
import type { CameraState } from '../render/types';
import { resetContext } from '../render/poster';
import { posterVoiceColors, type PosterLayout } from '../render/poster-layout';
import { isWholeSpan, type TimeSpan } from '../render/section';
import {
  bookendsAt,
  bookendsOn,
  drawVideoFrame,
  drawVideoFrameAt,
  drawThumbnail,
  drawVideoMoment,
  thumbnailSize,
  VIDEO_RATIO,
  videoCamera,
  videoLength,
  videoFrameCount,
  videoLayout,
  videoMarkers,
  videoSize,
  videoSpan,
  videoStyle,
  type VideoAspect,
  type VideoBookends,
  type VideoCameraMode,
  type VideoFrameOptions,
  type VideoSize,
} from '../render/video';
import { Mp4Muxer, chunkFrom, memorySink, type Mp4Sink } from '../video/mp4';
import { abortError, drain, encodeFrames, plainMeta, type FrameJob } from './video-frames';
import type { PosterOptions } from './poster-export';
import type { VideoWorkerReply, VideoWorkerRequest } from './video.worker';

export interface VideoOptions {
  aspect: VideoAspect;
  size: VideoSize;
  fps: 30 | 60;
  camera: VideoCameraMode;
  /** Follow: the editor's zoom window (s), as seen at 16:9. */
  window?: Seconds;
  /** Follow: the playhead's place across the frame, 0..1. @default 0.35 */
  followAt?: number;
  /**
   * `keys`/`auto`: the camera keys (M11.5). @default Keys: the piece's (`piece.camera.keys`;
   * none = Follow); Auto: made from the piece (`autoCameraKeys`, for the section and aspect).
   */
  keys?: readonly CameraKey[];
  theme: 'light' | 'dark';
  hud: boolean;
  thickness: boolean;
  /** Target bitrate (§12 "Ready for YouTube"). @default 'high' (YouTube's upload rates) */
  quality?: VideoQuality;
  /** @default 'pitch' */
  colors?: LineColors;
  /** Voice colours by pool index, for `colors: 'custom'`. */
  customColors?: readonly (string | undefined)[];
  /** The export Look (§12); replaces theme, hud, thickness and colors when given. */
  look?: Look;
  /**
   * The section exported (§12 rev 15): the video starts at its start and lasts its length; the
   * audio is the mix's render of that span with fades at the cuts. Absent = the whole piece.
   */
  section?: TimeSpan;
  /** Loudness normalisation of the audio (§12 "Ready for YouTube"). @default 'off' */
  loudness?: ExportLoudness;
  /**
   * Opening and ending (§12 "Ready for YouTube"): fades, lead-in, title card, end card. The
   * lead-in delays the audio; silence pads it to the end card's end. Absent = none.
   */
  bookends?: VideoBookends;
  /** M15: Over the poster or One row. @default the piece's (`pieceVideoFrame`) */
  frame?: CameraFrame;
  /** M15, Over the poster. @default the piece's (`pieceRowBreak`) */
  rowBreak?: RowBreak;
  /** M15: the playhead line (the slice over the poster). @default the Look's `playhead` */
  playhead?: boolean;
  /** M15, Over the poster with camera `keys`. @default the piece's `camera.posterKeys` */
  posterKeys?: readonly PosterCameraKey[];
  /**
   * M15: the poster the video plays, already laid out (the workspace's). Wins over `poster`.
   */
  posterLayout?: PosterLayout;
  /**
   * M15: the viewer's remembered poster options, to lay the poster out with (`posterLayoutOf`)
   * when `posterLayout` is absent. @default the video's theme and Look, the piece's poster
   */
  poster?: PosterOptions;
}

/**
 * The audio span of a video section (`WavSpan`), or undefined for the whole piece. A section
 * ending at the piece's end keeps the ring-out, as the whole video does.
 */
export function videoAudioSpan(duration: Seconds, section?: TimeSpan): WavSpan | undefined {
  if (!section || isWholeSpan(section, duration)) return undefined;
  const span = videoSpan(duration, section);
  return span.end >= duration - 1e-3 ? { start: span.start } : { start: span.start, end: span.end };
}

/** Audio frames (at VIDEO_SAMPLE_RATE) of a video export: the WAV render's, or its section's. */
export function videoAudioFrames(
  compiled: CompiledScore,
  mix: Piece['mix'],
  section?: TimeSpan,
): number {
  const all = exportFrameCount(compiled, mix, VIDEO_SAMPLE_RATE);
  const { from, to } = spanFrames(
    all,
    VIDEO_SAMPLE_RATE,
    videoAudioSpan(compiled.duration, section),
  );
  return to - from;
}

/**
 * A video's audio, in samples at VIDEO_SAMPLE_RATE, with its opening and ending: `lead` silent
 * samples (the lead-in, rounded to a sample), the `music` (the section's render), then silence
 * to `total` (the end card's end, when later than the music).
 */
export interface VideoTimeline {
  lead: number;
  music: number;
  total: number;
  /** The bookends as drawn (the lead-in on a whole sample), or undefined when all are off. */
  bookends?: VideoBookends;
}

/** The timeline of a video export (see `VideoTimeline`). */
export function videoTimeline(
  compiled: CompiledScore,
  mix: Piece['mix'],
  opts: Pick<VideoOptions, 'section' | 'bookends'>,
): VideoTimeline {
  const sr = VIDEO_SAMPLE_RATE;
  const music = videoAudioFrames(compiled, mix, opts.section);
  const b = opts.bookends;
  if (!bookendsOn(b)) return { lead: 0, music, total: music };
  const lead = Math.round(Math.max(0, Number.isFinite(b.leadIn) ? (b.leadIn ?? 0) : 0) * sr);
  const bookends: VideoBookends = { ...b, leadIn: lead / sr };
  const span = videoSpan(compiled.duration, opts.section);
  const len = videoLength(bookends, span.end - span.start, music / sr);
  return { lead, music, total: Math.max(lead + music, Math.ceil(len * sr - 1e-6)), bookends };
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
  /** `eta`: estimated seconds left, once the frame rate is known (`videoEta`). */
  onProgress?(fraction: number, phase: VideoPhase, eta?: number): void;
  signal?: AbortSignal;
  /** Tests: draw on the main thread even where a worker could. */
  mainThread?: boolean;
  /** Tests: audio priming (samples) instead of the measured / chosen one. */
  primingSamples?: number;
  /** Tests: force a codec (must be supported) instead of the first supported one. */
  codecs?: { video?: string; audio?: string };
  /** Tests: fields laid over the video encoder's config. */
  config?: Partial<VideoEncoderConfig>;
  /** Tests: the clock (ms) for the time-left estimate. @default performance.now */
  now?: () => number;
}

/**
 * `aac`: whether this browser can encode AAC-LC (`audio` is Opus when it can't; the dialog says
 * so in one line).
 */
export type VideoSupport =
  { ok: true; video: string; audio: string; aac: boolean } | { ok: false; reason: string };

/** The audio's sample rate (AAC and Opus both at 48 kHz). */
export const VIDEO_SAMPLE_RATE = 48000;
export const AUDIO_BITRATE = 192_000;
/**
 * The video's true-peak ceiling when normalising (dBTP), by audio codec: below the WAV's −1,
 * because lossy encoders overshoot it. Crease at −14 LUFS, decoded: AAC −0.90 dBTP from a −1
 * ceiling, −1.41 from −1.5; Opus −0.91 from −1.5.
 */
export function videoLoudnessCeiling(audioCodec: string): number {
  return audioCodec.startsWith('opus') ? -2 : -1.5;
}
/**
 * A key frame every half second: YouTube's upload recommendation ("closed GOP, half the frame
 * rate"). It also lifts the delivered bitrate 10–27 % (build log "M11 Y3"): no encoder here
 * spends the target on line art, whatever its rate-control mode.
 */
const KEY_SECONDS = 0.5;

export type VideoQuality = 'standard' | 'high' | 'max';

/** Target bitrate × High's, per quality. */
export const QUALITY_SCALE: Record<VideoQuality, number> = { standard: 0.6, high: 1, max: 1.5 };

/**
 * High's bitrate (b/s) for a 16:9 frame of each size class at [30, 60] fps: YouTube's recommended
 * upload rates (SDR); 720p is 1080p's scaled by pixels, as before M11.
 */
export const HIGH_BITRATES: Record<VideoSize, readonly [number, number]> = {
  '720': [(8e6 * 4) / 9, (12e6 * 4) / 9],
  '1080': [8e6, 12e6],
  '1440': [16e6, 24e6],
  '2160': [45e6, 68e6],
};

type BitrateOpts = Pick<VideoOptions, 'aspect' | 'size' | 'fps' | 'quality'>;

/**
 * The target video bitrate: High's rate for the size class and fps, scaled by the frame's pixels
 * against the class's 16:9 frame (9:16 the same, 1:1 9/16 of it), × the quality's scale.
 */
export function videoBitrate(opts: BitrateOpts): number {
  const { width, height } = videoSize(opts.aspect, opts.size);
  const wide = videoSize('16:9', opts.size);
  const high = HIGH_BITRATES[opts.size][opts.fps === 60 ? 1 : 0];
  const scale = QUALITY_SCALE[opts.quality ?? 'high'];
  return Math.round((high * width * height * scale) / (wide.width * wide.height));
}

/** Upper estimate of the file size (the encoders' bitrates plus ~2 % container). */
export function estimateVideoBytes(durationSeconds: number, opts: BitrateOpts): number {
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
  [0x34, 36864, 2073600],
];
// VP9 levels: [level ×10, max picture size, max luma sample rate].
const VP9_LEVELS: [number, number, number][] = [
  [31, 983040, 36864000],
  [40, 2228224, 83558400],
  [41, 2228224, 160432128],
  [50, 8912896, 311951360],
  [51, 8912896, 588251136],
  [52, 8912896, 1176502272],
];

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Candidate codec strings, best first: H.264 High, Main, Baseline at the fitting level; VP9. */
export function videoCodecs(width: number, height: number, fps: number): string[] {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const avc =
    AVC_LEVELS.find(([, fs, rate]) => mbs <= fs && mbs * fps <= rate) ??
    AVC_LEVELS[AVC_LEVELS.length - 1];
  const luma = width * height;
  const vp9 =
    VP9_LEVELS.find(([, ps, rate]) => luma <= ps && luma * fps <= rate) ??
    VP9_LEVELS[VP9_LEVELS.length - 1];
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

/** Every size class, small to large (the dialog offers those `videoSizes` accepts). */
export const VIDEO_SIZE_CLASSES: readonly VideoSize[] = ['720', '1080', '1440', '2160'];

/**
 * The size classes this browser can encode at this aspect and fps (`videoSupport` ok: H.264 at
 * its level, else VP9), small to large.
 */
export async function videoSizes(
  opts: Pick<VideoOptions, 'aspect' | 'fps' | 'quality'>,
): Promise<VideoSize[]> {
  const ok = await Promise.all(
    VIDEO_SIZE_CLASSES.map(async (size) => (await videoSupport({ ...opts, size })).ok),
  );
  return VIDEO_SIZE_CLASSES.filter((_, i) => ok[i]);
}

/** Audio codecs, best first: AAC-LC (plays everywhere), then Opus. */
export const AUDIO_CODECS = ['mp4a.40.2', 'opus'] as const;

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
export async function videoSupport(opts: BitrateOpts): Promise<VideoSupport> {
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
  for (const codec of AUDIO_CODECS) {
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
  return { ok: true, video, audio, aac: audio === AUDIO_CODECS[0] };
}

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------

/**
 * The mix as the WAV export renders it (48 kHz, 32-bit float: the same samples), as interleaved
 * stereo chunks of about a second; with a span, only that span (`WavSpan`); normalised with
 * `loudness` (only after the whole render, then all at once). Aborting the signal
 * stops the render worker.
 */
export async function* mixChunks(
  compiled: CompiledScore,
  piece: Piece,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
  span?: WavSpan,
  loudness: ExportLoudness = 'off',
  ceiling?: number,
): AsyncGenerator<Float32Array<ArrayBuffer>> {
  const reader = exportWavStream({
    score: compiled,
    mix: piece.mix,
    timbres: piece.timbres,
    sampleRate: VIDEO_SAMPLE_RATE,
    bitDepth: 32,
    signal,
    onProgress,
    ...(span ? { span } : {}),
    loudness,
    ...(ceiling !== undefined ? { ceiling } : {}),
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

/**
 * The whole mix as [left, right], or a section's audio as the video exports it (tests compare the
 * MP4's audio with it).
 */
export async function renderMix(
  piece: Piece,
  section?: TimeSpan,
  loudness: ExportLoudness = 'off',
  bookends?: VideoBookends,
): Promise<[Float32Array, Float32Array]> {
  const compiled = compile(piece);
  const tl = videoTimeline(compiled, piece.mix, { section, bookends });
  const span = videoAudioSpan(compiled.duration, section);
  const l = new Float32Array(tl.total);
  const r = new Float32Array(tl.total);
  let at = tl.lead;
  const signal = new AbortController().signal;
  for await (const c of mixChunks(compiled, piece, signal, undefined, span, loudness)) {
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
export function frameOptions(
  piece: Piece,
  opts: VideoOptions,
  compiled?: CompiledScore,
): VideoFrameOptions {
  const style = videoStyle({
    theme: opts.theme,
    hud: opts.hud,
    thickness: opts.thickness,
    colors: opts.colors,
    customColors: opts.customColors,
    oklch: supportsOklch(),
    ...videoMarkers(piece),
    ...(opts.look ? { look: opts.look, ...pieceLook(piece) } : {}),
  });
  // A poster layer's colour shows in the video too (M14, owner); its place and size don't.
  const voiceColors = posterVoiceColors(piece.poster, piece.voices);
  if (voiceColors) style.voiceColors = voiceColors;
  const o: VideoFrameOptions = { aspect: opts.aspect, size: opts.size, camera: opts.camera, style };
  if (opts.window !== undefined) o.window = opts.window;
  if (opts.followAt !== undefined) o.followAt = opts.followAt;
  if (opts.section) o.section = opts.section;
  if (opts.camera === 'keys') {
    const keys = opts.keys ?? piece.camera?.keys;
    if (keys && keys.length > 0) o.keys = keys;
  } else if (opts.camera === 'auto') {
    o.keys = opts.keys ?? videoAutoKeys((compiled ??= compile(piece)), opts);
  }
  if (bookendsOn(opts.bookends)) {
    const tl = videoTimeline(compiled ?? compile(piece), piece.mix, opts);
    if (tl.bookends) o.bookends = tl.bookends;
    o.length = tl.total / VIDEO_SAMPLE_RATE;
  }
  return o;
}

/** The Auto camera's keys for a video: its section (when not the whole piece) and aspect. */
export function videoAutoKeys(compiled: CompiledScore, opts: VideoOptions): readonly CameraKey[] {
  const span =
    opts.section && !isWholeSpan(opts.section, compiled.duration) ? opts.section : undefined;
  return autoCameraKeys(compiled, { aspect: VIDEO_RATIO[opts.aspect], ...(span ? { span } : {}) });
}

/**
 * The Export dialog's preview of a video with an opening and ending: the frame at video time τ
 * (lead-in, title card, end card and fades included) as the export draws it. The HUD's boxes
 * are the music frame's (none once the end card has taken over).
 */
export function previewVideoMoment(
  ctx: Ctx2D,
  piece: Piece,
  compiled: CompiledScore,
  opts: VideoOptions,
  tau: Seconds,
  scale: number,
): HudPlacement {
  resetContext(ctx);
  const fo = frameOptions(piece, opts, compiled);
  const view = drawVideoMoment(ctx, compiled, fo, tau, scale);
  const st = bookendsAt(fo.bookends, videoSpan(compiled.duration, fo.section), tau, fo.length);
  const place = hudPlacement(ctx, compiled, fo.style, view);
  return st.end >= 1 ? { ...place, boxes: [] } : place;
}

/** Frame k as the export draws it, on the main thread (tests). */
export function referenceFrame(piece: Piece, opts: VideoOptions, k: number): ImageData {
  const { width, height } = videoSize(opts.aspect, opts.size);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: false })!;
  const compiled = compile(piece);
  drawVideoFrame(g, compiled, frameOptions(piece, opts, compiled), k, opts.fps);
  return g.getImageData(0, 0, width, height);
}

/**
 * The Export dialog's preview: the frame at score time t as the export draws it, on a canvas
 * `scale` times the video's pixel size (fresh context state, as on a new canvas).
 */
export function previewVideoFrame(
  ctx: Ctx2D,
  piece: Piece,
  compiled: CompiledScore,
  opts: VideoOptions,
  t: Seconds,
  scale: number,
): HudPlacement {
  resetContext(ctx);
  const fo = frameOptions(piece, opts, compiled);
  const view = drawVideoFrameAt(ctx, compiled, fo, t, scale);
  return hudPlacement(ctx, compiled, fo.style, view);
}

/**
 * The camera of the frame at score time t (clamped to the section), as the export draws it: what
 * the dialog's preview shows, for "add a key from this view".
 */
export function videoCameraAt(
  piece: Piece,
  compiled: CompiledScore,
  opts: VideoOptions,
  t: Seconds,
): CameraState {
  const fo = frameOptions(piece, opts);
  const span = videoSpan(compiled.duration, fo.section);
  return videoCamera(fo.camera, compiled, Math.min(Math.max(span.start, t), span.end), fo);
}

/**
 * Tests: the frame at t drawn by `drawScore` directly (the same camera, style and layout) on a
 * fresh canvas `width` x `height` pixels, `scale` times the video's, to compare with the preview.
 */
export function referenceFrameAt(
  piece: Piece,
  opts: VideoOptions,
  t: Seconds,
  scale: number,
  width: number,
  height: number,
): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  const compiled = compile(piece);
  const fo = frameOptions(piece, opts);
  const lay = videoLayout(opts.aspect, opts.size);
  const span = videoSpan(compiled.duration, fo.section);
  const tc = Math.min(Math.max(span.start, t), span.end);
  const cam = videoCamera(fo.camera, compiled, tc, fo);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.textAlign = 'left';
  drawScore(g, compiled, cam, fo.style, tc, lay, lay.dpr * scale);
  return g.getImageData(0, 0, width, height);
}

// ---------------------------------------------------------------------------------------------
// Thumbnail
// ---------------------------------------------------------------------------------------------

/** YouTube's thumbnail limit, bytes (2 MB; decimal, the stricter reading). */
export const THUMBNAIL_MAX_BYTES = 2_000_000;
/** JPEG qualities tried in turn until the file fits. */
export const THUMBNAIL_QUALITIES = [0.92, 0.85, 0.75, 0.65, 0.5, 0.35] as const;

/**
 * A thumbnail JPEG (§12 "Ready for YouTube"): `thumbnailSize` pixels, the frame at score time
 * `at` or the whole-piece view, the title large (default: the title card's, else the piece's
 * name). The quality steps down until it is under THUMBNAIL_MAX_BYTES.
 */
export async function exportThumbnail(
  piece: Piece,
  opts: VideoOptions,
  at: Seconds | 'whole',
  title?: { text: string; subtitle?: string },
): Promise<Blob> {
  const { width, height } = thumbnailSize(opts.aspect);
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: false })!;
  const compiled = compile(piece);
  const fo = frameOptions(piece, opts, compiled);
  resetContext(g);
  drawThumbnail(g, compiled, fo, {
    at,
    title: title ?? opts.bookends?.title ?? { text: piece.meta.title },
  });
  let blob: Blob | null = null;
  for (const quality of THUMBNAIL_QUALITIES) {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size < THUMBNAIL_MAX_BYTES) return blob;
  }
  return blob!;
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
  /** The encoded video's bytes (the chunks'), and its average bitrate (b/s) over `frames`. */
  videoBytes: number;
  videoBitrate: number;
  /** The target bitrate the encoder was given (b/s). */
  targetBitrate: number;
}

/**
 * Seconds left of an export that has drawn and encoded `done` of `total` frames in `elapsed`
 * seconds, at its average rate so far; undefined until there is a rate worth quoting (1 s and
 * 10 frames). Frames are most of the work; the audio renders alongside them.
 */
export function videoEta(done: number, total: number, elapsed: number): number | undefined {
  if (elapsed < 1 || done < 10 || done > total) return undefined;
  return ((total - done) * elapsed) / done;
}

/** "About 3 min left" / "About 40 s left" / "A few seconds left" for an ETA in seconds. */
export function etaText(seconds: number): string {
  if (seconds < 10) return 'A few seconds left';
  if (seconds < 60) return `About ${Math.round(seconds / 10) * 10} s left`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `About ${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `About ${h} h${m ? ` ${m} min` : ''} left`;
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
  const audioSpan = videoAudioSpan(compiled.duration, opts.section);
  const timeline = videoTimeline(compiled, piece.mix, opts);
  const audioFrames = timeline.total;
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
    // The audio's own length: the encoders' flush padding (AAC: up to a packet or two past it)
    // would otherwise make the video up to ~40 ms longer than the render.
    audio: {
      codec: audioCodec,
      sampleRate: sr,
      numberOfChannels: 2,
      primingSamples: priming,
      length: audioFrames,
    },
  });
  const muxed = (p: Promise<void>) => p.catch(fail);

  let audioFrac = 0;
  let videoDone = 0;
  let videoBytes = 0;
  const now = hooks.now ?? (() => performance.now());
  const started = now();
  const report = (phase: VideoPhase) =>
    hooks.onProgress?.(
      Math.min(1, 0.1 * audioFrac + (0.88 * videoDone) / frames),
      phase,
      videoEta(videoDone, frames, (now() - started) / 1000),
    );

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
      const onAudio = (f: number) => {
        audioFrac = f;
        report(videoDone < frames ? 'video' : 'audio');
      };
      const send = async (data: Float32Array<ArrayBuffer>) => {
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
      };
      // Silence: the lead-in before the music, the end card after it.
      const silence = async (until: number) => {
        while (sent < until && !stop.signal.aborted) {
          await send(new Float32Array(2 * Math.min(sr, until - sent)));
        }
      };
      await silence(timeline.lead);
      for await (const data of mixChunks(
        compiled,
        piece,
        stop.signal,
        onAudio,
        audioSpan,
        opts.loudness,
        videoLoudnessCeiling(audioCodec),
      )) {
        if (stop.signal.aborted) return;
        await send(data);
      }
      await silence(timeline.total);
      if (stop.signal.aborted) return;
      await enc.flush();
      if (encErr) throw encErr;
    } finally {
      if (enc.state !== 'closed') enc.close();
    }
  };

  const job: FrameJob = {
    compiled,
    frame: frameOptions(piece, opts, compiled),
    fps: opts.fps,
    frames,
    config: { ...videoConfig(videoCodec, opts), ...hooks.config },
    keyEvery: Math.round(KEY_SECONDS * opts.fps),
  };
  let thread: 'worker' | 'main' = 'worker';

  const mainFrames = () => {
    thread = 'main';
    return encodeFrames(job, {
      output: (chunk, meta) => {
        videoBytes += chunk.data.byteLength;
        void muxed(muxer.addVideoChunk(chunk, meta));
      },
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
            videoBytes += msg.chunk.data.byteLength;
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
      videoBytes,
      videoBitrate: Math.round((videoBytes * 8 * opts.fps) / frames),
      targetBitrate: job.config.bitrate ?? videoBitrate(opts),
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
