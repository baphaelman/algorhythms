/**
 * The Export dialog's engine room (PLAN.md §12): size estimates and the three exports. It imports
 * the DSP graph (through the WAV and stems clients), so the dialog loads this module with a
 * dynamic `import()` and the main bundle does not carry it.
 */

import { exportWav } from '../audio/export-client';
import { canSaveToDisk, exportStems, pickStemsFile, planStems } from '../audio/stems-client';
import type { StemsProgress, StemsTarget } from '../audio/stems-client';
import { wavExportSize } from '../audio/wav-export';
import type { CompiledScore, Piece, Seconds } from '../core/types';
import type { TimeSpan } from '../render/section';
import type { Ctx2D } from '../render/draw';
import { exportMidi, zipFiles } from '../midi/export';
import {
  exportFileName,
  midiOptions,
  posterOptions,
  stemsOptions,
  videoOptions,
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
  exportVideo,
  fileSink,
  previewVideoFrame,
  videoAudioFrames,
  videoSupport,
  type VideoOptions,
  type VideoPhase,
  type VideoResult,
  type VideoSink,
} from './video-export';

import { posterFileName, previewPoster, renderPosterPng, renderPosterSvg } from './poster-export';
import type { PosterOptions } from './poster-export';

export { canSaveToDisk, pickStemsFile, posterFileName, videoSupport };

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
      ? await renderPosterPng(src.piece, options, src.compiled)
      : new Blob([renderPosterSvg(src.piece, options, src.compiled)], { type: 'image/svg+xml' });
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
  | { kind: 'video'; options: VideoOptions; t: Seconds; scale: number }
  | { kind: 'poster'; options: PosterOptions; scale: number };

let lastPreview: PreviewRequest | null = null;

/** The last preview drawn (tests). */
export function lastPreviewRequest(): PreviewRequest | null {
  return lastPreview;
}

/**
 * The dialog's preview of a video export: the frame at t, drawn by the export's own code with
 * the options `runVideo` would use, on a canvas `scale` times the video's pixels.
 */
export function previewVideo(
  g: Ctx2D,
  src: ExportSource,
  form: ExportForm,
  ctx: VideoContext,
  t: Seconds,
  scale: number,
): void {
  const options = videoOptions(form, src.piece, ctx);
  lastPreview = { kind: 'video', options, t, scale };
  previewVideoFrame(g, src.piece, src.compiled, options, t, scale);
}

/** The dialog's preview of a poster export (as `previewVideo`; the whole poster). */
export function previewPosterOf(
  g: Ctx2D,
  src: ExportSource,
  form: ExportForm,
  ctx: LookAppContext & SectionContext,
  scale: number,
): void {
  const options = posterOptions(form, src.piece, ctx);
  lastPreview = { kind: 'poster', options, scale };
  previewPoster(g, src.piece, src.compiled, options, scale);
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
  const opts = videoOptions(form, src.piece, ctx);
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
      onProgress: (f, phase) => hooks.onProgress?.(f, PHASE_LABEL[phase]),
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
