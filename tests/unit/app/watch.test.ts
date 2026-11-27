/** The watch view's rules (M17 W2): keys, leaving, the first frame, the end, the times, Opens to. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_FORM, type ExportForm } from '../../../src/app/export-options';
import { previewClock } from '../../../src/app/export-run';
import { useExportSurface } from '../../../src/app/export-surface';
import {
  fullscreenLeaves,
  playerTime,
  spokenTime,
  watchEnded,
  watchFirstFrame,
  watchKey,
  watchTimes,
  linkOpening,
} from '../../../src/app/watch';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';

const key = (k: string, o: Partial<Parameters<typeof watchKey>[0]> = {}) =>
  watchKey({
    key: k,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    dialog: false,
    ...o,
  });

describe('watch keys', () => {
  it('Escape leaves, ←/→ seek 5 s (15 with Shift), F fullscreen', () => {
    expect(key('Escape')).toEqual({ action: 'leave' });
    expect(key('ArrowLeft')).toEqual({ action: 'seek', by: -5 });
    expect(key('ArrowRight')).toEqual({ action: 'seek', by: 5 });
    expect(key('ArrowRight', { shiftKey: true })).toEqual({ action: 'seek', by: 15 });
    expect(key('f')).toEqual({ action: 'fullscreen' });
    expect(key('F')).toEqual({ action: 'fullscreen' });
  });

  it('leaves used keys, modifiers, dialogs and other keys alone', () => {
    expect(key('Escape', { defaultPrevented: true })).toBeNull();
    expect(key('Escape', { dialog: true })).toBeNull();
    expect(key('f', { metaKey: true })).toBeNull();
    expect(key('ArrowLeft', { altKey: true })).toBeNull();
    expect(key('ArrowLeft', { ctrlKey: true })).toBeNull();
    expect(key('F', { shiftKey: true })).toBeNull();
    expect(key(' ')).toBeNull();
    expect(key('ArrowUp')).toBeNull();
  });
});

describe('leaving fullscreen', () => {
  it("leaves the watch view, unless the view's own button left it", () => {
    expect(fullscreenLeaves({ fullscreen: false, ours: false })).toBe(true);
    expect(fullscreenLeaves({ fullscreen: false, ours: true })).toBe(false);
    expect(fullscreenLeaves({ fullscreen: true, ours: false })).toBe(false);
  });

  it('the watch view ends with the Video workspace', () => {
    useExportSurface.setState({ surface: 'video', watch: true });
    useExportSurface.setState({ surface: 'poster' });
    expect(useExportSurface.getState().watch).toBe(false);
    useExportSurface.setState({ surface: 'video', watch: true });
    useExportSurface.setState({ surface: null });
    expect(useExportSurface.getState().watch).toBe(false);
  });
});

describe('the first frame and the end', () => {
  const SONGS = join(import.meta.dirname, '../../../examples/songs');
  const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  const src = { piece: r.piece, compiled: compile(r.piece) };
  const ctx = {
    window: 10,
    duration: src.compiled.duration,
    dark: false,
    colors: 'pitch' as const,
    loop: null,
  };
  const form = (p: Partial<ExportForm>): ExportForm => ({
    ...DEFAULT_EXPORT_FORM,
    format: 'video',
    section: 'custom',
    sectionSpan: { start: 10, end: 20 },
    ...p,
  });

  it("is the section's start (where a title card shows), the lead-in's start with one", () => {
    expect(watchFirstFrame(previewClock(src, form({}), ctx))).toBeCloseTo(10, 6);
    expect(watchFirstFrame(previewClock(src, form({ videoTitleCard: true }), ctx))).toBeCloseTo(
      10,
      6,
    );
    const lead = previewClock(src, form({ videoLeadIn: 2, videoTitleCard: true }), ctx);
    expect(lead.lead).toBeGreaterThan(0);
    expect(watchFirstFrame(lead)).toBeCloseTo(10 - lead.lead, 6);
  });

  it('ends at the end card’s end, only when nothing plays', () => {
    const c = previewClock(src, form({ videoEndCard: 5 }), ctx);
    expect(c.to).toBeGreaterThan(20);
    expect(watchEnded(c.to, c, false)).toBe(true);
    expect(watchEnded(c.to - 0.02, c, false)).toBe(true);
    expect(watchEnded(c.to, c, true)).toBe(false);
    expect(watchEnded(20, c, false)).toBe(false);
  });
});

describe('times', () => {
  it('counts from the first frame, clamped to the video', () => {
    const c = { from: 8, to: 28 };
    expect(watchTimes(8, c)).toEqual({ at: 0, length: 20 });
    expect(watchTimes(18.5, c)).toEqual({ at: 10.5, length: 20 });
    expect(watchTimes(40, c)).toEqual({ at: 20, length: 20 });
    expect(watchTimes(0, c)).toEqual({ at: 0, length: 20 });
  });

  it('reads as a player shows it, and speaks', () => {
    expect(playerTime(0)).toBe('0:00');
    expect(playerTime(65.9)).toBe('1:05');
    expect(playerTime(3725)).toBe('1:02:05');
    expect(spokenTime(1)).toBe('1 second');
    expect(spokenTime(65)).toBe('1 minute 5 seconds');
    expect(spokenTime(120)).toBe('2 minutes');
  });
});

describe('Share: Opens to', () => {
  it('Video gives the watch link, Music the share link', () => {
    const link = 'https://x.test/algorhythms/#p=abc';
    expect(linkOpening(link, 'music')).toBe(link);
    expect(linkOpening(link, 'video')).toBe('https://x.test/algorhythms/#w&p=abc');
    expect(linkOpening('', 'video')).toBe('');
  });
});
