/**
 * The workspace's Video mode (PLAN.md §15 M15 "Panels"): the video plays the poster. The stage
 * holds the playing preview (`VideoPreview`); the right panel holds the video-only options
 * (preset, size, frame rate, quality, the camera, what moves, loudness, opening and ending,
 * thumbnail and description); the look lives in Poster and the video reads it. The bottom panel
 * is the timeline: the section's in and out handles, camera keys, the opening and ending cards,
 * and Export MP4 last.
 */

import { useEffect, useId, useMemo, useRef, type CSSProperties } from 'react';
import {
  VIDEO_ASPECTS,
  VIDEO_FPS,
  VIDEO_QUALITIES,
  VIDEO_SIZES,
  aacNote,
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
import { workspaceEscape } from '../export-surface';
import { cameraOf, usePlayer } from '../store';
import { formatTime } from '../../render/hud';
import { timelineCards } from '../video-timeline';
import { useFocusRescue } from './focus-rescue';
import { Radios, Switch } from './export-controls';
import type { CameraFrame, PosterText, RowBreak } from '../../core/types';
import { pieceRowBreak, pieceVideoFrame } from '../../render/poster-video';
import { textsOf } from '../../render/poster-edit';
import { edit } from '../editor/history';
import { withCameraFrame, withRowBreak } from '../editor/camera-keys';
import { editPoster } from '../poster-sync';
import { BookendsGroup, LoudnessField, PresetField, PreviewActions } from './ExportYoutube';
import { CameraField, KeyButtons, KeyMarkers, useCameraKeys } from './CameraKeys';
import { RunStatus, SectionField, VideoLookRows } from './ExportFields';
import { VideoPreview } from './VideoPreview';
import { backToMusic } from './PosterWorkspace';
import {
  RUN_LABEL,
  YOUTUBE_SIZES,
  cameraCtl,
  cancelExport,
  choosePreset,
  clockNow,
  estimateFor,
  patch,
  scrubPreview,
  sectionNow,
  sizesKey,
  startExport,
  togglePreview,
  useExportUi,
  useRuntime,
  videoContext,
  videoKey,
  type Runtime,
} from './export-state';
import './workspace.css';

/**
 * The browser's video encoders for the form's size (an async WebCodecs query) and the size
 * classes it encodes at the form's aspect and fps, and at YouTube's.
 */
function useVideoSupport(form: ExportForm, runtime: Runtime | null): VideoSupport | null {
  const vkey = videoKey(form);
  useEffect(() => {
    if (!runtime || useExportUi.getState().video.key === vkey) return;
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
  }, [runtime, vkey]);
  const skey = sizesKey(form);
  useEffect(() => {
    if (!runtime) return;
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
  }, [runtime, skey]);
  const video = useExportUi((s) => s.video);
  return video.key === vkey ? video.support : null;
}

/**
 * Follow’s Window (PLAN.md §12 "Video export"): seconds the frame shows at the chosen aspect, log
 * scale from 2 s to the whole piece. A tick under the track marks the default: the editor's zoom
 * (One row) or one row's height (Over the poster, placed at about a row's seconds); the slider
 * snaps to it when moved close, and on it the form keeps no window of its own (null).
 */
function WindowField({
  form,
  duration,
  poster,
  disabled,
}: {
  form: ExportForm;
  duration: number;
  poster: boolean;
  disabled: boolean;
}) {
  const id = useId();
  /** The last slider input came from the keyboard (snaps only toward the tick). */
  const keyed = useRef(false);
  const ctx = { window: cameraOf().window, duration };
  const span = sectionNow(form);
  const rowSeconds = (span.end - span.start) / Math.max(1, form.posterRows);
  const zoom = followWindowOf({ ...form, videoWindow: poster ? rowSeconds : null }, ctx);
  const onTick = form.videoWindow === null;
  const shown = onTick ? zoom : followWindowOf(form, ctx);
  const at = followWindowToSlider(shown, duration);
  const tick = followWindowToSlider(zoom, duration);
  const text = poster && onTick ? 'One row' : windowText(shown);
  const tickLabel = poster ? 'One row’s height' : `Editor’s zoom (${windowText(zoom)})`;
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
            aria-valuetext={onTick && !poster ? `${text}, editor’s zoom` : text}
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

const FRAMES: readonly { id: CameraFrame; label: string; hint: string }[] = [
  {
    id: 'poster',
    label: 'Over the poster',
    hint: 'A window over the poster, reading it row by row.',
  },
  { id: 'row', label: 'One row', hint: 'The music in one long row, with the poster’s styles.' },
];

const ROW_BREAKS: readonly { id: RowBreak; label: string }[] = [
  { id: 'pan', label: 'Pan' },
  { id: 'scroll', label: 'Scroll' },
  { id: 'cut', label: 'Cut' },
];

/** Frame (Over the poster | One row) and, over the poster, the row break: the piece's. */
function FrameFields({ disabled }: { disabled: boolean }) {
  const id = useId();
  const frame = usePlayer((s) => pieceVideoFrame(s.piece));
  const rowBreak = usePlayer((s) => pieceRowBreak(s.piece));
  return (
    <>
      <Radios
        legend="Frame"
        name={`${id}-frame`}
        value={frame}
        options={FRAMES}
        disabled={disabled}
        testId="video-frame"
        hint={FRAMES.find((f) => f.id === frame)?.hint}
        onChange={(f) => {
          useCameraKeys.setState({ selected: null });
          edit((p) => withCameraFrame(p, f), 'Camera frame');
        }}
      />
      {frame === 'poster' && (
        <Radios
          legend="Row break"
          name={`${id}-break`}
          value={rowBreak}
          options={ROW_BREAKS}
          disabled={disabled}
          testId="video-row-break"
          hint="How the frame reaches the next row: a smooth pan that lands as it starts, a scroll, or a cut."
          onChange={(b) => edit((p) => withRowBreak(p, b), 'Row break')}
        />
      )}
    </>
  );
}

/** A text box's name in the Travels list: its first line, else (or a template) its kind. */
function textName(t: PosterText): string {
  const line = t.text.split('\n')[0].trim();
  if (line && !/\{\w+\}/.test(line)) return line.length > 32 ? `${line.slice(0, 31)}…` : line;
  return t.kind === 'free' ? 'Text' : t.kind[0].toUpperCase() + t.kind.slice(1);
}

/**
 * Stays or travels (Over the poster): the HUD readouts (travel by default) and each text box
 * (stays by default) either stay on the poster or travel with the frame. Stored in the poster.
 */
function TravelsFields({ disabled }: { disabled: boolean }) {
  const doc = usePlayer((s) => s.piece.poster);
  const hud = doc?.groups?.hud?.travels ?? true;
  // The default title and credit too (a doc without texts has them).
  const texts = textsOf(doc);
  return (
    <div
      className="field travels"
      role="group"
      aria-label="Stays or travels"
      data-testid="video-travels"
    >
      <span className="field-label">Travels with the frame</span>
      <Switch
        label="HUD readouts"
        checked={hud}
        disabled={disabled}
        testId="travels-hud"
        onChange={(on) =>
          editPoster(
            (d) => ({
              ...d,
              groups: { ...d?.groups, hud: { ...d?.groups?.hud, travels: on } },
            }),
            'Readouts travel',
          )
        }
      />
      {texts.map((t) => (
        <Switch
          key={t.id}
          label={textName(t)}
          checked={t.travels === true}
          disabled={disabled}
          testId={`travels-text-${t.id}`}
          onChange={(on) =>
            editPoster(
              (d) => ({
                ...d,
                texts: textsOf(d).map((x) => {
                  if (x.id !== t.id) return x;
                  if (on) return { ...x, travels: true };
                  const { travels: _t, ...rest } = x;
                  return rest;
                }),
              }),
              'Text travels',
            )
          }
        />
      ))}
      <small className="export-hint">
        Off: it stays on the poster where it is
        {texts.length === 0 ? '. Text boxes are added in Poster' : ''}.
      </small>
    </div>
  );
}

/** The right panel: the video-only options (the look is Poster's). */
function VideoOptions({
  form,
  runtime,
  support,
  disabled,
}: {
  form: ExportForm;
  runtime: Runtime | null;
  support: VideoSupport | null;
  disabled: boolean;
}) {
  const id = useId();
  const piece = usePlayer((s) => s.piece);
  const duration = usePlayer((s) => s.compiled.duration);
  const sizes = useExportUi((s) => s.sizes);
  const bookendsOpen = useExportUi((s) => s.bookendsOpen);
  const t = useExportUi((s) => s.previewT);
  const sizeList = sizes[sizesKey(form)];
  const sizeOptions = VIDEO_SIZES.filter((o) =>
    sizeList
      ? sizeList.includes(o.id) || o.id === form.videoSize
      : o.id === '720' || o.id === '1080' || o.id === form.videoSize,
  );
  const camera = cameraChoice(form, piece);
  const span = sectionNow(form);
  const poster = pieceVideoFrame(piece) === 'poster';
  // Over the poster, Auto plays (and shows) as Follow: its Window and Playhead at apply.
  const shown: ExportForm =
    poster && form.videoCamera === 'auto' ? { ...form, videoCamera: 'follow' } : form;
  return (
    <div className="ws-options" data-testid="video-options">
      <PresetField
        form={form}
        sizes={sizes[YOUTUBE_SIZES]}
        disabled={disabled}
        spanLength={span.end - span.start}
        onPreset={(p) => void choosePreset(p)}
      />
      <Radios
        legend="Aspect"
        name={`${id}-aspect`}
        value={form.videoAspect}
        options={VIDEO_ASPECTS}
        disabled={disabled}
        testId="export-aspect"
        onChange={(videoAspect) => patch({ videoAspect })}
      />
      <div className="field-pair">
        <Radios
          legend="Size"
          name={`${id}-vsize`}
          value={form.videoSize}
          options={sizeOptions}
          disabled={disabled}
          testId="export-vsize"
          hint="1440p and 4K get YouTube's better encoding, even for viewers at 1080p. Only the sizes this browser can encode are shown."
          onChange={(videoSize) => patch({ videoSize })}
        />
        <Radios
          legend="Frame rate"
          name={`${id}-fps`}
          value={form.videoFps}
          options={VIDEO_FPS}
          disabled={disabled}
          testId="export-fps"
          onChange={(videoFps) => patch({ videoFps })}
        />
      </div>
      <Radios
        legend="Quality"
        name={`${id}-quality`}
        value={form.videoQuality}
        options={VIDEO_QUALITIES}
        disabled={disabled}
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
      <div className="ws-group ws-camera" data-testid="video-camera">
        <FrameFields disabled={disabled} />
        <CameraField value={camera} poster={poster} disabled={disabled} ctl={cameraCtl} />
        {shown.videoCamera === 'follow' && (
          <WindowField form={shown} duration={duration} poster={poster} disabled={disabled} />
        )}
        <VideoLookRows form={shown} ids={['follow-at']} disabled={disabled} />
      </div>
      <fieldset className="look ws-moving" disabled={disabled} data-testid="look">
        <legend>Moving</legend>
        <VideoLookRows
          form={form}
          ids={['future', 'playhead', 'heads']}
          hud
          poster={poster}
          disabled={disabled}
        />
        {poster && <TravelsFields disabled={disabled} />}
        <small className="export-hint">
          Colours, lines, labels and the readouts’ style are the poster’s: set them in Poster.
        </small>
      </fieldset>
      <LoudnessField
        form={form}
        runtime={runtime}
        disabled={disabled}
        context={videoContext}
        videoAudio={support?.ok === true ? support.audio : 'mp4a'}
        onChange={(loudness) => patch({ loudness })}
      />
      <BookendsGroup
        form={form}
        open={bookendsOpen}
        disabled={disabled}
        onToggle={(o) => useExportUi.setState({ bookendsOpen: o })}
        onPatch={patch}
      />
      <PreviewActions
        form={form}
        runtime={runtime}
        time={Math.min(Math.max(span.start, t), span.end)}
        disabled={disabled}
        context={videoContext}
        onPatch={patch}
      />
    </div>
  );
}

/** Opens Opening & ending in the right panel and brings it into view. */
function showBookends(): void {
  useExportUi.setState({ bookendsOpen: true });
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-testid="video-workspace"] [data-testid="bookends"]',
    );
    el?.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * The video's own clock as cards: the opening (lead-in, title), the music (the section) and the
 * ending (end card, ring-out), each as wide as it lasts. A card moves the preview to its start;
 * the opening and ending open their options.
 */
function CardsRow({ form, runtime }: { form: ExportForm; runtime: Runtime | null }) {
  const compiled = usePlayer((s) => s.compiled);
  const clock = useMemo(
    () => clockNow(form),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, compiled, runtime],
  );
  const cards = timelineCards(clock);
  const opening = cards.find((c) => c.id === 'opening');
  const ending = cards.find((c) => c.id === 'ending');
  const items = [
    opening ?? null,
    { id: 'music' as const, label: 'Music', start: clock.span.start, end: clock.span.end },
    ending ?? null,
  ];
  const len = (a: number, b: number) => Math.max(0, b - a);
  return (
    <div className="timeline-row" data-testid="timeline-cards">
      <span className="timeline-label">Video</span>
      <div className="timeline-cards">
        {items.map((c, i) =>
          c === null ? (
            <button
              key={i === 0 ? 'add-opening' : 'add-ending'}
              type="button"
              className="timeline-card add"
              data-testid={i === 0 ? 'card-add-opening' : 'card-add-ending'}
              title={i === 0 ? 'Add an opening' : 'Add an ending'}
              onClick={showBookends}
            >
              {i === 0 ? '+ Opening' : '+ Ending'}
            </button>
          ) : (
            <button
              key={c.id}
              type="button"
              className={`timeline-card ${c.id}`}
              data-testid={`card-${c.id}`}
              style={{ flexGrow: Math.max(0.0001, len(c.start, c.end)) }}
              title={`${c.label}: ${formatTime(len(c.start, c.end))}`}
              onClick={() => {
                scrubPreview(c.start);
                if (c.id !== 'music') showBookends();
              }}
            >
              <span>{c.label}</span>
              <small>{formatTime(len(c.start, c.end))}</small>
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Camera keys on the timeline (Keys), across the section's range only: keys outside the section
 * aren't on it, and a key stays inside it (as the old dialog's markers under its slider).
 */
function KeysRow({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  usePlayer((s) => s.compiled.duration);
  const keys = form.videoCamera === 'keys';
  const span = sectionNow(form);
  return (
    <div className="timeline-row" data-testid="timeline-keys">
      <span className="timeline-label">Keys</span>
      {keys ? (
        <div className="timeline-keys">
          <div className="timeline-lane">
            <KeyMarkers from={span.start} to={span.end} disabled={disabled} ctl={cameraCtl} />
          </div>
          <KeyButtons disabled={disabled} ctl={cameraCtl} />
        </div>
      ) : (
        <small className="export-hint timeline-note">
          Choose Keys under Camera to place camera keys here.
        </small>
      )}
    </div>
  );
}

/** The bottom panel: the timeline, then the export's status and Export MP4. */
function VideoTimeline({
  form,
  runtime,
  support,
}: {
  form: ExportForm;
  runtime: Runtime | null;
  support: VideoSupport | null;
}) {
  const run = useExportUi((s) => s.run);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const running = run.status === 'running';
  const estimate = useMemo(
    () => estimateFor(runtime, piece, compiled, form),
    [runtime, piece, compiled, form],
  );
  const toDisk = runtime?.canSaveToDisk() === true;
  return (
    <section className="ws-bottom export-panel video-timeline" aria-label="Timeline">
      <SectionField form={form} disabled={running} timeline />
      <KeysRow form={form} disabled={running} />
      <CardsRow form={form} runtime={runtime} />
      <div className="ws-foot timeline-foot">
        <RunStatus run={run}>
          {runtime && support === null && (
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
              Up to {formatBytes(estimate.bytes)}
            </p>
          )}
          {estimate?.large && support?.ok !== false && (
            <p className="export-warn" role="alert" data-testid="export-large">
              This export is large (over 1 GB).{' '}
              {toDisk
                ? 'It will be written straight to the file you pick, so memory stays low.'
                : 'This browser keeps the whole video in memory until it is saved. 720p or 30 fps make it smaller, or use Chrome or Edge to save straight to disk.'}
            </p>
          )}
        </RunStatus>
        <div className="dialog-actions">
          {running && (
            <button type="button" data-testid="export-cancel" onClick={cancelExport}>
              Cancel export
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={running || !runtime || support?.ok !== true}
            data-testid="export-run"
            onClick={startExport}
          >
            {RUN_LABEL.video}
          </button>
        </div>
      </div>
    </section>
  );
}

/** The workspace in Video mode, in place of the editor. */
export function VideoWorkspace() {
  const form = useExportUi((s) => s.form);
  const running = useExportUi((s) => s.run.status === 'running');
  const runtime = useRuntime(true);
  const piece = usePlayer((s) => s.piece);
  const root = useRef<HTMLElement>(null);
  const support = useVideoSupport(form, runtime);
  useFocusRescue(root, true);
  // Space plays and pauses the preview (a text field still types it).
  useEffect(() => setDialogSpace(togglePreview), []);

  // The Camera follows the piece's (undo and redo change it too).
  const camera = cameraChoice(form, piece);
  useEffect(() => {
    const s = useExportUi.getState();
    if (s.form.videoCamera !== camera) {
      useExportUi.setState({ form: { ...s.form, videoCamera: camera } });
    }
  }, [camera]);

  // Escape: blur a focused control, else back to music.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const what = workspaceEscape({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        focused: document.activeElement,
        root: root.current,
        selected: false,
        dialog: document.querySelector('dialog[open]') !== null,
      });
      if (!what) return;
      e.preventDefault();
      if (what === 'leave') backToMusic();
      else root.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <main
      className="poster-ws video-ws"
      ref={root}
      tabIndex={-1}
      aria-label="Video workspace"
      data-testid="video-workspace"
    >
      <section className="artboard video-stage" aria-label="Video preview">
        <VideoPreview form={form} runtime={runtime} disabled={running} />
      </section>
      <aside className="ws-side export-panel" aria-label="Video options">
        <VideoOptions form={form} runtime={runtime} support={support} disabled={running} />
      </aside>
      <VideoTimeline form={form} runtime={runtime} support={support} />
    </main>
  );
}
