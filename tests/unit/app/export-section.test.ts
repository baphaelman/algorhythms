/** The Export dialog's Section (PLAN.md §12 "Exports you can shape", rev 15): pure mapping. */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  defaultCustomSpan,
  gridOf,
  moveHandle,
  parseClock,
  parsePrefs,
  posterOptions,
  sectionClock,
  sectionOf,
  stepHandle,
  videoOptions,
  type ExportForm,
} from '../../../src/app/export-options';
import { videoAudioFrames, videoAudioSpan } from '../../../src/app/video-export';
import { exportFrameCount } from '../../../src/audio/offline';
import { compile } from '../../../src/core/compiler/compile';
import { generate } from '../../../src/core/generate';
import { MIN_SECTION } from '../../../src/render/section';

const form = (over: Partial<ExportForm> = {}): ExportForm => ({ ...DEFAULT_EXPORT_FORM, ...over });
const grid = { bpm: 100, meter: 4 }; // 2.4 s bars

describe('sectionOf', () => {
  const ctx = { duration: 148, loop: { start: 20, end: 30 } };

  it('Whole, Loop and Custom resolve to a span; whole-piece spans to none', () => {
    expect(sectionOf(form(), ctx)).toBeUndefined();
    expect(sectionOf(form({ section: 'loop' }), ctx)).toEqual({ start: 20, end: 30 });
    expect(sectionOf(form({ section: 'loop' }), { duration: 148, loop: null })).toBeUndefined();
    expect(
      sectionOf(form({ section: 'custom', sectionSpan: { start: 45, end: 90 } }), ctx),
    ).toEqual({ start: 45, end: 90 });
    expect(sectionOf(form({ section: 'custom', sectionSpan: null }), ctx)).toBeUndefined();
    expect(
      sectionOf(form({ section: 'custom', sectionSpan: { start: 0, end: 148 } }), ctx),
    ).toBeUndefined();
    // Clipped to the piece (it may have got shorter since).
    expect(
      sectionOf(form({ section: 'custom', sectionSpan: { start: 45, end: 200 } }), ctx),
    ).toEqual({ start: 45, end: 148 });
    expect(sectionOf(form({ section: 'loop' }), {})).toBeUndefined();
  });

  it('reaches the video and poster options; WAV-side choices unchanged', () => {
    const piece = generate(5, { mode: 'dorian', voices: 3 });
    const app = { window: 12, dark: false, colors: 'pitch' as const, ...ctx };
    const f = form({ section: 'custom', sectionSpan: { start: 45, end: 90 } });
    expect(videoOptions(f, piece, app).section).toEqual({ start: 45, end: 90 });
    expect(videoOptions(form(), piece, app).section).toBeUndefined();
    const p = posterOptions(f, piece, app);
    expect(p.section).toEqual({ start: 45, end: 90 });
    expect(p.pieceRange).toBe(false);
    expect(posterOptions({ ...f, posterPieceRange: true }, piece, app).pieceRange).toBe(true);
    expect('section' in posterOptions(form(), piece, app)).toBe(false);
  });

  it('the section is not remembered on disk; the pitch-range switch is', () => {
    const p = parsePrefs({
      section: 'custom',
      sectionSpan: { start: 1, end: 2 },
      posterPieceRange: true,
    });
    expect(p).toEqual({ posterPieceRange: true });
  });
});

describe('Custom handles', () => {
  const D = 148;

  it('a pointer snaps to the nearest bar; Alt places freely; no grid is free', () => {
    const s = { start: 45.6, end: 91.2 };
    expect(moveHandle(s, 'start', 50, D, grid).start).toBeCloseTo(50.4);
    expect(moveHandle(s, 'start', 50, D, grid, true).start).toBe(50);
    expect(moveHandle(s, 'end', 80.1, D).end).toBe(80.1);
    expect(moveHandle(s, 'end', 80.1, D, grid).end).toBeCloseTo(79.2);
  });

  it('handles keep MIN_SECTION apart and stay in the piece', () => {
    const s = { start: 40, end: 60 };
    expect(moveHandle(s, 'start', 59.5, D, undefined, true)).toEqual({
      start: 60 - MIN_SECTION,
      end: 60,
    });
    expect(moveHandle(s, 'end', 10, D, undefined, true)).toEqual({
      start: 40,
      end: 40 + MIN_SECTION,
    });
    expect(moveHandle(s, 'start', -5, D)).toEqual({ start: 0, end: 60 });
    expect(moveHandle(s, 'end', 500, D)).toEqual({ start: 40, end: D });
  });

  it('keyboard: a bar per arrow (Shift four), Alt 0.1 s, a second without a grid, Home / End', () => {
    const s = { start: 48, end: 96 };
    const k = (
      key: string,
      mods = {},
      g: typeof grid | null = grid,
      h: 'start' | 'end' = 'start',
    ) => stepHandle(s, h, key, mods, D, g ?? undefined);
    expect(k('ArrowRight')!.start).toBeCloseTo(50.4);
    expect(k('ArrowLeft')!.start).toBeCloseTo(45.6);
    expect(k('ArrowUp', { shift: true })!.start).toBeCloseTo(48 + 2.4 * 4 - (48 % 2.4));
    expect(k('ArrowRight', { alt: true })!.start).toBeCloseTo(48.1);
    expect(k('ArrowLeft', { alt: true, shift: true })!.start).toBeCloseTo(47);
    expect(k('ArrowRight', {}, null)!.start).toBe(49);
    expect(k('PageDown', {}, null)!.start).toBe(38);
    expect(k('Home')!.start).toBe(0);
    expect(k('End', {}, grid, 'end')!.end).toBe(D);
    expect(k('End')!.start).toBe(96 - MIN_SECTION); // the start stops before the end
    expect(k('a')).toBeNull();
  });

  it('Custom starts at the loop region, else the editor’s view, else the middle third', () => {
    expect(defaultCustomSpan(D, { start: 0, window: 20 }, { start: 5, end: 9 })).toEqual({
      start: 5,
      end: 9,
    });
    const v = defaultCustomSpan(D, { start: 30.1, window: 20 }, null, grid);
    expect(v.start).toBeCloseTo(31.2);
    expect(v.end).toBeCloseTo(50.4);
    const third = defaultCustomSpan(D, { start: 0, window: 400 }, null);
    expect(third.start).toBeCloseTo(D / 3);
    expect(third.end).toBeCloseTo((2 * D) / 3);
  });

  it('clock text and typed times', () => {
    expect(sectionClock(45)).toBe('0:45.0');
    expect(sectionClock(65.55)).toBe('1:05.6');
    expect(sectionClock(119.96)).toBe('2:00.0');
    expect(parseClock('1:05.5')).toBe(65.5);
    expect(parseClock(' 65.5 ')).toBe(65.5);
    expect(parseClock('1:05')).toBe(65);
    expect(parseClock('.5')).toBe(0.5);
    expect(parseClock('1:75')).toBeNull();
    expect(parseClock('abc')).toBeNull();
    expect(parseClock('')).toBeNull();
  });

  it('gridOf reads the piece’s tempo', () => {
    const p = generate(5, { mode: 'dorian', voices: 3 });
    expect(gridOf({ view: { ...p.view, gridBpm: 90, meter: 3 } })).toEqual({ bpm: 90, meter: 3 });
    const { gridBpm: _g, ...noGrid } = p.view;
    expect(gridOf({ view: noGrid })).toBeUndefined();
  });
});

describe('video section length', () => {
  const piece = generate(5, { mode: 'dorian', voices: 3 });
  const compiled = compile(piece);
  const D = compiled.duration;

  it('lasts exactly its length; one ending at the piece’s end keeps the ring-out', () => {
    expect(videoAudioSpan(D)).toBeUndefined();
    expect(videoAudioSpan(D, { start: 0, end: D })).toBeUndefined();
    expect(videoAudioSpan(D, { start: 10, end: 20 })).toEqual({ start: 10, end: 20 });
    expect(videoAudioSpan(D, { start: 10, end: D })).toEqual({ start: 10 });
    expect(videoAudioFrames(compiled, piece.mix, { start: 10, end: 20 })).toBe(480_000);
    const all = exportFrameCount(compiled, piece.mix, 48000);
    expect(videoAudioFrames(compiled, piece.mix)).toBe(all);
    expect(videoAudioFrames(compiled, piece.mix, { start: 10, end: D })).toBe(all - 480_000);
  });
});
