import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { formatTime } from '../../render/hud';
import { videoSize } from '../../render/video';
import {
  BEND_RANGES,
  BIT_DEPTHS,
  EXPORT_FORMATS,
  MIDI_MODES,
  RATES,
  VIDEO_ASPECTS,
  VIDEO_FPS,
  VIDEO_QUALITIES,
  VIDEO_SIZES,
  VIDEO_THEMES,
  aacNote,
  bookendsOf,
  cameraChoice,
  codecLabel,
  followWindowOf,
  followWindowToSlider,
  formatBytes,
  sliderToFollowWindow,
  windowSnaps,
  windowText,
  type ExportForm,
} from '../export-options';
import type { VideoSupport } from '../video-export';
import { setDialogSpace } from '../space-key';
import { useExportSurface } from '../export-surface';
import { useFocusRescue } from './focus-rescue';
import { Radios } from './export-controls';
import { BookendsGroup, LoudnessField, PresetField, PreviewActions } from './ExportYoutube';
import { CameraField, KeyButtons, KeyMarkers, useKeyView } from './CameraKeys';
import { redo, undo } from '../editor/history';
import { cameraOf, currentTime, pause, play, seekTo, usePlayer } from '../store';
import { ExportModeSwitch, HudOverlay, LookPanel, RunStatus, SectionField } from './ExportFields';
import {
  RUN_LABEL,
  YOUTUBE_SIZES,
  cameraCtl,
  cancelExport,
  choosePreset,
  clockNow,
  closeSurface,
  estimateFor,
  openSurface,
  patch,
  patchLook,
  pausePreview,
  previewStats,
  quiet,
  sectionNow,
  silentNow,
  sizesKey,
  startExport,
  togglePreview,
  useExportUi,
  useRuntime,
  videoContext,
  videoKey,
  type Runtime,
} from './export-state';

/** Audio formats (Menu → Export audio…). */
const AUDIO_FORMATS = EXPORT_FORMATS.filter(
  (f) => f.id === 'wav' || f.id === 'stems' || f.id === 'midi',
);

/** The dialog closed (Escape, Close, a backdrop click): back to the editor, unless the surface moved on. */
function closeDialog(): void {
  const { surface } = useExportSurface.getState();
  if (surface !== 'video' && surface !== 'audio') return;
  closeSurface();
  // Always the menu button: the opener (Menu item or workspace) is gone, and WebKit doesn't
  // focus clicked buttons, so the native restore can't be relied on.
  requestAnimationFrame(() => {
    if (useExportSurface.getState().surface !== null) return;
    document.querySelector<HTMLElement>('[data-testid="menu-button"]')?.focus();
  });
}

/** Wide screens show the preview beside the options (styles.css uses the same width). */
const WIDE = '(min-width: 900px)';

/** The preview's box (CSS px): the column's width, at most this tall. */
function previewMaxHeight(wide: boolean): number {
  return wide ? Math.min(520, innerHeight * 0.58) : Math.min(170, innerHeight * 0.27);
}

/** Whether the screen is wide (the preview beside the options). */
function useWide(): boolean {
  return useSyncExternalStore(
    (on) => {
      const mq = matchMedia(WIDE);
      mq.addEventListener('change', on);
      return () => mq.removeEventListener('change', on);
    },
    () => matchMedia(WIDE).matches,
  );
}

/**
 * Thumbnail and Copy description: under the preview on wide screens, at the top of the options
 * on narrow ones (the sticky preview stays small).
 */
function VideoActions({ form, runtime }: { form: ExportForm; runtime: Runtime | null }) {
  const t = useExportUi((s) => s.previewT);
  const running = useExportUi((s) => s.run.status === 'running');
  const span = sectionNow(form);
  return (
    <PreviewActions
      form={form}
      runtime={runtime}
      time={Math.min(Math.max(span.start, t), span.end)}
      disabled={running}
      context={videoContext}
      onPatch={patch}
    />
  );
}

/**
 * The live preview (PLAN.md §12 "Preview and layout"): the video frame at the chosen time, or
 * the whole poster, drawn by the export's own code (`export-run` preview functions) at a small
 * size, redrawn at most once per animation frame on any change. Video adds a time slider.
 */
function ExportPreview({ form, runtime }: { form: ExportForm; runtime: Runtime | null }) {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  // The app's theme and line colours feed 'Current' and 'As in the app'.
  const appView = usePlayer((s) => `${s.view.theme} ${s.view.colors}`);
  const t = useExportUi((s) => s.previewT);
  const wide = useWide();
  const playing = useExportUi((s) => s.previewPlaying);
  const running = useExportUi((s) => s.run.status === 'running');
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const draws = useRef(0);
  const frame = useRef(0);
  const job = useRef<(() => void) | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const id = useId();
  // Keys: the timeline's key markers, and the preview shapes the selected key's view.
  const keysMode = form.videoCamera === 'keys';
  useKeyView(stage, cameraCtl, keysMode && !running);

  // The space the preview may take: the column's width, a share of the screen's height. State
  // changes only when a number does, so a re-render the size causes cannot loop back here.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      previewStats.measures++;
      const w = el.clientWidth;
      const h = previewMaxHeight(matchMedia(WIDE).matches);
      setAvail((a) => (a.w === w && a.h === h ? a : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      removeEventListener('resize', measure);
    };
  }, []);

  // Narrow screens: the sticky preview sits over the scrolling options, so keep scrolled-to
  // controls (focus, scrollIntoView) clear of it. Only the dialog's scroll padding is written
  // (nothing observed changes size), and only when it differs.
  useLayoutEffect(() => {
    const el = wrap.current;
    const dlg = el?.closest('dialog');
    if (!el || !dlg) return;
    const pad = () => {
      previewStats.pads++;
      const v = matchMedia(WIDE).matches ? '' : `${el.offsetHeight}px`;
      if (dlg.style.scrollPaddingTop !== v) dlg.style.scrollPaddingTop = v;
    };
    pad();
    const ro = new ResizeObserver(pad);
    ro.observe(el);
    addEventListener('resize', pad);
    return () => {
      ro.disconnect();
      removeEventListener('resize', pad);
      dlg.style.scrollPaddingTop = '';
    };
  }, []);

  // Space anywhere in the dialog plays and pauses the preview (space-key.ts); closing stops it.
  useEffect(() => {
    const off = setDialogSpace(togglePreview);
    return () => {
      off();
      pausePreview();
    };
  }, []);

  // Playing: the time follows the playhead every frame (the draw below runs once per frame); the
  // player stopping (the end, or anything else) stops the preview.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const c = clockNow();
      if (quiet.now) {
        // The lead-in or end card: a wall clock; the music starts at the section's start.
        const v = silentNow(quiet.now);
        if (v >= c.to) {
          quiet.now = null;
          useExportUi.setState({ previewPlaying: false, previewT: c.to });
          return;
        }
        if (quiet.now.v < c.span.start && v >= c.span.start) {
          quiet.now = null;
          seekTo(c.span.start);
          play();
          useExportUi.setState({ previewT: c.span.start });
        } else useExportUi.setState({ previewT: v });
        raf = requestAnimationFrame(tick);
        return;
      }
      const now = currentTime();
      const span = c.span;
      if (usePlayer.getState().transport.status !== 'playing') {
        useExportUi.setState({ previewPlaying: false, previewT: now });
        return;
      }
      // Only the section plays: stop at its end (or if the player left it, e.g. a loop's wrap);
      // an end card (or ring-out) after it runs on silently.
      if (now >= span.end - 1e-3 || now < span.start - 0.05) {
        pause();
        const at = Math.min(Math.max(now, span.start), span.end);
        if (now >= span.end - 1e-3 && c.to > span.end + 0.05) {
          quiet.now = { v: at, at: performance.now() };
          useExportUi.setState({ previewT: at });
          raf = requestAnimationFrame(tick);
          return;
        }
        useExportUi.setState({ previewPlaying: false, previewT: at });
        return;
      }
      if (useExportUi.getState().previewT !== now) useExportUi.setState({ previewT: now });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const px = videoSize(form.videoAspect, form.videoSize);
  const aspect = px.width / px.height;
  const cssW = Math.max(1, Math.floor(Math.min(avail.w, avail.h * aspect)));
  const cssH = Math.max(1, Math.round(cssW / aspect));
  const dpr = Math.min(2, devicePixelRatio || 1);
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.max(1, Math.round((px.height * pxW) / px.width));
  // The video's clock: the section, less the lead-in before it, plus the end card after it.
  const clock = useMemo(
    () => clockNow(form),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, compiled, runtime],
  );
  const v = Math.min(Math.max(clock.from, t), clock.to);
  const span = clock.span;
  const time = Math.min(Math.max(span.start, v), span.end);
  const bookends = bookendsOf(form, piece) !== undefined;
  const shown = bookends ? v - clock.from : v;

  useEffect(() => {
    if (!runtime || avail.w === 0) return;
    // The latest change replaces the pending draw's job; the frame already asked for stays (a
    // change every frame, as while playing, must not keep pushing the draw back).
    job.current = () => {
      const c = canvas.current;
      const g = c?.getContext('2d');
      if (!c || !g) return;
      if (c.width !== pxW) c.width = pxW;
      if (c.height !== pxH) c.height = pxH;
      const scale = pxW / px.width;
      const src = { piece, compiled };
      const t0 = performance.now();
      const place = runtime.previewVideo(g, src, form, videoContext(), v, scale);
      const prev = useExportUi.getState().hudPlace;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(place)) {
        useExportUi.setState({ hudPlace: place });
      }
      previewStats.lastMs = performance.now() - t0;
      previewStats.maxMs = Math.max(previewStats.maxMs, previewStats.lastMs);
      draws.current++;
      previewStats.draws++;
      c.dataset.draws = String(draws.current);
    };
    if (frame.current === 0) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const run = job.current;
        job.current = null;
        run?.();
      });
    }
  }, [runtime, piece, compiled, form, v, pxW, pxH, px.width, appView, avail.w]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  const what = `Preview of the video frame at ${formatTime(shown)}, ${form.videoAspect}`;

  return (
    <div className="export-preview" data-testid="export-preview" ref={wrap}>
      <div className="preview-box" ref={box}>
        <div
          ref={stage}
          className={keysMode ? 'preview-stage keys' : 'preview-stage'}
          style={{ width: `${cssW}px`, height: `${cssH}px` }}
        >
          <canvas
            ref={canvas}
            role="img"
            aria-label={what}
            data-testid="preview-canvas"
            data-t={time.toFixed(3)}
            data-tau={bookends ? shown.toFixed(3) : undefined}
            style={{ width: `${cssW}px`, height: `${cssH}px` }}
          />
          <HudOverlay form={form} kind="video" disabled={running} />
        </div>
      </div>
      <div className="field-row preview-time">
        <button
          type="button"
          className="preview-play"
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          aria-keyshortcuts="Space"
          title={`${playing ? 'Pause' : 'Play'} preview (Space)`}
          disabled={running}
          data-testid="preview-play"
          data-playing={playing}
          onClick={togglePreview}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <label htmlFor={`${id}-t`} className="visually-hidden">
          Preview time
        </label>
        <span className={keysMode ? 'preview-track keys' : 'preview-track'}>
          <input
            id={`${id}-t`}
            type="range"
            min={clock.from}
            max={Math.max(clock.from + 0.1, clock.to)}
            step={0.1}
            value={v}
            aria-valuetext={formatTime(shown)}
            data-testid="preview-time"
            onChange={(e) => {
              const x = Number(e.target.value);
              useExportUi.setState({ previewT: x });
              if (!useExportUi.getState().previewPlaying) return;
              // Playing: the music follows the slider; the lead-in and end card run silently.
              if (x >= span.start && x < span.end - 0.05) {
                if (quiet.now) {
                  quiet.now = null;
                  seekTo(x);
                  play();
                } else seekTo(x);
              } else {
                if (!quiet.now) pause();
                quiet.now = { v: x, at: performance.now() };
              }
            }}
          />
          {keysMode && (
            <KeyMarkers
              from={clock.from}
              to={Math.max(clock.from + 0.1, clock.to)}
              disabled={running}
              ctl={cameraCtl}
            />
          )}
        </span>
        <output htmlFor={`${id}-t`} data-testid="preview-time-value">
          {formatTime(shown)}
        </output>
      </div>
      {keysMode && <KeyButtons disabled={running} ctl={cameraCtl} />}
      {wide && <VideoActions form={form} runtime={runtime} />}
    </div>
  );
}

/**
 * Follow’s Window (PLAN.md §12 "Video export"): seconds the frame shows at the chosen aspect, log
 * scale from 2 s to the whole piece. A tick under the track marks the editor's zoom; the slider
 * snaps to it when moved close, and on it the form keeps no window of its own (null).
 */
function WindowField({
  form,
  duration,
  disabled,
}: {
  form: ExportForm;
  duration: number;
  disabled: boolean;
}) {
  const id = useId();
  /** The last slider input came from the keyboard (snaps only toward the tick). */
  const keyed = useRef(false);
  const ctx = { window: cameraOf().window, duration };
  const shown = followWindowOf(form, ctx);
  const zoom = followWindowOf({ ...form, videoWindow: null }, ctx);
  const at = followWindowToSlider(shown, duration);
  const tick = followWindowToSlider(zoom, duration);
  const onTick = form.videoWindow === null;
  const text = windowText(shown);
  const tickLabel = `Editor’s zoom (${windowText(zoom)})`;
  return (
    <div className="field">
      <label htmlFor={`${id}-w`}>Window</label>
      <div className="field-row look-range">
        <span className="window-track">
          <input
            id={`${id}-w`}
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(at * 1000)}
            disabled={disabled}
            aria-valuetext={onTick ? `${text}, editor’s zoom` : text}
            aria-describedby={`${id}-t`}
            data-testid="export-window"
            onChange={(e) => {
              const x = Number(e.target.value) / 1000;
              const snap = windowSnaps(x, tick, keyed.current ? at : undefined);
              patch({ videoWindow: snap ? null : sliderToFollowWindow(x, duration) });
            }}
            onKeyDown={() => (keyed.current = true)}
            onPointerDown={() => (keyed.current = false)}
          />
          <span
            id={`${id}-t`}
            className="window-tick"
            role="img"
            aria-label={tickLabel}
            title={tickLabel}
            data-testid="export-window-tick"
            data-at={tick.toFixed(4)}
            style={{ '--at': tick } as CSSProperties}
          />
        </span>
        <output htmlFor={`${id}-w`} data-testid="export-window-value">
          {text}
        </output>
      </div>
    </div>
  );
}

/**
 * The Export dialog (PLAN.md §12, §15 M14 "Entry"): Video (with Poster | Video at the top, until
 * M15's video workspace) or Audio (WAV, stems, MIDI; Menu → Export audio…). A native modal
 * `<dialog>`, so focus is trapped, Escape closes it (cancelling a running export) and focus
 * returns to the menu button.
 */
export function ExportDialog() {
  const surface = useExportSurface((s) => s.surface);
  const open = surface === 'video' || surface === 'audio';
  const form = useExportUi((s) => s.form);
  const run = useExportUi((s) => s.run);
  const runtime = useRuntime(open);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const wide = useWide();
  useFocusRescue(dialog, open);

  // Undo and redo (camera edits) where no text field takes them. On the document: a clicked
  // button keeps no focus in WebKit, so the key may come from the body.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const text =
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLInputElement && !['range', 'radio', 'checkbox'].includes(t.type));
      const k = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey) || e.altKey || text || (k !== 'z' && k !== 'y')) return;
      e.preventDefault();
      if (useExportUi.getState().run.status === 'running') return;
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The Camera follows the piece's (undo and redo change it too).
  const camera = cameraChoice(form, piece);
  useEffect(() => {
    if (!open) return;
    const s = useExportUi.getState();
    if (s.form.videoCamera !== camera) {
      useExportUi.setState({ form: { ...s.form, videoCamera: camera } });
    }
  }, [open, camera]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  // Which codecs this browser would use at the chosen size (an async WebCodecs query).
  const vkey = videoKey(form);
  const wantVideo = open && runtime !== null && form.format === 'video';
  useEffect(() => {
    if (!wantVideo || !runtime || useExportUi.getState().video.key === vkey) return;
    useExportUi.setState({ video: { key: vkey, support: null } });
    const [aspect, size, fps] = vkey.split(' ');
    void runtime
      .videoSupport({
        aspect: aspect as ExportForm['videoAspect'],
        size: size as ExportForm['videoSize'],
        fps: Number(fps) as ExportForm['videoFps'],
      })
      .then(
        (support) => support,
        (e: unknown): VideoSupport => ({
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((support) => {
        if (useExportUi.getState().video.key === vkey) {
          useExportUi.setState({ video: { key: vkey, support } });
        }
      });
  }, [wantVideo, runtime, vkey]);
  // The size classes this browser encodes at the chosen aspect and fps, and at YouTube's.
  const skey = sizesKey(form);
  const sizes = useExportUi((s) => s.sizes);
  useEffect(() => {
    if (!wantVideo || !runtime) return;
    for (const key of new Set([skey, YOUTUBE_SIZES])) {
      if (useExportUi.getState().sizes[key]) continue;
      const [aspect, fps] = key.split(' ');
      void runtime
        .videoSizes({ aspect: aspect as ExportForm['videoAspect'], fps: Number(fps) as 30 | 60 })
        .then(
          (list) => useExportUi.setState((s) => ({ sizes: { ...s.sizes, [key]: list } })),
          () => undefined,
        );
    }
  }, [wantVideo, runtime, skey]);
  const sizeList = sizes[skey];
  const sizeOptions = VIDEO_SIZES.filter((o) =>
    sizeList
      ? sizeList.includes(o.id) || o.id === form.videoSize
      : o.id === '720' || o.id === '1080' || o.id === form.videoSize,
  );
  const bookendsOpen = useExportUi((s) => s.bookendsOpen);
  const videoState = useExportUi((s) => s.video);
  const support = form.format === 'video' && videoState.key === vkey ? videoState.support : null;

  const estimate = useMemo(
    () => (open ? estimateFor(runtime, piece, compiled, form) : null),
    [open, runtime, piece, compiled, form],
  );

  const running = run.status === 'running';
  const isVideo = surface === 'video' && form.format === 'video';
  const toDisk = (form.format === 'stems' || isVideo) && runtime?.canSaveToDisk() === true;
  const videoBlocked = isVideo && support?.ok !== true;
  const mpe = form.midiMode === 'mpe';
  const notes = form.midiMode === 'notesOnly';
  const hint = MIDI_MODES.find((m) => m.id === form.midiMode)?.hint;

  return (
    <dialog
      ref={dialog}
      className={isVideo ? 'dialog export has-preview' : 'dialog export'}
      aria-labelledby={`${id}-title`}
      data-testid="export-dialog"
      data-surface={surface ?? undefined}
      onClose={closeDialog}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDialog();
      }}
    >
      {open && (
        <form
          method="dialog"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startExport();
          }}
          // Only the Export button starts an export: Enter in a field never submits.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
          }}
        >
          <h2 id={`${id}-title`}>{surface === 'audio' ? 'Export audio' : 'Export video'}</h2>
          <p className="dialog-note">
            {piece.meta.title}: {Math.round(compiled.duration)} s, {piece.voices.length} notes.
          </p>

          <div className="export-body">
            <div className="export-format">
              {surface === 'audio' ? (
                <Radios
                  legend="Format"
                  name={`${id}-format`}
                  value={form.format}
                  options={AUDIO_FORMATS}
                  disabled={running}
                  testId="export-format"
                  onChange={(format) => patch({ format })}
                />
              ) : (
                <ExportModeSwitch
                  value="video"
                  onChange={(m) => {
                    if (m === 'poster') openSurface('poster');
                  }}
                />
              )}
            </div>

            {isVideo && <ExportPreview form={form} runtime={runtime} />}

            <div className="export-options">
              {isVideo && !wide && <VideoActions form={form} runtime={runtime} />}
              {isVideo && (
                <PresetField
                  form={form}
                  sizes={sizes[YOUTUBE_SIZES]}
                  disabled={running}
                  spanLength={sectionNow(form).end - sectionNow(form).start}
                  onPreset={(p) => void choosePreset(p)}
                />
              )}
              {isVideo && <SectionField form={form} disabled={running} />}

              {(form.format === 'wav' || form.format === 'stems') && (
                <>
                  <Radios
                    legend="Bit depth"
                    name={`${id}-depth`}
                    value={form.bitDepth}
                    options={BIT_DEPTHS}
                    disabled={running}
                    testId="export-depth"
                    onChange={(bitDepth) => patch({ bitDepth })}
                  />
                  <Radios
                    legend="Sample rate"
                    name={`${id}-rate`}
                    value={form.sampleRate}
                    options={RATES}
                    disabled={running}
                    testId="export-rate"
                    onChange={(sampleRate) => patch({ sampleRate })}
                  />
                </>
              )}
              {form.format === 'wav' && (
                <LoudnessField
                  form={form}
                  runtime={runtime}
                  disabled={running}
                  context={videoContext}
                  onChange={(loudness) => patch({ loudness })}
                />
              )}

              {form.format === 'stems' && (
                <div className="field">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={form.mono}
                      disabled={running}
                      data-testid="export-mono"
                      onChange={(e) => patch({ mono: e.target.checked })}
                    />
                    <span>Mono stems (half the size; the mix stays stereo)</span>
                  </label>
                  <small>
                    A zip of the mix, one stereo WAV per note and the effect returns. They add up to
                    the mix.
                  </small>
                </div>
              )}

              {form.format === 'midi' && (
                <>
                  <Radios
                    legend="Layout"
                    name={`${id}-mode`}
                    value={form.midiMode}
                    options={MIDI_MODES}
                    disabled={running}
                    testId="export-midi-mode"
                    onChange={(midiMode) => patch({ midiMode })}
                  />
                  <small className="export-hint" id={`${id}-midi-hint`}>
                    {hint}
                  </small>
                  <Radios
                    legend="Pitch-bend range (semitones)"
                    name={`${id}-bend`}
                    value={mpe ? 48 : form.bendRange}
                    options={BEND_RANGES}
                    disabled={running || mpe || notes}
                    testId="export-bend"
                    onChange={(bendRange) => patch({ bendRange })}
                  />
                  <div className="field">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={form.cc11}
                        disabled={running}
                        data-testid="export-cc11"
                        onChange={(e) => patch({ cc11: e.target.checked })}
                      />
                      <span title="Writes MIDI CC11 expression: pulse envelopes, crossfade fades and level gain">
                        CC11 expression (pulse, fades, level)
                      </span>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={form.restrike}
                        disabled={running}
                        data-testid="export-restrike"
                        onChange={(e) => patch({ restrike: e.target.checked })}
                      />
                      <span>Re-strike the note on every arrival (plucked sounds)</span>
                    </label>
                  </div>
                </>
              )}

              {isVideo && (
                <>
                  <Radios
                    legend="Aspect"
                    name={`${id}-aspect`}
                    value={form.videoAspect}
                    options={VIDEO_ASPECTS}
                    disabled={running}
                    testId="export-aspect"
                    onChange={(videoAspect) => patch({ videoAspect })}
                  />
                  <div className="field-pair">
                    <Radios
                      legend="Size"
                      name={`${id}-vsize`}
                      value={form.videoSize}
                      options={sizeOptions}
                      disabled={running}
                      testId="export-vsize"
                      hint="1440p and 4K get YouTube's better encoding, even for viewers at 1080p. Only the sizes this browser can encode are shown."
                      onChange={(videoSize) => patch({ videoSize })}
                    />
                    <Radios
                      legend="Frame rate"
                      name={`${id}-fps`}
                      value={form.videoFps}
                      options={VIDEO_FPS}
                      disabled={running}
                      testId="export-fps"
                      onChange={(videoFps) => patch({ videoFps })}
                    />
                  </div>
                  <Radios
                    legend="Quality"
                    name={`${id}-quality`}
                    value={form.videoQuality}
                    options={VIDEO_QUALITIES}
                    disabled={running}
                    testId="export-quality"
                    hint="The bitrate cap: High is YouTube's recommended upload rate, Standard 0.6×, Max 1.5×."
                    onChange={(videoQuality) => patch({ videoQuality })}
                  />
                  {aacNote(support) && (
                    <small
                      className="export-hint"
                      title={aacNote(support) ?? undefined}
                      data-testid="export-aac"
                    >
                      Audio is Opus here (no AAC encoder).
                    </small>
                  )}
                  <CameraField value={camera} disabled={running} ctl={cameraCtl} />
                  {form.videoCamera === 'follow' && (
                    <WindowField form={form} duration={compiled.duration} disabled={running} />
                  )}
                  <LoudnessField
                    form={form}
                    runtime={runtime}
                    disabled={running}
                    context={videoContext}
                    videoAudio={support?.ok === true ? support.audio : 'mp4a'}
                    onChange={(loudness) => patch({ loudness })}
                  />
                </>
              )}

              {isVideo && (
                <>
                  <Radios
                    legend="Theme"
                    name={`${id}-vtheme`}
                    value={form.look.theme}
                    options={VIDEO_THEMES}
                    disabled={running}
                    testId="export-vtheme"
                    onChange={(theme) => patchLook({ theme })}
                  />
                  <LookPanel form={form} kind="video" disabled={running} />
                </>
              )}
              {isVideo && (
                <BookendsGroup
                  form={form}
                  open={bookendsOpen}
                  disabled={running}
                  onToggle={(o) => useExportUi.setState({ bookendsOpen: o })}
                  onPatch={patch}
                />
              )}

              <RunStatus run={run}>
                {isVideo && runtime && support === null && (
                  <p className="export-size" data-testid="export-codec">
                    Checking this browser’s video encoders…
                  </p>
                )}
                {support?.ok === true && (
                  <p className="export-size" data-testid="export-codec">
                    {codecLabel(support.video, support.audio)}
                  </p>
                )}
                {support?.ok === false && (
                  <p className="export-warn" role="alert" data-testid="export-unsupported">
                    {support.reason}
                  </p>
                )}
                {estimate && support?.ok !== false && (
                  <p className="export-size" data-testid="export-size">
                    {form.format === 'stems'
                      ? `${estimate.files} files, ${formatBytes(estimate.bytes)} zipped`
                      : `${isVideo ? 'Up to' : 'About'} ${formatBytes(estimate.bytes)}`}
                    {estimate.zip64 && ' (ZIP64: some unzip tools need a recent version)'}
                  </p>
                )}
                {form.format === 'wav' && estimate === null && runtime === null && (
                  <p className="export-size">Loading the exporter…</p>
                )}
                {estimate?.large && support?.ok !== false && (
                  <p className="export-warn" role="alert" data-testid="export-large">
                    This export is large (over 1 GB).{' '}
                    {toDisk
                      ? 'It will be written straight to the file you pick, so memory stays low.'
                      : isVideo
                        ? 'This browser keeps the whole video in memory until it is saved. 720p or 30 fps make it smaller, or use Chrome or Edge to save straight to disk.'
                        : 'This browser keeps the whole zip in memory until it is saved. Mono or 16-bit make it smaller, or use Chrome or Edge to save straight to disk.'}
                  </p>
                )}
              </RunStatus>

              <div className="dialog-actions">
                {running ? (
                  <button type="button" data-testid="export-cancel" onClick={cancelExport}>
                    Cancel export
                  </button>
                ) : (
                  <button type="button" data-testid="export-close" onClick={closeDialog}>
                    Close
                  </button>
                )}
                <button
                  type="submit"
                  className="primary"
                  disabled={running || !runtime || videoBlocked}
                  data-testid="export-run"
                >
                  {RUN_LABEL[form.format]}
                </button>
              </div>
            </div>
          </div>
        </form>
      )}
    </dialog>
  );
}
