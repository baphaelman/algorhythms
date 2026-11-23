import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import { evalSegment } from '../../core/segment';
import { formatTime } from '../../render/hud';
import { sectionText, type TimeSpan } from '../../render/section';
import { tokensOf } from '../../render/palettes';
import { videoSize } from '../../render/video';
import type { HudItem } from '../../render/types';
import { downloadBlob } from '../download';
import {
  BEND_RANGES,
  BIT_DEPTHS,
  DEFAULT_EXPORT_FORM,
  EXPORT_FORMATS,
  HUD_CHOICES,
  MIDI_MODES,
  POSTER_FORMATS,
  POSTER_MAX_AREA,
  POSTER_MAX_ROWS,
  POSTER_MAX_SIDE,
  POSTER_MIN_SIDE,
  POSTER_SIZES,
  RATES,
  SECTION_KINDS,
  VIDEO_ASPECTS,
  VIDEO_CAMERAS,
  VIDEO_FPS,
  VIDEO_SIZES,
  VIDEO_THEMES,
  codecLabel,
  defaultCustomSpan,
  exportFileName,
  followWindowOf,
  followWindowToSlider,
  formatBytes,
  gridOf,
  hudInOrder,
  clampPosterDims,
  loadExportPrefs,
  moveHandle,
  parseClock,
  posterCapped,
  posterPixels,
  posterPreset,
  resetLook,
  saveExportPrefs,
  sectionClock,
  sectionOf,
  sliderToFollowWindow,
  stepHandle,
  windowSnaps,
  windowText,
  type ExportForm,
  type LookForm,
  type SectionHandle,
  type VideoContext,
} from '../export-options';
import type { ExportEstimate, ExportOutput } from '../export-run';
import {
  defaultHud,
  followAtHint,
  hudSummary,
  lookControls,
  type LookControl,
  type LookFlags,
  type LookKind,
  type LookSegments,
  type LookSlider,
} from '../look-controls';
import type { VideoSupport } from '../video-export';
import { setDialogSpace } from '../space-key';
import {
  cameraOf,
  currentTime,
  loopRegion,
  pause,
  play,
  pushNotice,
  seekTo,
  usePlayer,
} from '../store';

/** The lazily loaded engine room (it pulls in the DSP graph, so it is not in the main chunk). */
type Runtime = typeof import('../export-run');

interface RunState {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  /** 0..1, or null while the size of the job is not known yet. */
  fraction: number | null;
  label: string;
  message: string;
}

interface ExportUi {
  open: boolean;
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
}

const RUN_LABEL: Record<ExportForm['format'], string> = {
  wav: 'Export WAV',
  stems: 'Export stems',
  midi: 'Export MIDI',
  video: 'Export video',
  poster: 'Export poster',
};

const IDLE: RunState = { status: 'idle', fraction: null, label: '', message: '' };

/** The dialog's state. It outlives the dialog, so reopening it keeps the last choices. */
const useExportUi = create<ExportUi>()(() => ({
  open: false,
  form: { ...DEFAULT_EXPORT_FORM },
  run: IDLE,
  runtime: null,
  video: { key: '', support: null },
  hudOpen: false,
  previewT: 0,
  previewPlaying: false,
}));

const videoKey = (f: ExportForm) => `${f.videoAspect} ${f.videoSize} ${f.videoFps}`;

/** The app's theme now, resolved (system → the browser's colour scheme). */
function appDark(): boolean {
  const { view } = usePlayer.getState();
  return (
    view.theme === 'dark' ||
    (view.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

/**
 * What the video and poster take from the app now: the editor's zoom, theme and line colours,
 * the piece's length and loop region.
 */
function videoContext(): VideoContext {
  const { view, compiled } = usePlayer.getState();
  const loop = loopRegion();
  return {
    window: cameraOf().window,
    duration: compiled.duration,
    dark: appDark(),
    colors: view.colors,
    loop: loop ? { start: loop.start, end: loop.end } : null,
  };
}

/** The span the form's Section shows now, or the whole piece. */
function sectionNow(form: ExportForm = useExportUi.getState().form): TimeSpan {
  const ctx = videoContext();
  return sectionOf(form, ctx) ?? { start: 0, end: ctx.duration ?? 0 };
}

/** A piece's identity for the Section's memory (it survives edits, not a different piece). */
function pieceKey(): string {
  const { piece } = usePlayer.getState();
  return `${piece.meta.created}|${piece.seed}`;
}

/** The Section chosen per piece, for the session (integrator call: not remembered on disk). */
const sections = new Map<string, Pick<ExportForm, 'section' | 'sectionSpan'>>();

/** The piece's remembered Section, else Whole. */
function sectionFor(key: string): Pick<ExportForm, 'section' | 'sectionSpan'> {
  return sections.get(key) ?? { section: 'whole', sectionSpan: null };
}

/** The editor's playhead when the dialog opened, and whether the preview has moved it since. */
let openPlayhead = 0;
let previewMoved = false;

/** Plays the video preview from its time, with sound, through the app's player. */
function playPreview(): void {
  const s = useExportUi.getState();
  if (s.previewPlaying || s.run.status === 'running') return;
  previewMoved = true;
  // Only the section plays: from the preview time, or its start when at (or past) its end.
  const span = sectionNow(s.form);
  const from = s.previewT >= span.end - 0.05 || s.previewT < span.start ? span.start : s.previewT;
  useExportUi.setState({ previewT: from });
  seekTo(from);
  play();
  useExportUi.setState({ previewPlaying: usePlayer.getState().transport.status === 'playing' });
}

/** Pauses the video preview where it is. */
function pausePreview(): void {
  if (!useExportUi.getState().previewPlaying) return;
  pause();
  useExportUi.setState({ previewPlaying: false, previewT: currentTime() });
}

/** Play/Pause preview, and Space anywhere in the dialog while the video preview shows. */
function togglePreview(): void {
  if (useExportUi.getState().previewPlaying) pausePreview();
  else playPreview();
}

/** Stops the preview and puts the editor's playhead back where it was when the dialog opened. */
function restorePlayhead(): void {
  useExportUi.setState({ previewPlaying: false });
  if (!previewMoved) return;
  previewMoved = false;
  pause();
  seekTo(openPlayhead);
}

let controller: AbortController | null = null;

/** Opens the Export dialog (the menu's Export item calls this). */
export function openExport(): void {
  const s = useExportUi.getState();
  // A finished or cancelled run's message is stale by the next time; a running one is kept.
  const running = s.run.status === 'running';
  // The preview starts at the editor's playhead, or a third in when it is at the start.
  const now = currentTime();
  const { duration } = usePlayer.getState().compiled;
  openPlayhead = now;
  previewMoved = false;
  // The remembered Look and video/poster choices (none if storage is unavailable), and this
  // piece's Section (Whole for a piece not exported this session).
  const form = running ? s.form : { ...s.form, ...loadExportPrefs(), ...sectionFor(pieceKey()) };
  const span = sectionNow(form);
  const t0 = now > 0 ? now : duration / 3;
  useExportUi.setState({
    open: true,
    previewPlaying: false,
    hudOpen: false,
    previewT: Math.min(Math.max(t0, span.start), span.end),
    run: running ? s.run : IDLE,
    form,
  });
}

/** Closes the dialog; a running export is cancelled. */
function closeExport(): void {
  cancelExport();
  restorePlayhead();
  useExportUi.setState({ open: false });
}

function cancelExport(): void {
  controller?.abort();
}

function patch(p: Partial<ExportForm>): void {
  useExportUi.setState((s) => ({ form: { ...s.form, ...p }, run: IDLE }));
  const { form } = useExportUi.getState();
  saveExportPrefs(form);
  if ('section' in p || 'sectionSpan' in p) {
    sections.set(pieceKey(), { section: form.section, sectionSpan: form.sectionSpan });
    // The preview time stays inside the section.
    const span = sectionNow(form);
    const { previewT, previewPlaying } = useExportUi.getState();
    const t = Math.min(Math.max(previewT, span.start), span.end);
    if (t !== previewT) {
      useExportUi.setState({ previewT: t });
      if (previewPlaying) seekTo(t);
    }
  }
}

function patchLook(p: Partial<LookForm>): void {
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

function estimateFor(
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

/** A group of radio buttons drawn as a segmented control (the Generate panel's look). */
function Radios<T extends string | number>({
  legend,
  name,
  value,
  options,
  disabled,
  testId,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly { id: T; label: string }[];
  disabled?: boolean;
  testId: string;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="field" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="seg radios" data-testid={testId}>
        {options.map((o) => (
          <label key={o.id} className={value === o.id ? 'on' : undefined}>
            <input
              type="radio"
              name={name}
              value={String(o.id)}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A yes/no choice as a switch (checkbox role="switch": Space toggles, aria-checked), label left. */
function Switch({
  checked,
  disabled,
  testId,
  label,
  className,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  testId: string;
  label: string;
  className?: string;
  onChange: (v: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <label className={className ? `look-switch ${className}` : 'look-switch'}>
      <span className="switch-text">
        <span>{label}</span>
        {children}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** Segmented buttons in the Look grid: a label, then a radio group drawn as one bar. */
function LookSegmentsRow({
  control,
  form,
  disabled,
}: {
  control: LookSegments;
  form: ExportForm;
  disabled?: boolean;
}) {
  const id = useId();
  const value = control.value(form);
  return (
    <>
      <span className="look-label" id={`${id}-label`}>
        {control.label}
      </span>
      <div
        className="seg radios look-seg"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        data-testid={`look-${control.id}`}
        data-value={value}
      >
        {control.choices.map((c) => (
          <label key={c.value} className={value === c.value ? 'on' : undefined}>
            <input
              type="radio"
              name={`${id}-r`}
              value={c.value}
              checked={value === c.value}
              disabled={disabled}
              onChange={() => patch(control.apply(useExportUi.getState().form, c.value))}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

/** Independent flags drawn as segments, each lit when on (checkboxes, so Space toggles). */
function LookFlagsRow({
  control,
  form,
  disabled,
}: {
  control: LookFlags;
  form: ExportForm;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <>
      <span className="look-label" id={`${id}-label`}>
        {control.label}
      </span>
      <div
        className="seg radios look-seg"
        role="group"
        aria-labelledby={`${id}-label`}
        data-testid={`look-${control.id}`}
      >
        {control.flags.map((f) => {
          const on = form.look[f.key];
          return (
            <label key={f.id} className={on ? 'on' : undefined}>
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                data-testid={`look-${control.id}-${f.id}`}
                onChange={(e) => patchLook({ [f.key]: e.target.checked })}
              />
              <span>{f.label}</span>
            </label>
          );
        })}
      </div>
    </>
  );
}

/** A slider in the Look grid, its value shown beside it. */
function LookSliderRow({
  control,
  form,
  disabled,
}: {
  control: LookSlider;
  form: ExportForm;
  disabled?: boolean;
}) {
  const id = useId();
  const value = control.value(form);
  const text = control.text(value);
  return (
    <>
      <label htmlFor={id}>{control.label}</label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={value}
          disabled={disabled}
          aria-valuetext={text}
          data-testid={`look-${control.id}`}
          onChange={(e) =>
            patch(control.apply(useExportUi.getState().form, Number(e.target.value)))
          }
        />
        <output htmlFor={id} data-testid={`look-${control.id}-value`}>
          {text}
        </output>
      </div>
    </>
  );
}

/** One Look control: a switch row, segments or a slider. */
function LookRow({
  control,
  form,
  disabled,
}: {
  control: LookControl;
  form: ExportForm;
  disabled?: boolean;
}) {
  switch (control.type) {
    case 'toggle':
      return (
        <Switch
          label={control.label}
          checked={control.value(form)}
          disabled={disabled}
          testId={`look-${control.id}`}
          onChange={(on) => patch(control.apply(useExportUi.getState().form, on))}
        />
      );
    case 'segments':
      return <LookSegmentsRow control={control} form={form} disabled={disabled} />;
    case 'flags':
      return <LookFlagsRow control={control} form={form} disabled={disabled} />;
    case 'slider':
      return <LookSliderRow control={control} form={form} disabled={disabled} />;
  }
}

/**
 * The HUD: a disclosure row ("HUD · 6 readouts") that expands in place with a height animation
 * (none under prefers-reduced-motion), one switch per readout with its sample, and None /
 * Default. No popup and no document listeners: it stays open until its row is pressed again.
 * Collapsed, the list stays in the DOM (so it can animate) but is inert and hidden.
 */
function HudSection({ form, kind }: { form: ExportForm; kind: LookKind }) {
  const open = useExportUi((s) => s.hudOpen);
  const pieceName = usePlayer((s) => s.piece.meta.title);
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const video = kind === 'video';
  const hud = video ? form.videoHud : form.posterHud;
  const setHud = (items: readonly HudItem[]) =>
    patch(video ? { videoHud: hudInOrder(items) } : { posterHud: hudInOrder(items) });

  useLayoutEffect(() => {
    if (panel.current) panel.current.inert = !open;
  }, [open]);

  return (
    <div className="hud-section">
      <button
        type="button"
        className="hud-row"
        id={`${id}-button`}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        data-testid="look-hud-button"
        onClick={() => useExportUi.setState({ hudOpen: !open })}
      >
        <span>HUD · {hudSummary(hud)}</span>
        <span className="hud-chevron" aria-hidden="true" />
      </button>
      <div
        ref={panel}
        className={open ? 'hud-panel open' : 'hud-panel'}
        id={`${id}-list`}
        role="group"
        aria-label="HUD readouts"
        data-testid="look-hud"
      >
        <div className="hud-inner">
          <div className="hud-quick">
            <button type="button" data-testid="hud-none" onClick={() => setHud([])}>
              None
            </button>
            <button
              type="button"
              data-testid="hud-default"
              onClick={() => setHud(defaultHud(kind))}
            >
              Default
            </button>
          </div>
          {HUD_CHOICES.map((c) => (
            <Switch
              key={c.id}
              className="hud-item"
              label={c.label}
              checked={hud.includes(c.id)}
              testId={`hud-${c.id}`}
              onChange={(on) => setHud(on ? [...hud, c.id] : hud.filter((h) => h !== c.id))}
            >
              <small className="hud-sample">
                {c.id === 'title' ? pieceName || 'Untitled' : c.sample}
              </small>
            </Switch>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The Look section (PLAN.md §12 "Export look"), shared by video and poster: sliders, switches
 * and segments in a label / control grid, the HUD and Reset.
 */
function LookPanel({
  form,
  kind,
  disabled,
}: {
  form: ExportForm;
  kind: LookKind;
  disabled: boolean;
}) {
  const id = useId();
  const look = form.look;
  const follow = form.videoCamera === 'follow';
  const dark = look.theme === 'current' ? appDark() : look.theme === 'dark';
  const ink = look.lineInk ?? tokensOf(dark ? 'dark' : 'light').ink;

  return (
    <fieldset className="look" disabled={disabled} data-testid="look">
      <legend>Look</legend>
      <div className="look-grid">
        {lookControls(kind).map((c) => (
          <Fragment key={c.id}>
            <LookRow control={c} form={form} disabled={c.id === 'follow-at' && !follow} />
            {c.id === 'follow-at' && (
              <small className="look-note" data-testid="look-follow-at-hint">
                {followAtHint(form)}
              </small>
            )}
            {c.id === 'colors' && (look.colors === 'ink' || look.colors === 'custom') && (
              <>
                <label htmlFor={`${id}-ink`}>
                  {look.colors === 'ink' ? 'Line colour' : 'Lines without a colour'}
                </label>
                <div className="field-row">
                  <input
                    id={`${id}-ink`}
                    type="color"
                    value={ink}
                    data-testid="look-ink"
                    onChange={(e) => patchLook({ lineInk: e.target.value })}
                  />
                  {look.lineInk !== null && (
                    <button
                      type="button"
                      data-testid="look-ink-reset"
                      onClick={() => patchLook({ lineInk: null })}
                    >
                      Theme ink
                    </button>
                  )}
                </div>
              </>
            )}
          </Fragment>
        ))}
        <HudSection form={form} kind={kind} />
      </div>
      <button
        type="button"
        className="look-reset"
        data-testid="look-reset"
        onClick={() => {
          useExportUi.setState((s) => ({ form: resetLook(s.form), run: IDLE }));
          saveExportPrefs(useExportUi.getState().form);
        }}
      >
        Reset to defaults
      </button>
    </fieldset>
  );
}

/** The export's pixel size (the renderers' own). */
function exportPixels(form: ExportForm, kind: LookKind): { width: number; height: number } {
  return kind === 'poster'
    ? { width: form.posterWidth, height: form.posterHeight }
    : videoSize(form.videoAspect, form.videoSize);
}

/**
 * Counters of the preview's measure and scroll-padding callbacks and draws, and the last and
 * longest draw (ms; debug hook).
 */
export const previewStats = { measures: 0, pads: 0, draws: 0, lastMs: 0, maxMs: 0 };

/** Wide screens show the preview beside the options (styles.css uses the same width). */
const WIDE = '(min-width: 900px)';

/** The preview's box (CSS px): the column's width, at most this tall. */
function previewMaxHeight(wide: boolean): number {
  return wide ? Math.min(440, innerHeight * 0.62) : Math.min(170, innerHeight * 0.27);
}

/**
 * The live preview (PLAN.md §12 "Preview and layout"): the video frame at the chosen time, or
 * the whole poster, drawn by the export's own code (`export-run` preview functions) at a small
 * size, redrawn at most once per animation frame on any change. Video adds a time slider.
 */
function ExportPreview({
  form,
  kind,
  runtime,
}: {
  form: ExportForm;
  kind: LookKind;
  runtime: Runtime | null;
}) {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  // The app's theme and line colours feed 'Current' and 'As in the app'.
  const appView = usePlayer((s) => `${s.view.theme} ${s.view.colors}`);
  const t = useExportUi((s) => s.previewT);
  const playing = useExportUi((s) => s.previewPlaying);
  const running = useExportUi((s) => s.run.status === 'running');
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const draws = useRef(0);
  const frame = useRef(0);
  const job = useRef<(() => void) | null>(null);
  const id = useId();

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

  // Video: Space anywhere in the dialog plays and pauses the preview (space-key.ts); leaving
  // video (or closing) stops it.
  useEffect(() => {
    if (kind !== 'video') return;
    const off = setDialogSpace(togglePreview);
    return () => {
      off();
      pausePreview();
    };
  }, [kind]);

  // Playing: the time follows the playhead every frame (the draw below runs once per frame); the
  // player stopping (the end, or anything else) stops the preview.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const now = currentTime();
      const span = sectionNow();
      if (usePlayer.getState().transport.status !== 'playing') {
        useExportUi.setState({ previewPlaying: false, previewT: now });
        return;
      }
      // Only the section plays: stop at its end (or if the player left it, e.g. a loop's wrap).
      if (now >= span.end - 1e-3 || now < span.start - 0.05) {
        pause();
        const at = Math.min(Math.max(now, span.start), span.end);
        useExportUi.setState({ previewPlaying: false, previewT: at });
        return;
      }
      if (useExportUi.getState().previewT !== now) useExportUi.setState({ previewT: now });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const px = exportPixels(form, kind);
  const aspect = px.width / px.height;
  const cssW = Math.max(1, Math.floor(Math.min(avail.w, avail.h * aspect)));
  const cssH = Math.max(1, Math.round(cssW / aspect));
  const dpr = Math.min(2, devicePixelRatio || 1);
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.max(1, Math.round((px.height * pxW) / px.width));
  const span = sectionNow(form);
  const time = Math.min(Math.max(span.start, t), span.end);

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
      if (kind === 'video') runtime.previewVideo(g, src, form, videoContext(), time, scale);
      else runtime.previewPosterOf(g, src, form, videoContext(), scale);
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
  }, [runtime, piece, compiled, form, kind, time, pxW, pxH, px.width, appView, avail.w]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  const transparent = kind === 'poster' && form.look.transparent;
  const what =
    kind === 'video'
      ? `Preview of the video frame at ${formatTime(time)}, ${form.videoAspect}`
      : `Preview of the poster, ${POSTER_SIZES.find((p) => p.id === posterPreset(form))?.label ?? posterPixels(form)}` +
        (form.posterRows > 1 ? `, ${form.posterRows} rows` : '') +
        (transparent ? ', transparent background' : '');

  return (
    <div className="export-preview" data-testid="export-preview" ref={wrap}>
      <div className="preview-box" ref={box}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={what}
          className={transparent ? 'checker' : undefined}
          data-testid="preview-canvas"
          data-t={kind === 'video' ? time.toFixed(3) : undefined}
          style={{ width: `${cssW}px`, height: `${cssH}px` }}
        />
      </div>
      {kind === 'video' && (
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
          <input
            id={`${id}-t`}
            type="range"
            min={span.start}
            max={Math.max(span.start + 0.1, span.end)}
            step={0.1}
            value={time}
            data-testid="preview-time"
            onChange={(e) => {
              const v = Number(e.target.value);
              useExportUi.setState({ previewT: v });
              if (useExportUi.getState().previewPlaying) seekTo(v);
            }}
          />
          <output htmlFor={`${id}-t`}>{formatTime(time)}</output>
        </div>
      )}
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

/** A slider field with its value shown beside it (Rows, Width, Height). */
function RangeField({
  label,
  min,
  max,
  value,
  text,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  text: string;
  disabled: boolean;
  testId: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          aria-valuetext={text}
          data-testid={testId}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id} data-testid={`${testId}-value`}>
          {text}
        </output>
      </div>
    </div>
  );
}

/**
 * The poster's Rows, Width and Height sliders and the size quick picks (PLAN.md §12 "Rows and
 * dimensions"). Each side keeps a fixed range (a max that followed the other side moved this
 * thumb while its number stayed); a dragged side stops where width × height reaches the cap.
 */
function PosterSizeFields({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  const id = useId();
  const w = form.posterWidth;
  const h = form.posterHeight;
  return (
    <>
      <RangeField
        label="Rows"
        min={1}
        max={POSTER_MAX_ROWS}
        value={form.posterRows}
        text={form.posterRows === 1 ? '1 row' : `${form.posterRows} rows`}
        disabled={disabled}
        testId="export-prows"
        onChange={(posterRows) => patch({ posterRows })}
      />
      <Radios
        legend="Size"
        name={`${id}-psize`}
        value={posterPreset(form) ?? ''}
        options={POSTER_SIZES}
        disabled={disabled}
        testId="export-psize"
        onChange={(p) => {
          const o = POSTER_SIZES.find((x) => x.id === p);
          if (o) patch({ posterWidth: o.width, posterHeight: o.height });
        }}
      />
      <RangeField
        label="Width"
        min={POSTER_MIN_SIDE}
        max={POSTER_MAX_SIDE}
        value={w}
        text={`${w} px`}
        disabled={disabled}
        testId="export-pwidth"
        onChange={(v) => {
          const d = clampPosterDims(v, h, 'height');
          patch({ posterWidth: d.width, posterHeight: d.height });
        }}
      />
      <RangeField
        label="Height"
        min={POSTER_MIN_SIDE}
        max={POSTER_MAX_SIDE}
        value={h}
        text={`${h} px`}
        disabled={disabled}
        testId="export-pheight"
        onChange={(v) => {
          const d = clampPosterDims(w, v, 'width');
          patch({ posterWidth: d.width, posterHeight: d.height });
        }}
      />
      {posterCapped(w, h) && (
        <small className="export-hint" data-testid="export-pcap">
          Capped at {(POSTER_MAX_AREA / 1e6).toFixed(1)} million pixels, the largest image every
          browser can draw (Safari’s limit). {POSTER_MAX_SIDE} px is the most for one side.
        </small>
      )}
    </>
  );
}

/** Overview height, CSS px. */
const OVERVIEW_H = 48;

/**
 * The piece in miniature for the Section's range: every line as a thin polyline (one sample per
 * 2 px) and the section labels at their markers, x = t / duration · width (the handles use the
 * same mapping).
 */
function drawOverview(
  c: HTMLCanvasElement,
  compiled: ReturnType<typeof usePlayer.getState>['compiled'],
  labels: readonly { t: number; text: string }[],
  dark: boolean,
): void {
  const g = c.getContext('2d');
  if (!g) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w === 0 || h === 0) return;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tk = tokensOf(dark ? 'dark' : 'light');
  g.clearRect(0, 0, w, h);
  const D = Math.max(1e-6, compiled.duration);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of compiled.voices) {
    for (const sg of v.segments) {
      lo = Math.min(lo, sg.p0, sg.p1);
      hi = Math.max(hi, sg.p0, sg.p1);
    }
  }
  if (!(hi > lo)) {
    lo -= 6;
    hi += 6;
  }
  const top = 13;
  const bottom = h - 3;
  const y = (p: number) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);
  g.strokeStyle = tk.ink2;
  g.globalAlpha = 0.85;
  g.lineWidth = 1;
  g.lineJoin = 'round';
  for (const v of compiled.voices) {
    for (const sg of v.segments) {
      const x0 = (sg.t0 / D) * w;
      const x1 = (sg.t1 / D) * w;
      g.beginPath();
      g.moveTo(x0, y(sg.p0));
      if (sg.p0 !== sg.p1 || sg.curve) {
        for (let x = x0 + 2; x < x1; x += 2) g.lineTo(x, y(evalSegment(sg, (x / w) * D)));
      }
      g.lineTo(Math.max(x1, x0 + 0.5), y(sg.p1));
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  g.font = `500 8.5px ${getComputedStyle(c).fontFamily}`;
  g.fillStyle = tk.ink2;
  g.strokeStyle = tk.rule;
  let lastEnd = -1e9;
  for (const l of labels) {
    const x = Math.round((l.t / D) * w) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    const text = l.text.toUpperCase();
    const tw = g.measureText(text).width;
    if (x >= lastEnd + 6 && x + 3 + tw < w) {
      g.fillText(text, x + 3, 9);
      lastEnd = x + 3 + tw;
    }
  }
}

/** A handle's time typed in a text field ("1:05.5" or seconds), committed on Enter or blur. */
function ClockInput({
  label,
  value,
  disabled,
  testId,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  testId: string;
  onCommit: (t: number) => void;
}) {
  const shown = sectionClock(value);
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const t = parseClock(text);
    setText(null);
    if (t !== null) onCommit(t);
  };
  return (
    <label className="section-clock">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        spellCheck={false}
        value={text ?? shown}
        disabled={disabled}
        aria-invalid={text !== null && parseClock(text) === null}
        data-testid={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape' && text !== null) {
            e.preventDefault();
            e.stopPropagation();
            setText(null);
          }
        }}
      />
    </label>
  );
}

/**
 * The Section (PLAN.md §12 "Exports you can shape"): Whole piece, Loop region (when the piece
 * has one) or Custom, a two-handle range over the piece in miniature. Handles snap to bar lines
 * when the piece has a tempo (Alt: free); each is a slider (arrows: a bar, or a second without a
 * tempo; Shift: four; Alt: 0.1 s; Home / End), and the times can be typed.
 */
function SectionField({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  const id = useId();
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const appView = usePlayer((s) => s.view.theme);
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<SectionHandle | null>(null);
  const [width, setWidth] = useState(0);
  const D = compiled.duration;
  const grid = gridOf(piece);
  const loop = loopRegion();
  const kinds = SECTION_KINDS.filter((k) => k.id !== 'loop' || loop !== null);
  // Loop without a loop region (it was removed) shows as Whole.
  const kind = form.section === 'loop' && !loop ? 'whole' : form.section;
  const span = sectionNow(form);
  const custom = kind === 'custom';
  const cspan = form.sectionSpan ?? span;

  const labels = useMemo(() => {
    const out: { t: number; text: string }[] = [];
    for (const m of piece.moments) if (m.label) out.push({ t: m.at, text: m.label });
    return out.sort((a, b) => a.t - b.t);
  }, [piece.moments]);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => setWidth((w) => (w === el.clientWidth ? w : el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [custom]);

  useEffect(() => {
    if (custom && canvas.current && width > 0) {
      drawOverview(canvas.current, compiled, labels, appDark());
    }
  }, [custom, compiled, labels, width, appView]);

  const setSpan = (next: TimeSpan) => {
    const cur = useExportUi.getState().form.sectionSpan;
    if (cur && cur.start === next.start && cur.end === next.end) return;
    patch({ sectionSpan: next });
  };
  const timeAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return (Math.min(Math.max(clientX - r.left, 0), r.width) / r.width) * D;
  };
  const onMove = (e: React.PointerEvent) => {
    const h = drag.current;
    if (!h) return;
    const cur = useExportUi.getState().form.sectionSpan ?? cspan;
    setSpan(moveHandle(cur, h, timeAt(e.clientX), D, grid, e.altKey));
  };
  const startDrag = (e: React.PointerEvent, h: SectionHandle) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    drag.current = h;
    track.current?.setPointerCapture(e.pointerId);
    (track.current?.querySelector(`[data-handle="${h}"]`) as HTMLElement | null)?.focus();
    onMove(e);
  };

  const pct = (t: number) =>
    `${(Math.min(Math.max(t / Math.max(D, 1e-6), 0), 1) * 100).toFixed(3)}%`;
  const handle = (h: SectionHandle) => {
    const t = cspan[h];
    const name = h === 'start' ? 'Section start' : 'Section end';
    return (
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={Math.round(D * 10) / 10}
        aria-valuenow={Math.round(t * 10) / 10}
        aria-valuetext={sectionClock(t)}
        aria-disabled={disabled || undefined}
        aria-describedby={`${id}-keys`}
        className={`section-handle ${h}`}
        data-handle={h}
        data-testid={`section-${h}`}
        style={{ left: pct(t) }}
        onPointerDown={(e) => {
          e.stopPropagation();
          startDrag(e, h);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          const next = stepHandle(cspan, h, e.key, { shift: e.shiftKey, alt: e.altKey }, D, grid);
          if (!next) return;
          e.preventDefault();
          setSpan(next);
        }}
      />
    );
  };

  return (
    <div className="section-field" data-testid="export-section-field">
      <Radios
        legend="Section"
        name={`${id}-section`}
        value={kind}
        options={kinds}
        disabled={disabled}
        testId="export-section"
        onChange={(section) => {
          if (section === 'custom' && !useExportUi.getState().form.sectionSpan) {
            patch({ section, sectionSpan: defaultCustomSpan(D, cameraOf(), loop, grid) });
          } else patch({ section });
        }}
      />
      {custom && (
        <>
          <div
            ref={track}
            className={disabled ? 'section-range disabled' : 'section-range'}
            data-testid="section-range"
            style={{ height: `${OVERVIEW_H}px` }}
            onPointerDown={(e) => {
              // A press on the track moves the nearer handle there.
              const t = timeAt(e.clientX);
              startDrag(e, Math.abs(t - cspan.start) <= Math.abs(t - cspan.end) ? 'start' : 'end');
            }}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <canvas
              ref={canvas}
              className="section-overview"
              role="img"
              aria-label="The piece in miniature"
              data-testid="section-overview"
            />
            <div className="section-shade" style={{ left: 0, width: pct(cspan.start) }} />
            <div className="section-shade" style={{ left: pct(cspan.end), right: 0 }} />
            <div
              className="section-sel"
              style={{
                left: pct(cspan.start),
                width: `calc(${pct(cspan.end)} - ${pct(cspan.start)})`,
              }}
            />
            {handle('start')}
            {handle('end')}
          </div>
          <small className="visually-hidden" id={`${id}-keys`}>
            {grid
              ? 'Arrow keys move by a bar, Shift by four bars, Alt by a tenth of a second.'
              : 'Arrow keys move by a second, Shift by ten, Alt by a tenth.'}
          </small>
          <div className="field-row section-times">
            <ClockInput
              label="Start"
              value={cspan.start}
              disabled={disabled}
              testId="section-start-text"
              onCommit={(t) => setSpan(moveHandle(cspan, 'start', t, D, undefined, true))}
            />
            <ClockInput
              label="End"
              value={cspan.end}
              disabled={disabled}
              testId="section-end-text"
              onCommit={(t) => setSpan(moveHandle(cspan, 'end', t, D, undefined, true))}
            />
          </div>
        </>
      )}
      {kind !== 'whole' && (
        <small className="export-hint" data-testid="section-summary">
          {sectionText(span, D)} ({Math.round((span.end - span.start) * 10) / 10} s)
          {grid ? (custom ? '. Snaps to bars; hold Alt to place freely.' : '') : ''}
        </small>
      )}
    </div>
  );
}

/**
 * The Export dialog (PLAN.md §12): WAV, stems, MIDI, video and poster. A native modal `<dialog>`, so focus is
 * trapped, Escape closes it (cancelling a running export) and focus returns to the menu button.
 */
export function ExportDialog() {
  const open = useExportUi((s) => s.open);
  const form = useExportUi((s) => s.form);
  const run = useExportUi((s) => s.run);
  const runtime = useExportUi((s) => s.runtime);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  // Load the engine room as soon as the dialog opens, so the click handler can use it directly.
  useEffect(() => {
    if (!open || runtime) return;
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
  }, [open, runtime]);

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
  const videoState = useExportUi((s) => s.video);
  const support = form.format === 'video' && videoState.key === vkey ? videoState.support : null;

  const estimate = useMemo(
    () => (open ? estimateFor(runtime, piece, compiled, form) : null),
    [open, runtime, piece, compiled, form],
  );

  const running = run.status === 'running';
  const isVideo = form.format === 'video';
  const isPoster = form.format === 'poster';
  const toDisk = (form.format === 'stems' || isVideo) && runtime?.canSaveToDisk() === true;
  const videoBlocked = isVideo && support?.ok !== true;
  const cameraHint = VIDEO_CAMERAS.find((c) => c.id === form.videoCamera)?.hint;
  const mpe = form.midiMode === 'mpe';
  const notes = form.midiMode === 'notesOnly';
  const hint = MIDI_MODES.find((m) => m.id === form.midiMode)?.hint;

  return (
    <dialog
      ref={dialog}
      className={isVideo || isPoster ? 'dialog export has-preview' : 'dialog export'}
      aria-labelledby={`${id}-title`}
      data-testid="export-dialog"
      onClose={closeExport}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeExport();
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
        >
          <h2 id={`${id}-title`}>Export</h2>
          <p className="dialog-note">
            {piece.meta.title}: {Math.round(compiled.duration)} s, {piece.voices.length} notes.
          </p>

          <div className="export-body">
            <div className="export-format">
              <Radios
                legend="Format"
                name={`${id}-format`}
                value={form.format}
                options={EXPORT_FORMATS}
                disabled={running}
                testId="export-format"
                onChange={(format) => patch({ format })}
              />
            </div>

            {(isVideo || isPoster) && (
              <ExportPreview form={form} kind={isPoster ? 'poster' : 'video'} runtime={runtime} />
            )}

            <div className="export-options">
              {(isVideo || isPoster) && <SectionField form={form} disabled={running} />}

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
                      options={VIDEO_SIZES}
                      disabled={running}
                      testId="export-vsize"
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
                    legend="Camera"
                    name={`${id}-camera`}
                    value={form.videoCamera}
                    options={VIDEO_CAMERAS}
                    disabled={running}
                    testId="export-camera"
                    onChange={(videoCamera) => patch({ videoCamera })}
                  />
                  <small className="export-hint">{cameraHint}</small>
                  {form.videoCamera === 'follow' && (
                    <WindowField form={form} duration={compiled.duration} disabled={running} />
                  )}
                </>
              )}

              {isPoster && (
                <>
                  <Radios
                    legend="File"
                    name={`${id}-pformat`}
                    value={form.posterFormat}
                    options={POSTER_FORMATS}
                    disabled={running}
                    testId="export-pformat"
                    onChange={(posterFormat) => patch({ posterFormat })}
                  />
                  <PosterSizeFields form={form} disabled={running} />
                  <div className="field">
                    <Switch
                      checked={form.posterTitle}
                      disabled={running}
                      testId="export-ptitle"
                      label="Title block (name, length, key)"
                      onChange={(posterTitle) => patch({ posterTitle })}
                    />
                  </div>
                  {sectionOf(form, videoContext()) && (
                    <div className="field">
                      <Switch
                        checked={form.posterPieceRange}
                        disabled={running}
                        testId="export-prange"
                        label="Piece’s pitch range"
                        onChange={(posterPieceRange) => patch({ posterPieceRange })}
                      >
                        <small className="hud-sample">
                          Off: the pitch range fits the section’s lines
                        </small>
                      </Switch>
                    </div>
                  )}
                </>
              )}

              {(isVideo || isPoster) && (
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
                  <LookPanel form={form} kind={isPoster ? 'poster' : 'video'} disabled={running} />
                </>
              )}

              <div className="export-status" aria-live="polite" data-testid="export-status">
                {!running && isVideo && runtime && support === null && (
                  <p className="export-size" data-testid="export-codec">
                    Checking this browser’s video encoders…
                  </p>
                )}
                {!running && support?.ok === true && (
                  <p className="export-size" data-testid="export-codec">
                    {codecLabel(support.video, support.audio)}
                  </p>
                )}
                {!running && support?.ok === false && (
                  <p className="export-warn" role="alert" data-testid="export-unsupported">
                    {support.reason}
                  </p>
                )}
                {!running && estimate && support?.ok !== false && (
                  <p className="export-size" data-testid="export-size">
                    {form.format === 'stems'
                      ? `${estimate.files} files, ${formatBytes(estimate.bytes)} zipped`
                      : `${isVideo ? 'Up to' : 'About'} ${formatBytes(estimate.bytes)}`}
                    {estimate.zip64 && ' (ZIP64: some unzip tools need a recent version)'}
                  </p>
                )}
                {!running && isPoster && (
                  <p className="export-size" data-testid="export-size">
                    {posterPixels(form)}, {form.posterFormat.toUpperCase()}
                  </p>
                )}
                {!running && form.format === 'wav' && estimate === null && runtime === null && (
                  <p className="export-size">Loading the exporter…</p>
                )}
                {!running && estimate?.large && support?.ok !== false && (
                  <p className="export-warn" role="alert" data-testid="export-large">
                    This export is large (over 1 GB).{' '}
                    {toDisk
                      ? 'It will be written straight to the file you pick, so memory stays low.'
                      : isVideo
                        ? 'This browser keeps the whole video in memory until it is saved. 720p or 30 fps make it smaller, or use Chrome or Edge to save straight to disk.'
                        : 'This browser keeps the whole zip in memory until it is saved. Mono or 16-bit make it smaller, or use Chrome or Edge to save straight to disk.'}
                  </p>
                )}
                {running && (
                  <>
                    <progress
                      value={run.fraction ?? undefined}
                      max={1}
                      aria-label="Export progress"
                      data-testid="export-progress"
                    />
                    <p className="export-size">
                      {run.fraction !== null ? `${Math.round(run.fraction * 100)}%. ` : ''}
                      {run.label}
                    </p>
                  </>
                )}
                {!running && run.message && (
                  <p
                    className={run.status === 'error' ? 'export-warn' : 'export-size'}
                    role={run.status === 'error' ? 'alert' : undefined}
                    data-testid="export-message"
                  >
                    {run.message}
                  </p>
                )}
              </div>

              <div className="dialog-actions">
                {running ? (
                  <button type="button" data-testid="export-cancel" onClick={cancelExport}>
                    Cancel export
                  </button>
                ) : (
                  <button type="button" data-testid="export-close" onClick={closeExport}>
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
