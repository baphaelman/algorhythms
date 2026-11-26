/**
 * The Export dialog's engine room (PLAN.md §12): size estimates and the three exports. It imports
 * the DSP graph (through the WAV and stems clients), so the dialog loads this module with a
 * dynamic `import()` and the main bundle does not carry it.
 */

import { exportWav, measureInWorker } from '../audio/export-client';
import { canSaveToDisk, exportStems, pickStemsFile, planStems } from '../audio/stems-client';
import type { StemsProgress, StemsTarget } from '../audio/stems-client';
import { LOUDNESS_CEILING, wavExportSize } from '../audio/wav-export';
import type { CameraKey, CompiledScore, Piece, PosterCameraKey, Seconds } from '../core/types';
import { VIDEO_RATIO } from '../render/video';
import { posterKeyOfFrame } from '../render/poster-video';
import { normalizePlan, type LoudnessMeasure } from '../dsp/loudness';
import { videoSpan } from '../render/video';
import type { TimeSpan } from '../render/section';
import type { Ctx2D } from '../render/draw';
import type { HudPlacement } from '../render/hud';
import type { PosterLayout } from '../render/poster-layout';
import type { CameraState } from '../render/types';
import { exportMidi, zipFiles } from '../midi/export';
import {
  bookendsOf,
  exportFileName,
  fileBase,
  midiOptions,
  posterOptions,
  sectionOf,
  stemsOptions,
  videoOptions,
  wavLoudness,
  wavOptions,
  type ExportForm,
  type LookAppContext,
  type SectionContext,
  type VideoContext,
} from './export-options';
import {
  VIDEO_SAMPLE_RATE,
  blobSink,
  estimateVideoBytes,
  etaText,
  exportThumbnail,
  exportVideo,
  fileSink,
  previewVideoFrame,
  previewVideoMoment,
  videoAudioFrames,
  videoCameraAt,
  videoLoudnessCeiling,
  videoPosterFrameAt,
  videoAudioSpan,
  videoAutoKeys,
  videoSizes,
  videoSupport,
  videoTimeline,
  type VideoOptions,
  type VideoPhase,
  type VideoResult,
  type VideoSink,
} from './video-export';

import {
  posterFileName,
  posterHudOf,
  previewPosterLayout,
  renderPosterLayoutPng,
  renderPosterLayoutSvg,
} from './poster-export';
import type { PosterOptions } from './poster-export';

import { youtubeDescription } from './youtube-description';
import { loudnessKey } from './youtube-preset';

export { canSaveToDisk, pickStemsFile, posterFileName, videoSizes, videoSupport };

/** The piece as it sounds now. */
export interface ExportSource {
  piece: Piece;
  compiled: CompiledScore;
}

/** What an export would produce, for the dialog's size line. */
export interface ExportEstimate {
  bytes: number;
  files: number;
  /** Stems and video: over 1 GB. */
  large: boolean;
  zip64: boolean;
}

/**
 * Exact size of a WAV or stems export (no rendering), an upper bound for a video (of its
 * `section`, if any); null for MIDI (it is small).
 */
export function estimateExport(
  src: ExportSource,
  form: ExportForm,
  section?: TimeSpan,
): ExportEstimate | null {
  const input = { score: src.compiled, mix: src.piece.mix, timbres: src.piece.timbres };
  if (form.format === 'wav') {
    const { bytes } = wavExportSize(input, wavOptions(form));
    return { bytes, files: 1, large: false, zip64: false };
  }
  if (form.format === 'stems') {
    const p = planStems(input, stemsOptions(form, src.piece));
    return { bytes: p.bytes, files: p.entries.length, large: p.large, zip64: p.zip64 };
  }
  if (form.format === 'video') {
    const seconds = videoAudioFrames(src.compiled, src.piece.mix, section) / VIDEO_SAMPLE_RATE;
    const bytes = estimateVideoBytes(seconds, {
      aspect: form.videoAspect,
      size: form.videoSize,
      fps: form.videoFps,
    });
    return { bytes, files: 1, large: bytes > 1e9, zip64: false };
  }
  return null;
}

/** A finished export: the file to hand to the browser, or null when it was streamed to disk. */
export interface ExportOutput {
  name: string;
  blob: Blob | null;
  bytes: number;
  /** Files inside (stems zip, MIDI zip), 1 otherwise. */
  files: number;
}

export interface RunHooks {
  /** Fraction done, 0..1, with a short label of what is being rendered. */
  onProgress?: (fraction: number, label?: string) => void;
  signal?: AbortSignal;
}

/** Renders the mix to a WAV Blob in a worker. */
export async function runWav(
  src: ExportSource,
  form: ExportForm,
  hooks: RunHooks = {},
): Promise<ExportOutput> {
  const blob = await exportWav({
    score: src.compiled,
    mix: src.piece.mix,
    timbres: src.piece.timbres,
    ...wavOptions(form),
    ...wavLoudness(form),
    signal: hooks.signal,
    onProgress: (f) => hooks.onProgress?.(f),
  });
  return { name: exportFileName(src.piece, form), blob, bytes: blob.size, files: 1 };
}

/** Builds the MIDI file, or a zip of several (MPE with more than 15 voices). */
export function runMidi(src: ExportSource, form: ExportForm): ExportOutput {
  const { files } = exportMidi(src.compiled, midiOptions(form, src.piece));
  if (files.length === 1) {
    const data = files[0].data;
    return {
      name: files[0].name,
      blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }),
      bytes: data.byteLength,
      files: 1,
    };
  }
  const zip = zipFiles(files);
  return {
    name: exportFileName(src.piece, form, files.length),
    blob: new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    bytes: zip.byteLength,
    files: files.length,
  };
}

/**
 * Renders the stems zip in a worker. With a `target` (a file handle from `pickStemsFile`) it is
 * streamed to disk and `blob` is null; otherwise the zip comes back as a Blob.
 */
export async function runStems(
  src: ExportSource,
  form: ExportForm,
  hooks: RunHooks & { target?: StemsTarget } = {},
): Promise<ExportOutput> {
  const r = await exportStems(src.compiled, src.piece.mix, {
    ...stemsOptions(form, src.piece),
    timbres: src.piece.timbres,
    target: hooks.target,
    signal: hooks.signal,
    onProgress: (p: StemsProgress) =>
      hooks.onProgress?.(p.fraction, `${p.entry} (${p.index + 1} of ${p.total})`),
  });
  return {
    name: exportFileName(src.piece, form),
    blob: r.blob,
    bytes: r.bytes,
    files: r.entries.length,
  };
}

/** A file handle from the save picker (`FileSystemFileHandle`). */
export interface VideoFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

/** The save dialog for one file type; null if the browser has no picker or the user cancels. */
async function pickFile(
  suggestedName: string,
  description: string,
  accept: Record<string, string[]>,
): Promise<VideoFileHandle | null> {
  const pick = (globalThis as { showSaveFilePicker?: (o: unknown) => Promise<VideoFileHandle> })
    .showSaveFilePicker;
  if (!pick) return null;
  try {
    return await pick.call(globalThis, { suggestedName, types: [{ description, accept }] });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/**
 * Opens the save dialog for the MP4; call it from the click handler, before any `await`. Null if
 * the browser has no picker or the user cancels.
 */
export function pickVideoFile(suggestedName: string): Promise<VideoFileHandle | null> {
  return pickFile(suggestedName, 'Video (MP4)', { 'video/mp4': ['.mp4'] });
}

/** Opens the save dialog for a poster (as `pickVideoFile`). */
export function pickPosterFile(
  suggestedName: string,
  format: 'png' | 'svg',
): Promise<VideoFileHandle | null> {
  return format === 'png'
    ? pickFile(suggestedName, 'PNG image', { 'image/png': ['.png'] })
    : pickFile(suggestedName, 'SVG image', { 'image/svg+xml': ['.svg'] });
}

let lastPoster: { options: PosterOptions; format: 'png' | 'svg' } | null = null;

/** The last poster export started: its options and format (tests). */
export function lastPosterRequest(): typeof lastPoster {
  return lastPoster;
}

const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/**
 * Draws the poster (PNG or SVG). With a `target` (from `pickPosterFile`) it is written there and
 * `blob` is null; otherwise it comes back as a Blob.
 */
export async function runPoster(
  src: ExportSource,
  form: ExportForm,
  ctx: LookAppContext & SectionContext,
  hooks: RunHooks & { target?: VideoFileHandle } = {},
): Promise<ExportOutput> {
  const options = posterOptions(form, src.piece, ctx);
  const format = form.posterFormat;
  lastPoster = { options, format };
  const name = posterFileName(src.piece, format);
  hooks.onProgress?.(0, 'Drawing the poster…');
  // Let the label paint before the (synchronous) drawing.
  await new Promise((r) => setTimeout(r, 0));
  if (aborted(hooks.signal)) throw new DOMException('Cancelled', 'AbortError');
  const blob =
    format === 'png'
      ? await renderPosterLayoutPng(src.piece, options, src.compiled)
      : new Blob([renderPosterLayoutSvg(src.piece, options, src.compiled)], {
          type: 'image/svg+xml',
        });
  if (aborted(hooks.signal)) throw new DOMException('Cancelled', 'AbortError');
  if (!hooks.target) return { name, blob, bytes: blob.size, files: 1 };
  const w = await hooks.target.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
  return { name, blob: null, bytes: blob.size, files: 1 };
}

/** What the dialog's preview last drew (tests compare it with a direct render). */
export type PreviewRequest =
  | { kind: 'video'; options: VideoOptions; t: Seconds; tau?: Seconds; scale: number }
  | {
      kind: 'poster';
      options: PosterOptions;
      scale: number;
      /** Zoomed in: the canvas holds the part from here (canvas px). */
      offset?: { x: number; y: number };
    };

let lastPreview: PreviewRequest | null = null;

/** The last preview drawn (tests). */
export function lastPreviewRequest(): PreviewRequest | null {
  return lastPreview;
}

/**
 * The preview's clock (§12 "Ready for YouTube"): the time slider's range on the score's clock.
 * From the section's start less the lead-in, for the video's length (lead-in, the music with
 * its ring-out, the end card); without an opening or ending, the section itself.
 */
export function previewClock(
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
): { from: Seconds; to: Seconds; lead: Seconds; span: TimeSpan } {
  const section = sectionOf(form, ctx);
  const span = videoSpan(src.compiled.duration, section);
  const bookends = bookendsOf(form, src.piece);
  if (!bookends) return { from: span.start, to: span.end, lead: 0, span };
  const tl = videoTimeline(src.compiled, src.piece.mix, { section, bookends });
  const lead = tl.lead / VIDEO_SAMPLE_RATE;
  const from = span.start - lead;
  return { from, to: from + tl.total / VIDEO_SAMPLE_RATE, lead, span };
}

/** The video's options (Auto's keys are made in `frameOptions`, for the section and aspect). */
const optionsOf = (src: ExportSource, form: ExportForm, ctx: VideoContext): VideoOptions =>
  videoOptions(form, src.piece, ctx);

/** The Auto camera's keys for this video (its section and aspect): what Auto exports. */
export const previewAutoKeys = (
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
): readonly CameraKey[] => videoAutoKeys(src.compiled, optionsOf(src, form, ctx));

/** The camera the preview shows at score time t (for a key made from the current view). */
export function previewCamera(
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
  t: Seconds,
): CameraState {
  return videoCameraAt(src.piece, src.compiled, optionsOf(src, form, ctx), t);
}

/**
 * Over the poster (M15): the key for the frame the camera shows at score time t (the export's
 * camera, held inside the section), with the artboard's and the video's width / height; null when
 * the video plays One row. The poster is laid out once per piece and options (`frameOptions`).
 */
export function previewPosterFrame(
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
  t: Seconds,
): { key: PosterCameraKey; art: number; video: number } | null {
  const o = optionsOf(src, form, ctx);
  const at = videoPosterFrameAt(src.piece, src.compiled, o, t);
  if (!at) return null;
  return {
    key: posterKeyOfFrame(at.layout, at.frame, t),
    art: at.layout.width / at.layout.height,
    video: VIDEO_RATIO[o.aspect],
  };
}

/**
 * The dialog's preview of a video export: the frame at v on the preview's clock (the score's
 * time, less the lead-in before the section's start; see `previewClock`), drawn by the export's
 * own code with the options `runVideo` would use, on a canvas `scale` times the video's pixels.
 * With an opening or ending it is the video's moment τ = v − clock start.
 */
export function previewVideo(
  g: Ctx2D,
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
  v: Seconds,
  scale: number,
): HudPlacement {
  const options = optionsOf(src, form, ctx);
  if (!options.bookends) {
    lastPreview = { kind: 'video', options, t: v, scale };
    return previewVideoFrame(g, src.piece, src.compiled, options, v, scale);
  }
  const clock = previewClock(src, form, ctx);
  const tau = v - clock.from;
  const t = Math.min(clock.span.end, Math.max(clock.span.start, v));
  lastPreview = { kind: 'video', options, t, tau, scale };
  return previewVideoMoment(g, src.piece, src.compiled, options, tau, scale);
}

/**
 * The thumbnail JPEG (§12 "Ready for YouTube" → Thumbnail): the frame at score time `at` or
 * the whole-piece view, the title large; under 2 MB.
 */
export async function runThumbnail(
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
  at: Seconds | 'whole',
): Promise<ExportOutput> {
  const options = optionsOf(src, form, ctx);
  const blob = await exportThumbnail(src.piece, options, at);
  return { name: `${fileBase(src.piece)}-thumbnail.jpg`, blob, bytes: blob.size, files: 1 };
}

/** The YouTube description for the form's section (and the share link, if given). */
export function descriptionOf(
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
  shareLink?: string,
): string {
  const section = sectionOf(form, ctx);
  return youtubeDescription(src.piece, src.compiled, {
    ...(section ? { section } : {}),
    ...(shareLink ? { shareLink } : {}),
  });
}

/** Measurements by `loudnessKey` (this session), and those running. */
const measured = new Map<string, LoudnessMeasure>();
const measuring = new Map<string, Promise<LoudnessMeasure>>();

/**
 * What the Loudness display measures: the WAV's whole render, or the video's audio (its
 * section's span). Measured at 48 kHz.
 */
export function loudnessTarget(
  src: ExportSource,
  form: ExportForm,
  ctx: SectionContext,
): { key: string; span?: ReturnType<typeof videoAudioSpan> } {
  const section = form.format === 'video' ? sectionOf(form, ctx) : undefined;
  const span = section ? videoAudioSpan(src.compiled.duration, section) : undefined;
  return { key: loudnessKey(src.piece, section), ...(span ? { span } : {}) };
}

/**
 * The gain and limiting a target calls for (`normalizePlan`); a video's audio codec (`'opus'`,
 * `'mp4a…'`) lowers the ceiling.
 */
export function loudnessPlan(m: LoudnessMeasure, target: number, videoAudio?: string) {
  return normalizePlan(
    m,
    target,
    videoAudio !== undefined ? videoLoudnessCeiling(videoAudio) : LOUDNESS_CEILING,
  );
}

/** The cached measurement for `key`, if any. */
export function cachedLoudness(key: string): LoudnessMeasure | undefined {
  return measured.get(key);
}

/**
 * Measures the export's loudness in a worker, once per piece version and span (cached; a
 * second call while measuring shares the first).
 */
export function measureExportLoudness(
  src: ExportSource,
  form: ExportForm,
  ctx: SectionContext,
  onProgress?: (fraction: number) => void,
): Promise<LoudnessMeasure> {
  const { key, span } = loudnessTarget(src, form, ctx);
  const done = measured.get(key);
  if (done) return Promise.resolve(done);
  let p = measuring.get(key);
  if (!p) {
    p = measureInWorker({
      score: src.compiled,
      mix: src.piece.mix,
      timbres: src.piece.timbres,
      sampleRate: VIDEO_SAMPLE_RATE,
      ...(span ? { span } : {}),
      onProgress,
    }).then(
      (m) => {
        measured.set(key, m);
        measuring.delete(key);
        return m;
      },
      (e: unknown) => {
        measuring.delete(key);
        throw e;
      },
    );
    measuring.set(key, p);
  }
  return p;
}

/**
 * The workspace's artboard: the poster as the export draws it, from its layout (returned, for
 * hit-testing), and the HUD readouts' boxes.
 */
export function previewPosterOf(
  g: Ctx2D,
  src: ExportSource,
  form: ExportForm,
  ctx: LookAppContext & SectionContext,
  scale: number,
  offset?: { x: number; y: number },
): { layout: PosterLayout; hud: HudPlacement } {
  const options = posterOptions(form, src.piece, ctx);
  lastPreview = { kind: 'poster', options, scale, ...(offset ? { offset } : {}) };
  const layout = previewPosterLayout(
    g,
    src.piece,
    src.compiled,
    options,
    scale,
    src.piece.poster,
    offset,
  );
  return { layout, hud: posterHudOf(layout) };
}

const PHASE_LABEL: Record<VideoPhase, string> = {
  audio: 'Rendering the audio…',
  video: 'Drawing and encoding the video…',
  finishing: 'Finishing the file…',
};

let lastVideo: { options: VideoOptions; result: VideoResult | null } | null = null;

/** The last video export started: its options, and its result once finished (tests). */
export function lastVideoRequest(): typeof lastVideo {
  return lastVideo;
}

/**
 * Exports the MP4. With a `target` (from `pickVideoFile`) it is streamed to disk and `blob` is
 * null; otherwise it is built in memory and comes back as a Blob.
 */
export async function runVideo(
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
  hooks: RunHooks & { target?: VideoFileHandle } = {},
): Promise<ExportOutput> {
  const opts = optionsOf(src, form, ctx);
  const last = { options: opts, result: null as VideoResult | null };
  lastVideo = last;
  const mem = hooks.target ? null : blobSink();
  let sink: VideoSink = mem ?? fileSink(await hooks.target!.createWritable());
  let bytes = 0;
  if (!mem) {
    // Count the appended bytes (the one positioned write patches the mdat size in place).
    const inner = sink;
    sink = {
      ...inner,
      write: (data, position) => {
        if (position === undefined) bytes += data.byteLength;
        return inner.write(data, position);
      },
    };
  }
  try {
    last.result = await exportVideo(src.piece, opts, sink, {
      signal: hooks.signal,
      onProgress: (f, phase, eta) =>
        hooks.onProgress?.(
          f,
          eta === undefined ? PHASE_LABEL[phase] : `${PHASE_LABEL[phase]} ${etaText(eta)}.`,
        ),
    });
  } catch (e) {
    // exportVideo aborts the sink itself once it has started; not on its early checks.
    await sink.abort?.().catch(() => undefined);
    throw e;
  }
  if (mem) {
    const blob = mem.blob();
    return { name: exportFileName(src.piece, form), blob, bytes: blob.size, files: 1 };
  }
  return { name: exportFileName(src.piece, form), blob: null, bytes, files: 1 };
}
