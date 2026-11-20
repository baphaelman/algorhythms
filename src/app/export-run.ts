/**
 * The Export dialog's engine room (PLAN.md §12): size estimates and the three exports. It imports
 * the DSP graph (through the WAV and stems clients), so the dialog loads this module with a
 * dynamic `import()` and the main bundle does not carry it.
 */

import { exportWav } from '../audio/export-client';
import { canSaveToDisk, exportStems, pickStemsFile, planStems } from '../audio/stems-client';
import type { StemsProgress, StemsTarget } from '../audio/stems-client';
import { wavExportSize } from '../audio/wav-export';
import type { CompiledScore, Piece } from '../core/types';
import { exportMidi, zipFiles } from '../midi/export';
import {
  exportFileName,
  midiOptions,
  stemsOptions,
  wavOptions,
  type ExportForm,
} from './export-options';

export { canSaveToDisk, pickStemsFile };

/** The piece as it sounds now. */
export interface ExportSource {
  piece: Piece;
  compiled: CompiledScore;
}

/** What an export would produce, for the dialog's size line. */
export interface ExportEstimate {
  bytes: number;
  files: number;
  /** Stems only: over 1 GB. */
  large: boolean;
  zip64: boolean;
}

/** Exact size of a WAV or stems export (no rendering); null for MIDI (it is small). */
export function estimateExport(src: ExportSource, form: ExportForm): ExportEstimate | null {
  const input = { score: src.compiled, mix: src.piece.mix, timbres: src.piece.timbres };
  if (form.format === 'wav') {
    const { bytes } = wavExportSize(input, wavOptions(form));
    return { bytes, files: 1, large: false, zip64: false };
  }
  if (form.format === 'stems') {
    const p = planStems(input, stemsOptions(form, src.piece));
    return { bytes: p.bytes, files: p.entries.length, large: p.large, zip64: p.zip64 };
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
