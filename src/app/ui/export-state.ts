/**
 * The export surfaces' shared state and actions (PLAN.md §12, §15 M14, M15): the form, the run,
 * the lazily loaded runtime and the video preview's clock, used by the workspace (Poster and
 * Video) and the audio dialog. Which surface shows lives in `../export-surface`.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import type { HudPlacement } from '../../render/hud';
import type { TimeSpan } from '../../render/section';
import { VIDEO_RATIO, type VideoSize } from '../../render/video';
import type { HudItem } from '../../render/types';
import { downloadBlob } from '../download';
import { addReadout, removeReadout, sampleWidth } from '../hud-place';
import {
  DEFAULT_EXPORT_FORM,
  HUD_CHOICES,
  bookendsOf,
  cameraChoice,
  exportFileName,
  formatBytes,
  hudInOrder,
  loadExportPrefs,
  saveExportPrefs,
  sectionOf,
  type ExportForm,
  type ExportFormat,
  type LookForm,
  type VideoContext,
} from '../export-options';
import type { ExportEstimate, ExportOutput } from '../export-run';
import type { LookKind } from '../look-controls';
import type { VideoSupport } from '../video-export';
import { applyPreset } from '../youtube-preset';
import { VIDEO_FIELDS, formWithRecord, videoContextFor } from '../video-doc';
import { watchFirstFrame } from '../watch';
import { useCameraKeys, type CameraCtl } from './CameraKeys';
import {
  loadExportMode,
  saveExportMode,
  useExportSurface,
  type ExportMode,
  type ExportSurface,
} from '../export-surface';
import {
  cameraOf,
  currentTime,
  loadInfo,
  loopRegion,
  onLoadPiece,
  pause,
  play,
  pushNotice,
  seekTo,
  usePlayer,
} from '../store';

/** The lazily loaded engine room (it pulls in the DSP graph, so it is not in the main chunk). */
export type Runtime = typeof import('../export-run');

export interface RunState {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  /** 0..1, or null while the size of the job is not known yet. */
  fraction: number | null;
  label: string;
  message: string;
}

interface ExportUi {
  form: ExportForm;
  run: RunState;
  runtime: Runtime | null;
  /** The browser's video codecs for `key` (aspect, size, fps); null while being checked. */
  video: { key: string; support: VideoSupport | null };
  /** The HUD's readout list is expanded. */
  hudOpen: boolean;
  /** The video preview's score time (s); set when the dialog opens. */
  previewT: number;
  /** The video preview is playing (through the app's player). */
  previewPlaying: boolean;
  /** Where the preview last drew the HUD readouts (layout px); null before the first draw. */
  hudPlace: HudPlacement | null;
  /** The size classes this browser encodes, by `sizesKey` (aspect and fps). */
  sizes: Record<string, VideoSize[]>;
  /** The Opening & ending group is expanded. */
  bookendsOpen: boolean;
}

export const RUN_LABEL: Record<ExportForm['format'], string> = {
  wav: 'Export WAV',
  stems: 'Export stems',
  midi: 'Export MIDI',
  video: 'Export MP4',
  poster: 'Export poster',
};

export const IDLE: RunState = { status: 'idle', fraction: null, label: '', message: '' };

/** The export state. It outlives the surfaces, so reopening one keeps the last choices. */
export const useExportUi = create<ExportUi>()(() => ({
  form: { ...DEFAULT_EXPORT_FORM },
  run: IDLE,
  runtime: null,
  video: { key: '', support: null },
  hudOpen: false,
  previewT: 0,
  previewPlaying: false,
  hudPlace: null,
  sizes: {},
  bookendsOpen: false,
}));

export const sizesKey = (f: Pick<ExportForm, 'videoAspect' | 'videoFps'>) =>
  `${f.videoAspect} ${f.videoFps}`;
/** The key of the sizes YouTube's preset picks from (16:9, 60 fps). */
export const YOUTUBE_SIZES = sizesKey({ videoAspect: '16:9', videoFps: 60 });

export const videoKey = (f: ExportForm) => `${f.videoAspect} ${f.videoSize} ${f.videoFps}`;

/** The app's theme now, resolved (system → the browser's colour scheme). */
export function appDark(): boolean {
  const { view } = usePlayer.getState();
  return (
    view.theme === 'dark' ||
    (view.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

/**
 * What the video and poster take from the app now: the editor's zoom, theme and line colours,
 * the piece's length and loop region. A piece with a video record (M17) takes the zoom and line
 * colours from the piece, never the viewer's app (`videoContextFor`).
 */
export function videoContext(): VideoContext {
  const { view, compiled, piece } = usePlayer.getState();
  const loop = loopRegion();
  return videoContextFor(piece, {
    window: cameraOf().window,
    duration: compiled.duration,
    dark: appDark(),
    colors: view.colors,
    loop: loop ? { start: loop.start, end: loop.end } : null,
  });
}

/** The span the form's Section shows now, or the whole piece. */
export function sectionNow(form: ExportForm = useExportUi.getState().form): TimeSpan {
  const ctx = videoContext();
  return sectionOf(form, ctx) ?? { start: 0, end: ctx.duration ?? 0 };
}

/**
 * The preview's clock (see `previewClock`): its range on the score's clock, from the section's
 * start less the lead-in; the section alone before the runtime loads.
 */
export function clockNow(form: ExportForm = useExportUi.getState().form): {
  from: number;
  to: number;
  span: TimeSpan;
} {
  const { runtime } = useExportUi.getState();
  if (form.format === 'video' && runtime) {
    const { piece, compiled } = usePlayer.getState();
    return runtime.previewClock({ piece, compiled }, form, videoContext());
  }
  const span = sectionNow(form);
  return { from: span.start, to: span.end, span };
}

/** A piece's identity for the Section's memory (it survives edits, not a different piece). */
function pieceKey(): string {
  const { piece } = usePlayer.getState();
  return `${piece.meta.created}|${piece.seed}`;
}

/** What the dialog keeps per piece for the session: the Section and the title card's text. */
type PerPiece = Pick<ExportForm, 'section' | 'sectionSpan' | 'videoTitle' | 'videoSubtitle'>;
const PER_PIECE = ['section', 'sectionSpan', 'videoTitle', 'videoSubtitle'] as const;

/** Per piece, for the session (integrator call: not remembered on disk). */
const sections = new Map<string, PerPiece>();

/**
 * The video fields as the viewer's options show them for the open piece (a piece without a video
 * record): the remembered choices and this piece's Section and title for the session.
 */
export function viewerVideoForm(form: ExportForm): ExportForm {
  const prefs: Record<string, unknown> = { ...loadExportPrefs(), ...sectionFor(pieceKey()) };
  const out: Record<string, unknown> = { ...form };
  for (const k of VIDEO_FIELDS) out[k] = k in prefs ? prefs[k] : DEFAULT_EXPORT_FORM[k];
  const next = out as unknown as ExportForm;
  return { ...next, videoCamera: cameraChoice(next, usePlayer.getState().piece) };
}

/** The piece's remembered Section and title, else Whole and the piece's name. */
function sectionFor(key: string): PerPiece {
  return (
    sections.get(key) ?? {
      section: 'whole',
      sectionSpan: null,
      videoTitle: null,
      videoSubtitle: '',
    }
  );
}

/** The preview plays a silent stretch (lead-in, end card): clock time `v` at wall time `at`. */
export const quiet: { now: { v: number; at: number } | null } = { now: null };

export const silentNow = (q: { v: number; at: number }) => q.v + (performance.now() - q.at) / 1000;

/** The editor's playhead when the dialog opened, and whether the preview has moved it since. */
let openPlayhead = 0;
let previewMoved = false;

/**
 * Plays the video preview from its time: the section with sound through the app's player, the
 * lead-in and end card silently on a wall clock.
 */
export function playPreview(): void {
  const s = useExportUi.getState();
  if (s.previewPlaying || s.run.status === 'running') return;
  previewMoved = true;
  // Only the video's span plays: from the preview time, or its start when at (or past) its end.
  const c = clockNow(s.form);
  const from = s.previewT >= c.to - 0.05 || s.previewT < c.from ? c.from : s.previewT;
  useExportUi.setState({ previewT: from });
  if (from >= c.span.start && from < c.span.end - 0.05) {
    quiet.now = null;
    seekTo(from);
    play();
    useExportUi.setState({ previewPlaying: usePlayer.getState().transport.status === 'playing' });
  } else {
    quiet.now = { v: from, at: performance.now() };
    useExportUi.setState({ previewPlaying: true });
  }
}

/** Pauses the video preview where it is. */
export function pausePreview(): void {
  if (!useExportUi.getState().previewPlaying) return;
  if (quiet.now) {
    const v = silentNow(quiet.now);
    quiet.now = null;
    const c = clockNow();
    useExportUi.setState({ previewPlaying: false, previewT: Math.min(c.to, v) });
    return;
  }
  pause();
  useExportUi.setState({ previewPlaying: false, previewT: currentTime() });
}

/** Moves the preview to clock time x; while playing, the music follows (cards run silently). */
export function scrubPreview(x: number): void {
  const c = clockNow();
  const v = Math.min(Math.max(x, c.from), c.to);
  useExportUi.setState({ previewT: v });
  if (!useExportUi.getState().previewPlaying) return;
  const span = c.span;
  if (v >= span.start && v < span.end - 0.05) {
    if (quiet.now) {
      quiet.now = null;
      seekTo(v);
      play();
    } else seekTo(v);
  } else {
    if (!quiet.now) pause();
    quiet.now = { v, at: performance.now() };
  }
}

/** Play/Pause preview, and Space anywhere in the dialog while the video preview shows. */
export function togglePreview(): void {
  if (useExportUi.getState().previewPlaying) pausePreview();
  else playPreview();
}

/** What the Camera controls (CameraKeys.tsx) use of the dialog. */
export const cameraCtl: CameraCtl = {
  time: () => {
    const s = useExportUi.getState();
    const { span } = clockNow(s.form);
    return Math.min(Math.max(s.previewT, span.start), span.end);
  },
  seek: (t) => {
    pausePreview();
    useExportUi.setState({ previewT: t });
  },
  cameraAt: (t) => {
    const { runtime, form } = useExportUi.getState();
    if (!runtime) return null;
    const { piece, compiled } = usePlayer.getState();
    const cam = runtime.previewCamera({ piece, compiled }, form, videoContext(), t);
    return cam.pitchRange
      ? { start: cam.start, window: cam.window, pitchRange: cam.pitchRange }
      : null;
  },
  aspect: () => VIDEO_RATIO[useExportUi.getState().form.videoAspect],
  autoKeys: () => {
    const { runtime, form } = useExportUi.getState();
    if (!runtime) return null;
    const { piece, compiled } = usePlayer.getState();
    return runtime.previewAutoKeys({ piece, compiled }, form, videoContext());
  },
  setChoice: (videoCamera) => patch({ videoCamera }),
  posterKeyAt: (t) => posterFrameAt(t)?.key ?? null,
  posterAspects: () => {
    const f = posterFrameAt(cameraCtl.time());
    return f ? { art: f.art, video: f.video } : null;
  },
};

/** Over the poster: the frame the preview shows at t (null: One row, or no engine room yet). */
function posterFrameAt(t: number) {
  const { runtime, form } = useExportUi.getState();
  if (!runtime) return null;
  const { piece, compiled } = usePlayer.getState();
  return runtime.previewPosterFrame({ piece, compiled }, form, videoContext(), t);
}

/** Stops the preview and puts the editor's playhead back where it was when the dialog opened. */
function restorePlayhead(): void {
  quiet.now = null;
  useExportUi.setState({ previewPlaying: false });
  if (!previewMoved) return;
  previewMoved = false;
  pause();
  seekTo(openPlayhead);
}

let controller: AbortController | null = null;

/** The audio format used last this session: the audio dialog opens on it. */
let lastAudio: ExportFormat = 'wav';
const isAudio = (f: ExportFormat): boolean => f === 'wav' || f === 'stems' || f === 'midi';

/**
 * Shows an export surface (PLAN.md §15 M14 "Entry"): the poster workspace, the video dialog or
 * the audio dialog, its form set to its format with the remembered Look and this piece's
 * Section. Poster and Video are remembered as the mode Menu → Export opens. Leaving a surface
 * for another cancels a running export, as closing does.
 */
export function openSurface(surface: ExportSurface): void {
  const cur = useExportSurface.getState().surface;
  if (cur !== null && cur !== surface) {
    cancelExport();
    restorePlayhead();
  }
  const s = useExportUi.getState();
  // A finished or cancelled run's message is stale by the next time; a running one is kept.
  const running = s.run.status === 'running' && cur === surface;
  // The preview starts at the editor's playhead, or a third in when it is at the start.
  const now = currentTime();
  const { duration } = usePlayer.getState().compiled;
  openPlayhead = now;
  previewMoved = false;
  const format: ExportFormat =
    surface === 'audio' ? (isAudio(s.form.format) ? s.form.format : lastAudio) : surface;
  // The remembered Look and video/poster choices (none if storage is unavailable), and this
  // piece's Section (Whole for a piece not exported this session).
  const remembered = running
    ? s.form
    : { ...s.form, ...loadExportPrefs(), ...sectionFor(pieceKey()), format };
  // A piece with a video record (M17) shows it in Video, never the viewer's options.
  const { piece } = usePlayer.getState();
  const recorded =
    surface === 'video' && piece.video && !running ? formWithRecord(remembered, piece) : remembered;
  // The Camera is the piece's (Whole piece is the dialog's own).
  const form = {
    ...recorded,
    videoCamera: cameraChoice(recorded, piece),
  };
  useCameraKeys.setState({ selected: null });
  const b = form.format === 'video' ? bookendsOf(form, usePlayer.getState().piece) : undefined;
  const span = sectionNow(form);
  const t0 = now > 0 ? now : duration / 3;
  useExportUi.setState({
    previewPlaying: false,
    hudOpen: false,
    hudPlace: null,
    bookendsOpen: s.bookendsOpen || b !== undefined,
    previewT: Math.min(Math.max(t0, span.start), span.end),
    run: running ? s.run : IDLE,
    form,
  });
  if (surface !== 'audio') saveExportMode(surface);
  useExportSurface.setState({ surface });
}

/**
 * Poster | Video in the workspace's top bar (M15): the workspace switches in place. The form
 * keeps its choices (no stored options are reloaded, so the poster in step with the piece stays
 * as it is); a running export is cancelled and the preview stops.
 */
export function switchMode(mode: ExportMode): void {
  const cur = useExportSurface.getState().surface;
  if (cur === mode) return;
  if (cur !== 'poster' && cur !== 'video') {
    openSurface(mode);
    return;
  }
  cancelExport();
  restorePlayhead();
  openPlayhead = currentTime();
  const s = useExportUi.getState();
  const span = sectionNow({ ...s.form, format: mode });
  useCameraKeys.setState({ selected: null });
  useExportUi.setState({
    form: { ...s.form, format: mode },
    run: s.run.status === 'running' ? s.run : IDLE,
    hudPlace: null,
    previewT: Math.min(Math.max(s.previewT, span.start), span.end),
  });
  saveExportMode(mode);
  useExportSurface.setState({ surface: mode });
}

/**
 * The watch view (M17): the Video workspace filling the window, paused on the video's first frame
 * (the lead-in's start, when there is one; the view pins it there once the engine room loads).
 */
export function openWatch(): void {
  openSurface('video');
  useExportUi.setState({ previewT: watchFirstFrame(clockNow()) });
  useExportSurface.setState({ watch: true });
}

/** Leaves the watch view for the Video workspace, paused at the same time. */
export function leaveWatch(): void {
  if (!useExportSurface.getState().watch) return;
  pausePreview();
  useExportSurface.setState({ watch: false });
}

/** A piece opened to watch (a watch link, M17) opens in the watch view. */
onLoadPiece(() => {
  if (loadInfo().watch) openWatch();
});

/** Menu → Export: the mode used last (Poster or Video). */
export function openExport(): void {
  openSurface(loadExportMode());
}

/** Menu → Export audio…: WAV, stems and MIDI. */
export function openAudioExport(): void {
  openSurface('audio');
}

/** Leaves the export surface (Back to music, a dialog closing); a running export is cancelled. */
export function closeSurface(): void {
  cancelExport();
  restorePlayhead();
  useExportSurface.setState({ surface: null });
}

export function cancelExport(): void {
  controller?.abort();
}

export function patch(p: Partial<ExportForm>): void {
  if (p.format && isAudio(p.format)) lastAudio = p.format;
  // The choices as made are remembered (before the video sync pins anything in the form).
  const made = { ...useExportUi.getState().form, ...p };
  saveExportPrefs(made);
  if (PER_PIECE.some((k) => k in p)) {
    const keep = {} as Record<string, unknown>;
    for (const k of PER_PIECE) keep[k] = made[k];
    sections.set(pieceKey(), keep as PerPiece);
  }
  useExportUi.setState({ form: made, run: IDLE });
  clampPreview(useExportUi.getState().form);
}

/** Keeps the preview time inside the video's clock (the section, lead-in and end card). */
export function clampPreview(form: ExportForm): void {
  const c = clockNow(form);
  const { previewT, previewPlaying } = useExportUi.getState();
  const t = Math.min(Math.max(previewT, c.from), c.to);
  if (t !== previewT) {
    useExportUi.setState({ previewT: t });
    if (previewPlaying && !quiet.now) seekTo(Math.min(Math.max(t, c.span.start), c.span.end));
  }
}

/** Applies a video preset (YouTube waits for the sizes this browser encodes at 16:9 60 fps). */
export async function choosePreset(preset: 'youtube' | 'shorts'): Promise<void> {
  let sizes: VideoSize[] | undefined = useExportUi.getState().sizes[YOUTUBE_SIZES];
  const { runtime } = useExportUi.getState();
  if (preset === 'youtube' && !sizes && runtime) {
    sizes = await runtime.videoSizes({ aspect: '16:9', fps: 60 }).catch(() => undefined);
    if (sizes) {
      const list = sizes;
      useExportUi.setState((s) => ({ sizes: { ...s.sizes, [YOUTUBE_SIZES]: list } }));
    }
  }
  const form = applyPreset(useExportUi.getState().form, preset, sizes);
  const { videoAspect, videoSize, videoFps, videoQuality, loudness, videoEndCard } = form;
  patch({
    videoAspect,
    videoSize,
    videoFps,
    videoQuality,
    loudness,
    videoEndCard,
    videoTitleCard: form.videoTitleCard,
  });
  if (preset === 'youtube') useExportUi.setState({ bookendsOpen: true });
}

/** The open format's readouts and the field that holds them. */
export function hudList(form: ExportForm, kind: LookKind): readonly HudItem[] {
  return kind === 'video' ? form.videoHud : form.posterHud;
}
export function hudListPatch(kind: LookKind, items: readonly HudItem[]): Partial<ExportForm> {
  return kind === 'video' ? { videoHud: hudInOrder(items) } : { posterHud: hudInOrder(items) };
}

/** Turns a readout on (at a free spot once readouts have been placed) or off. */
export function setReadout(kind: LookKind, item: HudItem, on: boolean): void {
  const { form, hudPlace } = useExportUi.getState();
  const list = hudList(form, kind);
  if (on) {
    const sample = HUD_CHOICES.find((c) => c.id === item)?.sample ?? '';
    const layout = addReadout(form.hudLayout, hudPlace, item, sampleWidth(item, sample));
    patch({ ...hudListPatch(kind, [...list, item]), hudLayout: layout });
  } else {
    patch({
      ...hudListPatch(
        kind,
        list.filter((h) => h !== item),
      ),
      hudLayout: removeReadout(form.hudLayout, hudPlace, item),
    });
  }
}

export function patchLook(p: Partial<LookForm>): void {
  patch({ look: { ...useExportUi.getState().form.look, ...p } });
}

function setRun(run: Partial<RunState>): void {
  useExportUi.setState((s) => ({ run: { ...s.run, ...run } }));
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * Starts the export for the current form. Call it from the click or submit handler: the stems
 * save picker needs the user's activation, so it is opened here, before any `await`.
 */
export function startExport(): void {
  const { runtime, form, run } = useExportUi.getState();
  if (!runtime || run.status === 'running') return;
  pausePreview();
  const src = { piece: usePlayer.getState().piece, compiled: usePlayer.getState().compiled };
  const ac = new AbortController();
  controller = ac;

  const video = form.format === 'video';
  const poster = form.format === 'poster';
  if (video && useExportUi.getState().video.support?.ok !== true) return;
  // Chromium: ask where to save first (synchronously, inside the gesture), then stream to disk.
  const toDisk = (form.format === 'stems' || video || poster) && runtime.canSaveToDisk();
  const name = poster
    ? runtime.posterFileName(src.piece, form.posterFormat)
    : exportFileName(src.piece, form);
  const pickVideo = toDisk && video ? runtime.pickVideoFile(name) : null;
  const pickPoster = toDisk && poster ? runtime.pickPosterFile(name, form.posterFormat) : null;
  const pickStems = toDisk && form.format === 'stems' ? runtime.pickStemsFile(name) : null;
  const picking = toDisk;
  const ctx = video || poster ? videoContext() : null;
  const what = video ? 'video' : poster ? 'poster' : 'zip';

  setRun({
    status: 'running',
    fraction: null,
    label: picking ? `Choose where to save the ${what}…` : 'Starting…',
    message: '',
  });

  void (async () => {
    try {
      const hooks = {
        signal: ac.signal,
        onProgress: (fraction: number, label?: string) =>
          setRun({ fraction, label: label ?? 'Rendering…' }),
      };
      let out: ExportOutput;
      if (form.format === 'wav') {
        out = await runtime.runWav(src, form, hooks);
      } else if (form.format === 'midi') {
        out = runtime.runMidi(src, form);
      } else if (ctx && poster) {
        const target = pickPoster ? await picked(pickPoster, ac.signal) : undefined;
        out = await runtime.runPoster(src, form, ctx, { ...hooks, target });
      } else if (ctx) {
        const target = pickVideo ? await picked(pickVideo, ac.signal) : undefined;
        out = await runtime.runVideo(src, form, ctx, { ...hooks, target });
      } else {
        const target = pickStems ? await picked(pickStems, ac.signal) : undefined;
        out = await runtime.runStems(src, form, { ...hooks, target });
      }
      if (out.blob) downloadBlob(out.blob, out.name);
      if (out.notes) pushNotice('warning', 'QR code', out.notes);
      setRun({
        status: 'done',
        fraction: 1,
        label: '',
        message: out.blob
          ? `Saved ${out.name} (${formatBytes(out.bytes)}) to your downloads.`
          : `Saved ${out.name} (${formatBytes(out.bytes)}).`,
      });
    } catch (e) {
      if (isAbort(e) || ac.signal.aborted) {
        setRun({ status: 'cancelled', fraction: null, label: '', message: 'Export cancelled.' });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setRun({ status: 'error', fraction: null, label: '', message });
        pushNotice('error', 'Export failed', [message]);
      }
    } finally {
      if (controller === ac) controller = null;
    }
  })();
}

/**
 * The picked file handle. The browser's picker cannot be dismissed from here; Cancel just stops
 * waiting for it. Dismissing the picker cancels the export.
 */
async function picked<T>(picking: Promise<T | null>, signal: AbortSignal): Promise<T> {
  const gone = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))),
  );
  const target = await Promise.race([picking, gone]);
  if (!target) throw new DOMException('Save cancelled', 'AbortError');
  return target;
}

export function estimateFor(
  runtime: Runtime | null,
  piece: ReturnType<typeof usePlayer.getState>['piece'],
  compiled: ReturnType<typeof usePlayer.getState>['compiled'],
  form: ExportForm,
): ExportEstimate | null {
  if (!runtime) return null;
  try {
    return runtime.estimateExport({ piece, compiled }, form, sectionOf(form, videoContext()));
  } catch {
    return null;
  }
}
/**
 * Counters of the preview's measure and scroll-padding callbacks and draws, and the last and
 * longest draw (ms; debug hook).
 */
export const previewStats = { measures: 0, pads: 0, draws: 0, lastMs: 0, maxMs: 0 };

/** Loads the engine room while `active`, so a click handler can use it directly. */
export function useRuntime(active: boolean): Runtime | null {
  const runtime = useExportUi((s) => s.runtime);
  useEffect(() => {
    if (!active || runtime) return;
    let alive = true;
    import('../export-run').then(
      (m) => {
        if (alive) useExportUi.setState({ runtime: m });
      },
      (e: unknown) => {
        pushNotice('error', 'Export could not load', [e instanceof Error ? e.message : String(e)]);
      },
    );
    return () => {
      alive = false;
    };
  }, [active, runtime]);
  return runtime;
}
