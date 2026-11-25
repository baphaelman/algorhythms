/**
 * Export audio (PLAN.md §15 M14 "Entry"; Menu → Export audio…): WAV, stems and MIDI in a small
 * native modal `<dialog>`, so focus is trapped, Escape closes it (cancelling a running export)
 * and focus returns to the menu button. Video and poster are the workspace's.
 */

import { useEffect, useId, useMemo, useRef } from 'react';
import {
  BEND_RANGES,
  BIT_DEPTHS,
  EXPORT_FORMATS,
  MIDI_MODES,
  RATES,
  formatBytes,
} from '../export-options';
import { useExportSurface } from '../export-surface';
import { usePlayer } from '../store';
import { useFocusRescue } from './focus-rescue';
import { Radios } from './export-controls';
import { LoudnessField } from './ExportYoutube';
import { RunStatus } from './ExportFields';
import {
  RUN_LABEL,
  cancelExport,
  closeSurface,
  estimateFor,
  patch,
  startExport,
  useExportUi,
  useRuntime,
  videoContext,
} from './export-state';

/** Audio formats. */
const AUDIO_FORMATS = EXPORT_FORMATS.filter(
  (f) => f.id === 'wav' || f.id === 'stems' || f.id === 'midi',
);

/** The dialog closed (Escape, Close, a backdrop click): back to the editor, unless the surface moved on. */
function closeDialog(): void {
  if (useExportSurface.getState().surface !== 'audio') return;
  closeSurface();
  // Always the menu button: the Menu item is gone, and WebKit doesn't focus clicked buttons, so
  // the native restore can't be relied on.
  requestAnimationFrame(() => {
    if (useExportSurface.getState().surface !== null) return;
    document.querySelector<HTMLElement>('[data-testid="menu-button"]')?.focus();
  });
}

export function AudioDialog() {
  const open = useExportSurface((s) => s.surface === 'audio');
  const form = useExportUi((s) => s.form);
  const run = useExportUi((s) => s.run);
  const runtime = useRuntime(open);
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useFocusRescue(dialog, open);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

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
      data-surface={open ? 'audio' : undefined}
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
          <h2 id={`${id}-title`}>Export audio</h2>
          <p className="dialog-note">
            {piece.meta.title}: {Math.round(compiled.duration)} s, {piece.voices.length} notes.
          </p>

          <div className="export-body">
            <div className="export-format">
              <Radios
                legend="Format"
                name={`${id}-format`}
                value={form.format}
                options={AUDIO_FORMATS}
                disabled={running}
                testId="export-format"
                onChange={(format) => patch({ format })}
              />
            </div>

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

              <RunStatus run={run}>
                {estimate && (
                  <p className="export-size" data-testid="export-size">
                    {form.format === 'stems'
                      ? `${estimate.files} files, ${formatBytes(estimate.bytes)} zipped`
                      : `About ${formatBytes(estimate.bytes)}`}
                    {estimate.zip64 && ' (ZIP64: some unzip tools need a recent version)'}
                  </p>
                )}
                {form.format === 'wav' && estimate === null && runtime === null && (
                  <p className="export-size">Loading the exporter…</p>
                )}
                {estimate?.large && (
                  <p className="export-warn" role="alert" data-testid="export-large">
                    This export is large (over 1 GB).{' '}
                    {toDisk
                      ? 'It will be written straight to the file you pick, so memory stays low.'
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
                  disabled={running || !runtime}
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
