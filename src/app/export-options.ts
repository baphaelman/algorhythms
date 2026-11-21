/**
 * The Export dialog's form, as pure functions (PLAN.md §12): the choices, how they map to the
 * export APIs' options, the file names, and the size text. No DOM, no store and no DSP imports, so
 * the main bundle stays small and the mapping is unit-tested in Node. The heavy work lives in
 * `export-run.ts`, which the dialog loads on demand.
 */

import type { Piece } from '../core/types';

export type ExportFormat = 'wav' | 'stems' | 'midi';

export const EXPORT_FORMATS: readonly { id: ExportFormat; label: string }[] = [
  { id: 'wav', label: 'WAV' },
  { id: 'stems', label: 'Stems' },
  { id: 'midi', label: 'MIDI' },
];

/** 32 means 32-bit float. */
export type ExportBitDepth = 16 | 24 | 32;
export type ExportRate = 44100 | 48000;
export type ExportMidiMode = 'perVoice' | 'mpe' | 'notesOnly';
export type ExportBendRange = 2 | 12 | 24 | 48;

export const BIT_DEPTHS: readonly { id: ExportBitDepth; label: string }[] = [
  { id: 16, label: '16-bit' },
  { id: 24, label: '24-bit' },
  { id: 32, label: '32-bit float' },
];

export const RATES: readonly { id: ExportRate; label: string }[] = [
  { id: 44100, label: '44.1 kHz' },
  { id: 48000, label: '48 kHz' },
];

export const MIDI_MODES: readonly { id: ExportMidiMode; label: string; hint: string }[] = [
  {
    id: 'perVoice',
    label: 'Per-note tracks',
    hint: 'One track per note, each with its own pitch-bend range. Use one monophonic synth per track.',
  },
  {
    id: 'mpe',
    label: 'MPE',
    hint: 'For one MPE synth (bend range fixed at ±48). More than 15 notes make several files.',
  },
  {
    id: 'notesOnly',
    label: 'Notes only',
    hint: 'One note per arrival, no glides. For notation and plain synths.',
  },
];

export const BEND_RANGES: readonly { id: ExportBendRange; label: string }[] = [
  { id: 2, label: '±2' },
  { id: 12, label: '±12' },
  { id: 24, label: '±24' },
  { id: 48, label: '±48' },
];

/** What the dialog's controls hold. */
export interface ExportForm {
  format: ExportFormat;
  /** WAV and stems. */
  bitDepth: ExportBitDepth;
  /** WAV and stems. */
  sampleRate: ExportRate;
  /** Stems only: mono voice and FX stems (the mix stays stereo). */
  mono: boolean;
  midiMode: ExportMidiMode;
  /** Per-voice mode only (MPE is always ±48; notes-only writes no bends). */
  bendRange: ExportBendRange;
  /** Write pulse envelopes, fades and level gain as CC11. */
  cc11: boolean;
  /** End and re-strike the note on every arrival (plucked sounds). */
  restrike: boolean;
}

export const DEFAULT_EXPORT_FORM: ExportForm = {
  format: 'wav',
  bitDepth: 32,
  sampleRate: 48000,
  mono: false,
  midiMode: 'perVoice',
  bendRange: 24,
  cc11: false,
  restrike: false,
};

// ---------------------------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------------------------

/** Characters no common file system accepts in a name, plus control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A file name stem from text such as a piece title: unsafe characters dropped, spaces turned into
 * hyphens, no leading dots, at most 80 characters, and `fallback` when nothing is left.
 */
export function sanitizeFileName(text: string, fallback = 'piece'): string {
  let s = text
    .normalize('NFC')
    .replace(UNSAFE, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[. -]+$/, '')
    .slice(0, 80)
    .replace(/[. -]+$/, '');
  if (s === '') s = fallback;
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** The file name stem for a piece (its title, sanitized). */
export function fileBase(piece: Piece): string {
  return sanitizeFileName(piece.meta.title);
}

/** The file name of an export (MIDI file names come from the MIDI exporter; a zip is `-midi.zip`). */
export function exportFileName(piece: Piece, form: ExportForm, files = 1): string {
  const base = fileBase(piece);
  switch (form.format) {
    case 'wav':
      return `${base}.wav`;
    case 'stems':
      return `${base}-stems.zip`;
    case 'midi':
      return files > 1 ? `${base}-midi.zip` : `${base}.mid`;
  }
}

// ---------------------------------------------------------------------------------------------
// Option mapping
// ---------------------------------------------------------------------------------------------

export function wavOptions(form: ExportForm): { sampleRate: ExportRate; bitDepth: ExportBitDepth } {
  return { sampleRate: form.sampleRate, bitDepth: form.bitDepth };
}

/** Display names by voice id, for the stem file names. */
export function voiceNames(piece: Piece): Record<string, string> {
  const names: Record<string, string> = {};
  for (const v of piece.voices) if (v.name) names[v.id] = v.name;
  return names;
}

export function stemsOptions(
  form: ExportForm,
  piece: Piece,
): {
  sampleRate: ExportRate;
  bitDepth: ExportBitDepth;
  mono: boolean;
  voiceNames: Record<string, string>;
} {
  return {
    sampleRate: form.sampleRate,
    bitDepth: form.bitDepth,
    mono: form.mono,
    voiceNames: voiceNames(piece),
  };
}

export interface MidiRequest {
  mode: ExportMidiMode;
  bendRange: ExportBendRange;
  cc11: boolean;
  restrikeOnArrival: boolean;
  name: string;
  title: string;
  /** Present only when the piece has a grid, so 1 beat follows it; else the exporter's 60. */
  bpm?: number;
}

export function midiOptions(form: ExportForm, piece: Piece): MidiRequest {
  const req: MidiRequest = {
    mode: form.midiMode,
    bendRange: form.midiMode === 'mpe' ? 48 : form.bendRange,
    cc11: form.cc11,
    restrikeOnArrival: form.restrike,
    name: fileBase(piece),
    title: piece.meta.title,
  };
  const bpm = piece.view.gridBpm;
  if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) req.bpm = bpm;
  return req;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** Decimal units, as the 1 GB warning is: 1 234 567 bytes gives "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1e3) return `${Math.round(bytes)} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(bytes < 1e4 ? 1 : 0)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
