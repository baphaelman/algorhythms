import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  exportFileName,
  fileBase,
  formatBytes,
  midiOptions,
  sanitizeFileName,
  stemsOptions,
  voiceNames,
  wavOptions,
  type ExportForm,
} from '../../../src/app/export-options';
import { generate } from '../../../src/core/generate';
import type { Piece } from '../../../src/core/types';

const form = (over: Partial<ExportForm> = {}): ExportForm => ({ ...DEFAULT_EXPORT_FORM, ...over });

function piece(title: string, over: Partial<Piece> = {}): Piece {
  const p = generate(5, { mode: 'dorian', voices: 3 });
  return { ...p, meta: { ...p.meta, title }, ...over };
}

describe('sanitizeFileName', () => {
  it('keeps ordinary titles readable', () => {
    expect(sanitizeFileName('Tidewater Hymn')).toBe('Tidewater-Hymn');
    expect(sanitizeFileName('  Étude No. 3 ♪ ')).toBe('Étude-No.-3-♪');
  });
  it('drops path separators, control and reserved characters', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeFileName('tab\there\nnew')).toBe('tab-here-new');
    expect(sanitizeFileName('../../etc/passwd')).toBe('etc-passwd');
  });
  it('never starts with a dot or ends with a dot, space or hyphen', () => {
    expect(sanitizeFileName('...hidden')).toBe('hidden');
    expect(sanitizeFileName('name. ')).toBe('name');
    expect(sanitizeFileName('-x-')).toBe('x');
  });
  it('falls back when nothing usable is left, and avoids Windows device names', () => {
    expect(sanitizeFileName('')).toBe('piece');
    expect(sanitizeFileName('///')).toBe('piece');
    expect(sanitizeFileName('???', 'untitled')).toBe('untitled');
    expect(sanitizeFileName('CON')).toBe('CON_');
    expect(sanitizeFileName('nul')).toBe('nul_');
  });
  it('limits the length without leaving a trailing separator', () => {
    const s = sanitizeFileName(`${'x'.repeat(79)} tail`);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith('-')).toBe(false);
    expect(sanitizeFileName('y'.repeat(300)).length).toBe(80);
  });
});

describe('file names', () => {
  it('come from the title', () => {
    const p = piece('Lanterns / Salt');
    expect(fileBase(p)).toBe('Lanterns-Salt');
    expect(exportFileName(p, form({ format: 'wav' }))).toBe('Lanterns-Salt.wav');
    expect(exportFileName(p, form({ format: 'stems' }))).toBe('Lanterns-Salt-stems.zip');
    expect(exportFileName(p, form({ format: 'midi' }))).toBe('Lanterns-Salt.mid');
    expect(exportFileName(p, form({ format: 'midi' }), 3)).toBe('Lanterns-Salt-midi.zip');
  });
});

describe('option mapping', () => {
  it('maps WAV choices straight through', () => {
    expect(wavOptions(form({ bitDepth: 24, sampleRate: 44100 }))).toEqual({
      bitDepth: 24,
      sampleRate: 44100,
    });
    expect(wavOptions(DEFAULT_EXPORT_FORM)).toEqual({ bitDepth: 32, sampleRate: 48000 });
  });

  it('maps stems choices and names stems after named voices', () => {
    const p = piece('P');
    p.voices = p.voices.map((v, i) =>
      i === 0 ? { ...v, name: 'Lead' } : { ...v, name: undefined },
    );
    expect(voiceNames(p)).toEqual({ [p.voices[0].id]: 'Lead' });
    const o = stemsOptions(
      form({ format: 'stems', bitDepth: 16, mono: true, sampleRate: 44100 }),
      p,
    );
    expect(o).toMatchObject({ bitDepth: 16, mono: true, sampleRate: 44100 });
    expect(o.voiceNames).toEqual({ [p.voices[0].id]: 'Lead' });
  });

  it('maps MIDI choices; MPE is always ±48', () => {
    const p = piece('Song one');
    const base = midiOptions(form({ format: 'midi' }), p);
    expect(base).toMatchObject({
      mode: 'perVoice',
      bendRange: 24,
      cc11: false,
      restrikeOnArrival: false,
      name: 'Song-one',
      title: 'Song one',
    });
    expect(base.bpm).toBeUndefined();
    expect(midiOptions(form({ midiMode: 'mpe', bendRange: 2 }), p).bendRange).toBe(48);
    expect(
      midiOptions(form({ midiMode: 'notesOnly', bendRange: 12, cc11: true }), p),
    ).toMatchObject({
      mode: 'notesOnly',
      bendRange: 12,
      cc11: true,
    });
    expect(midiOptions(form({ restrike: true }), p).restrikeOnArrival).toBe(true);
  });

  it('follows the grid tempo when the piece has one', () => {
    const p = piece('Grid');
    p.view = { ...p.view, gridBpm: 90 };
    expect(midiOptions(form(), p).bpm).toBe(90);
    p.view = { ...p.view, gridBpm: 0 };
    expect(midiOptions(form(), p).bpm).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('uses decimal units, matching the 1 GB warning', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1500)).toBe('1.5 kB');
    expect(formatBytes(12_345_678)).toBe('12 MB');
    expect(formatBytes(1_234_567)).toBe('1.2 MB');
    expect(formatBytes(1e9)).toBe('1.00 GB');
    expect(formatBytes(2.28e9)).toBe('2.28 GB');
  });
});
