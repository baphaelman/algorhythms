import { useEffect, useId, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { downloadBlob } from '../download';
import {
  BEND_RANGES,
  BIT_DEPTHS,
  DEFAULT_EXPORT_FORM,
  EXPORT_FORMATS,
  MIDI_MODES,
  RATES,
  VIDEO_ASPECTS,
  VIDEO_CAMERAS,
  VIDEO_FPS,
  VIDEO_SIZES,
  VIDEO_THEMES,
  codecLabel,
  exportFileName,
  formatBytes,
  type ExportForm,
  type VideoContext,
} from '../export-options';
import type { ExportEstimate, ExportOutput } from '../export-run';
import type { VideoSupport } from '../video-export';
import { cameraOf, pushNotice, usePlayer } from '../store';

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
}

const RUN_LABEL: Record<ExportForm['format'], string> = {
  wav: 'Export WAV',
  stems: 'Export stems',
  midi: 'Export MIDI',
  video: 'Export video',
};

const IDLE: RunState = { status: 'idle', fraction: null, label: '', message: '' };

/** The dialog's state. It outlives the dialog, so reopening it keeps the last choices. */
const useExportUi = create<ExportUi>()(() => ({
  open: false,
  form: { ...DEFAULT_EXPORT_FORM },
  run: IDLE,
  runtime: null,
  video: { key: '', support: null },
}));

const videoKey = (f: ExportForm) => `${f.videoAspect} ${f.videoSize} ${f.videoFps}`;

/** What the video takes from the app now: the editor's zoom, the theme and the line colours. */
function videoContext(): VideoContext {
  const { view } = usePlayer.getState();
  const dark =
    view.theme === 'dark' ||
    (view.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return { window: cameraOf().window, dark, colors: view.colors };
}

let controller: AbortController | null = null;

/** Opens the Export dialog (the menu's Export item calls this). */
export function openExport(): void {
  const s = useExportUi.getState();
  // A finished or cancelled run's message is stale by the next time; a running one is kept.
  useExportUi.setState({ open: true, run: s.run.status === 'running' ? s.run : IDLE });
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
  if (video && useExportUi.getState().video.support?.ok !== true) return;
  // Chromium: ask where to save first (synchronously, inside the gesture), then stream to disk.
  const toDisk = (form.format === 'stems' || video) && runtime.canSaveToDisk();
  const name = exportFileName(src.piece, form);
  const pickVideo = toDisk && video ? runtime.pickVideoFile(name) : null;
  const pickStems = toDisk && !video ? runtime.pickStemsFile(name) : null;
  const picking = toDisk;
  const ctx = video ? videoContext() : null;

  setRun({
    status: 'running',
    fraction: null,
    label: picking ? `Choose where to save the ${video ? 'video' : 'zip'}…` : 'Starting…',
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

/**
 * The Export dialog (PLAN.md §12): WAV, stems, MIDI and video. A native modal `<dialog>`, so focus is
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
  const toDisk = (form.format === 'stems' || isVideo) && runtime?.canSaveToDisk() === true;
  const videoBlocked = isVideo && support?.ok !== true;
  const cameraHint = VIDEO_CAMERAS.find((c) => c.id === form.videoCamera)?.hint;
  const mpe = form.midiMode === 'mpe';
  const notes = form.midiMode === 'notesOnly';
  const hint = MIDI_MODES.find((m) => m.id === form.midiMode)?.hint;

  return (
    <dialog
      ref={dialog}
      className="dialog export"
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

          <Radios
            legend="Format"
            name={`${id}-format`}
            value={form.format}
            options={EXPORT_FORMATS}
            disabled={running}
            testId="export-format"
            onChange={(format) => patch({ format })}
          />

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
                A zip of the mix, one stereo WAV per note and the effect returns. They add up to the
                mix.
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
              <Radios
                legend="Theme"
                name={`${id}-vtheme`}
                value={form.videoTheme}
                options={VIDEO_THEMES}
                disabled={running}
                testId="export-vtheme"
                onChange={(videoTheme) => patch({ videoTheme })}
              />
              <div className="field">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.videoHud}
                    disabled={running}
                    data-testid="export-hud"
                    onChange={(e) => patch({ videoHud: e.target.checked })}
                  />
                  <span>HUD (chord and readouts)</span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.videoThickness}
                    disabled={running}
                    data-testid="export-thickness"
                    onChange={(e) => patch({ videoThickness: e.target.checked })}
                  />
                  <span>Thickness (louder lines are thicker)</span>
                </label>
              </div>
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
        </form>
      )}
    </dialog>
  );
}
