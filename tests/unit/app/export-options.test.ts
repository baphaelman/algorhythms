import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  codecLabel,
  exportFileName,
  fileBase,
  formatBytes,
  midiOptions,
  sanitizeFileName,
  stemsOptions,
  videoOptions,
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

describe('video', () => {
  const ctx = { window: 12, dark: true, colors: 'pitch' as const };
  it('maps the defaults: 16:9 1080p30 Follow at the editor window, current theme', () => {
    const p = piece('Clip');
    expect(DEFAULT_EXPORT_FORM).toMatchObject({
      videoAspect: '16:9',
      videoSize: '1080',
      videoFps: 30,
      videoCamera: 'follow',
      videoTheme: 'current',
      videoHud: true,
      videoThickness: true,
    });
    expect(videoOptions(form({ format: 'video' }), p, ctx)).toEqual({
      aspect: '16:9',
      size: '1080',
      fps: 30,
      camera: 'follow',
      window: 12,
      theme: 'dark',
      hud: true,
      thickness: true,
      colors: 'pitch',
      customColors: p.voices.map((v) => v.color),
    });
    expect(videoOptions(form(), p, { ...ctx, dark: false }).theme).toBe('light');
  });
  it('passes every choice; Whole piece has no window', () => {
    const o = videoOptions(
      form({
        videoAspect: '9:16',
        videoSize: '720',
        videoFps: 60,
        videoCamera: 'whole',
        videoTheme: 'light',
        videoHud: false,
        videoThickness: false,
      }),
      piece('Clip'),
      ctx,
    );
    expect(o).toMatchObject({
      aspect: '9:16',
      size: '720',
      fps: 60,
      camera: 'whole',
      theme: 'light',
      hud: false,
      thickness: false,
    });
    expect('window' in o).toBe(false);
  });
  it('names the file .mp4 and the codecs plainly', () => {
    expect(exportFileName(piece('Tidewater Hymn'), form({ format: 'video' }))).toBe(
      'Tidewater-Hymn.mp4',
    );
    expect(codecLabel('avc1.640028', 'mp4a.40.2')).toBe('H.264 + AAC');
    expect(codecLabel('avc1.64001f', 'opus')).toBe('H.264 + Opus');
    expect(codecLabel('vp09.00.40.08', 'opus')).toBe('VP9 + Opus');
  });
});
