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
  exportFileName,
  formatBytes,
  type ExportForm,
} from '../export-options';
import type { ExportEstimate, ExportOutput } from '../export-run';
import { pushNotice, usePlayer } from '../store';

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
}

const RUN_LABEL: Record<ExportForm['format'], string> = {
  wav: 'Export WAV',
  stems: 'Export stems',
  midi: 'Export MIDI',
};

const IDLE: RunState = { status: 'idle', fraction: null, label: '', message: '' };

/** The dialog's state. It outlives the dialog, so reopening it keeps the last choices. */
const useExportUi = create<ExportUi>()(() => ({
  open: false,
  form: { ...DEFAULT_EXPORT_FORM },
  run: IDLE,
  runtime: null,
}));

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

  // Chromium: ask where to save first (synchronously, inside the gesture), then stream to disk.
  const picking =
    form.format === 'stems' && runtime.canSaveToDisk()
      ? runtime.pickStemsFile(exportFileName(src.piece, form))
      : null;

  setRun({
    status: 'running',
    fraction: null,
    label: picking ? 'Choose where to save the zip…' : 'Starting…',
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
      } else {
        let target;
        if (picking) {
          // The browser's picker cannot be dismissed from here; Cancel just stops waiting for it.
          const gone = new Promise<never>((_, reject) =>
            ac.signal.addEventListener('abort', () =>
              reject(new DOMException('Cancelled', 'AbortError')),
            ),
          );
          target = await Promise.race([picking, gone]);
          if (!target) throw new DOMException('Save cancelled', 'AbortError');
        }
        out = await runtime.runStems(src, form, { ...hooks, target: target ?? undefined });
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
 * The Export dialog (PLAN.md §12): WAV, stems and MIDI. A native modal `<dialog>`, so focus is
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

  const estimate = useMemo(
    () => (open ? estimateFor(runtime, piece, compiled, form) : null),
    [open, runtime, piece, compiled, form],
  );

  const running = run.status === 'running';
  const toDisk = form.format === 'stems' && runtime?.canSaveToDisk() === true;
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

          {form.format !== 'midi' && (
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

          <div className="export-status" aria-live="polite" data-testid="export-status">
            {!running && estimate && (
              <p className="export-size" data-testid="export-size">
                {form.format === 'stems'
                  ? `${estimate.files} files, ${formatBytes(estimate.bytes)} zipped`
                  : `About ${formatBytes(estimate.bytes)}`}
                {estimate.zip64 && ' (ZIP64: some unzip tools need a recent version)'}
              </p>
            )}
            {!running && form.format === 'wav' && estimate === null && runtime === null && (
              <p className="export-size">Loading the exporter…</p>
            )}
            {!running && estimate?.large && (
              <p className="export-warn" role="alert" data-testid="export-large">
                This export is large (over 1 GB).{' '}
                {toDisk
                  ? 'It will be written straight to the file you pick, so memory stays low.'
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
              disabled={running || !runtime}
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
