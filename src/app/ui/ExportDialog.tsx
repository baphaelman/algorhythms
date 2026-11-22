import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import { formatTime } from '../../render/hud';
import { tokensOf } from '../../render/palettes';
import { posterSize } from '../../render/poster';
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
  POSTER_SIZES,
  RATES,
  VIDEO_ASPECTS,
  VIDEO_CAMERAS,
  VIDEO_FPS,
  VIDEO_SIZES,
  VIDEO_THEMES,
  codecLabel,
  exportFileName,
  formatBytes,
  hudInOrder,
  loadExportPrefs,
  posterPixels,
  resetLook,
  saveExportPrefs,
  type ExportForm,
  type LookForm,
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
import { cameraOf, currentTime, pushNotice, usePlayer } from '../store';

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

/** What the video and poster take from the app now: the editor's zoom, theme and line colours. */
function videoContext(): VideoContext {
  return { window: cameraOf().window, dark: appDark(), colors: usePlayer.getState().view.colors };
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
  useExportUi.setState({
    open: true,
    hudOpen: false,
    previewT: now > 0 ? now : duration / 3,
    run: running ? s.run : IDLE,
    // The remembered Look and video/poster choices (none if storage is unavailable).
    form: running ? s.form : { ...s.form, ...loadExportPrefs() },
  });
}

/** Closes the dialog; a running export is cancelled. */
function closeExport(): void {
  cancelExport();
  useExportUi.setState({ open: false });
}

function cancelExport(): void {
  controller?.abort();
}

function patch(p: Partial<ExportForm>): void {
  useExportUi.setState((s) => ({ form: { ...s.form, ...p }, run: IDLE }));
  saveExportPrefs(useExportUi.getState().form);
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
    return runtime.estimateExport({ piece, compiled }, form);
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
    ? posterSize(form.posterSize)
    : videoSize(form.videoAspect, form.videoSize);
}

/** Counters of the preview's measure and scroll-padding callbacks and draws (debug hook). */
export const previewStats = { measures: 0, pads: 0, draws: 0 };

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
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const draws = useRef(0);
  const frame = useRef(0);
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

  const px = exportPixels(form, kind);
  const aspect = px.width / px.height;
  const cssW = Math.max(1, Math.floor(Math.min(avail.w, avail.h * aspect)));
  const cssH = Math.max(1, Math.round(cssW / aspect));
  const dpr = Math.min(2, devicePixelRatio || 1);
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.max(1, Math.round((px.height * pxW) / px.width));
  const time = Math.min(Math.max(0, t), compiled.duration);

  useEffect(() => {
    if (!runtime || avail.w === 0) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const c = canvas.current;
      const g = c?.getContext('2d');
      if (!c || !g) return;
      if (c.width !== pxW) c.width = pxW;
      if (c.height !== pxH) c.height = pxH;
      const scale = pxW / px.width;
      const src = { piece, compiled };
      if (kind === 'video') runtime.previewVideo(g, src, form, videoContext(), time, scale);
      else runtime.previewPosterOf(g, src, form, videoContext(), scale);
      draws.current++;
      previewStats.draws++;
      c.dataset.draws = String(draws.current);
    });
    return () => cancelAnimationFrame(frame.current);
  }, [runtime, piece, compiled, form, kind, time, pxW, pxH, px.width, appView, avail.w]);

  const transparent = kind === 'poster' && form.look.transparent;
  const what =
    kind === 'video'
      ? `Preview of the video frame at ${formatTime(time)}, ${form.videoAspect}`
      : `Preview of the poster, ${POSTER_SIZES.find((p) => p.id === form.posterSize)?.label}` +
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
          <label htmlFor={`${id}-t`} className="visually-hidden">
            Preview time
          </label>
          <input
            id={`${id}-t`}
            type="range"
            min={0}
            max={Math.max(0.1, compiled.duration)}
            step={0.1}
            value={time}
            data-testid="preview-time"
            onChange={(e) => useExportUi.setState({ previewT: Number(e.target.value) })}
          />
          <output htmlFor={`${id}-t`}>{formatTime(time)}</output>
        </div>
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
                </>
              )}

              {isPoster && (
                <>
                  <div className="field-pair">
                    <Radios
                      legend="File"
                      name={`${id}-pformat`}
                      value={form.posterFormat}
                      options={POSTER_FORMATS}
                      disabled={running}
                      testId="export-pformat"
                      onChange={(posterFormat) => patch({ posterFormat })}
                    />
                    <Radios
                      legend="Size"
                      name={`${id}-psize`}
                      value={form.posterSize}
                      options={POSTER_SIZES}
                      disabled={running}
                      testId="export-psize"
                      onChange={(posterSize) => patch({ posterSize })}
                    />
                  </div>
                  <div className="field">
                    <Switch
                      checked={form.posterTitle}
                      disabled={running}
                      testId="export-ptitle"
                      label="Title block (name, length, key)"
                      onChange={(posterTitle) => patch({ posterTitle })}
                    />
                  </div>
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
                    {posterPixels(form.posterSize)}, {form.posterFormat.toUpperCase()}
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
