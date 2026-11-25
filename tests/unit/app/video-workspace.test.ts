import { describe, expect, it } from 'vitest';
import {
  axisFraction,
  axisPct,
  axisTime,
  nearerHandle,
  previewFit,
  timelineAxis,
  timelineCards,
} from '../../../src/app/video-timeline';
import {
  DEFAULT_EXPORT_FORM,
  parsePrefs,
  resetLook,
  videoOptions,
  type ExportForm,
} from '../../../src/app/export-options';
import {
  panPosterKey,
  posterKeysOf,
  withCameraFrame,
  withCameraKeys,
  withCameraMode,
  withPosterKeys,
  withRowBreak,
  zoomPosterKey,
} from '../../../src/app/editor/camera-keys';
import { generate } from '../../../src/core/generate';
import type { Piece } from '../../../src/core/types';
import {
  VIDEO_LOOK_KEYS,
  changedFields,
  docWithForm,
  formWithDoc,
  posterFields,
  posterLook,
  resetPosterLook,
} from '../../../src/app/poster-doc';

describe('video timeline (M15)', () => {
  it('the axis is the piece, widened to the video clock', () => {
    expect(timelineAxis(60)).toEqual({ from: 0, to: 60 });
    expect(timelineAxis(60, { from: -3, to: 70 })).toEqual({ from: -3, to: 70 });
    expect(timelineAxis(60, { from: 10, to: 20 })).toEqual({ from: 0, to: 60 });
    // An empty piece still has a usable axis.
    const a = timelineAxis(0);
    expect(a.to - a.from).toBeGreaterThan(0);
  });

  it('maps time to a fraction and back, clamped', () => {
    const a = { from: -10, to: 90 };
    expect(axisFraction(a, 40)).toBeCloseTo(0.5);
    expect(axisFraction(a, -50)).toBe(0);
    expect(axisFraction(a, 500)).toBe(1);
    expect(axisFraction(a, Number.NaN)).toBe(0);
    expect(axisTime(a, 0.25)).toBeCloseTo(15);
    expect(axisTime(a, 2)).toBe(90);
    for (const t of [-10, 0, 13.7, 90]) expect(axisTime(a, axisFraction(a, t))).toBeCloseTo(t);
    expect(axisPct(a, 40)).toBe('50.000%');
  });

  it('cards: opening before the section, ending after it, none when absent', () => {
    const span = { start: 10, end: 40 };
    expect(timelineCards({ from: 10, to: 40, span })).toEqual([]);
    expect(timelineCards({ from: 7, to: 50, span })).toEqual([
      { id: 'opening', label: 'Opening', start: 7, end: 10 },
      { id: 'ending', label: 'Ending', start: 40, end: 50 },
    ]);
    expect(timelineCards({ from: 10, to: 45, span }).map((c) => c.id)).toEqual(['ending']);
  });

  it('a press grabs the nearer handle', () => {
    const span = { start: 10, end: 40 };
    expect(nearerHandle(span, 5)).toBe('start');
    expect(nearerHandle(span, 24)).toBe('start');
    expect(nearerHandle(span, 25)).toBe('start');
    expect(nearerHandle(span, 26)).toBe('end');
  });

  it('the preview fits its box at the video aspect', () => {
    expect(previewFit({ w: 1600, h: 900 }, 16 / 9)).toEqual({ w: 1600, h: 900 });
    expect(previewFit({ w: 1600, h: 450 }, 16 / 9)).toEqual({ w: 800, h: 450 });
    expect(previewFit({ w: 300, h: 900 }, 9 / 16)).toEqual({ w: 300, h: 533 });
    expect(previewFit({ w: 0, h: 0 }, 1)).toEqual({ w: 1, h: 1 });
  });
});

describe('the poster doc leaves the video’s own look to the viewer (M15 storage)', () => {
  const ctx = { dark: true, duration: 60 };
  const video = {
    future: 'full',
    futureOpacity: 0.2,
    playhead: false,
    dots: false,
    rings: false,
    hzLabels: true,
  } as const;

  it('the doc never stores the video keys', () => {
    const form = { ...DEFAULT_EXPORT_FORM, look: { ...DEFAULT_EXPORT_FORM.look, ...video } };
    const doc = docWithForm(undefined, posterFields(form), ctx);
    for (const k of VIDEO_LOOK_KEYS) expect(doc?.look ?? {}).not.toHaveProperty(k);
  });

  it('showing a doc keeps the form’s video keys', () => {
    const form = { ...DEFAULT_EXPORT_FORM, look: { ...DEFAULT_EXPORT_FORM.look, ...video } };
    const doc = { look: { glow: 0.5 } };
    const shown = formWithDoc(form, doc);
    for (const k of VIDEO_LOOK_KEYS) expect(shown.look[k]).toEqual(form.look[k]);
    expect(shown.look.glow).toBe(0.5);
  });

  it('a video key change is no poster change', () => {
    const a = posterFields(DEFAULT_EXPORT_FORM);
    const b = posterFields({
      ...DEFAULT_EXPORT_FORM,
      look: { ...DEFAULT_EXPORT_FORM.look, future: 'hidden', playhead: false },
    });
    expect(changedFields(a, b)).toEqual([]);
    const c = posterFields({
      ...DEFAULT_EXPORT_FORM,
      look: { ...DEFAULT_EXPORT_FORM.look, glow: 0.3 },
    });
    expect(changedFields(a, c)).toEqual(['look']);
    expect(posterLook(DEFAULT_EXPORT_FORM.look)).not.toHaveProperty('future');
  });

  it('Poster’s Reset leaves the video’s own options', () => {
    const form: ExportForm = {
      ...DEFAULT_EXPORT_FORM,
      format: 'poster',
      look: { ...DEFAULT_EXPORT_FORM.look, ...video, glow: 0.4 },
      videoFollowAt: 0.6,
      videoHud: ['chord'],
    };
    const r = resetPosterLook(form, resetLook(form));
    expect(r.look.glow).toBe(DEFAULT_EXPORT_FORM.look.glow);
    for (const k of VIDEO_LOOK_KEYS) expect(r.look[k]).toEqual(form.look[k]);
    expect(r).toMatchObject({ videoFollowAt: 0.6, videoHud: ['chord'], posterHud: [] });
  });
});

describe('form + piece → the video’s options (M15)', () => {
  const ctx = { window: 12, duration: 60, dark: true, colors: 'pitch' as const, loop: null };
  const form = (over: Partial<ExportForm> = {}): ExportForm => ({
    ...DEFAULT_EXPORT_FORM,
    format: 'video',
    ...over,
  });
  const base = generate(5, { mode: 'dorian', voices: 3 });
  const withDoc: Piece = { ...base, poster: { rows: 2 } };

  it('a piece without a poster plays One row, as before', () => {
    const o = videoOptions(form(), base, ctx);
    expect(o.frame).toBe('row');
    expect(o.poster).toBeUndefined();
    expect(o.rowBreak).toBeUndefined();
    // Ahead is the Look's.
    expect(o.look!.future).toBe(DEFAULT_EXPORT_FORM.look.future);
  });

  it('a piece with a poster plays Over the poster: its poster, a pan, Ahead 0 %', () => {
    const o = videoOptions(form(), withDoc, ctx);
    expect(o.frame).toBe('poster');
    expect(o.rowBreak).toBe('pan');
    expect(o.poster?.rows).toBe(DEFAULT_EXPORT_FORM.posterRows);
    expect(o.look!.future).toBe('hidden');
    const half = videoOptions(form({ videoAheadPoster: 40 }), withDoc, ctx).look!;
    expect([half.future, half.futureOpacity]).toEqual(['dimmed', 0.4]);
    expect(videoOptions(form({ videoAheadPoster: 100 }), withDoc, ctx).look!.future).toBe('full');
  });

  it('the piece’s frame and row break win', () => {
    const row = withCameraFrame(withDoc, 'row');
    expect(videoOptions(form(), row, ctx).frame).toBe('row');
    expect(videoOptions(form(), row, ctx).poster).toBeUndefined();
    const cut = withRowBreak(withDoc, 'cut');
    expect(videoOptions(form(), cut, ctx).rowBreak).toBe('cut');
  });

  it('remembers Ahead over the poster, clamped', () => {
    expect(parsePrefs({ v: 4, videoAheadPoster: 140 }).videoAheadPoster).toBe(100);
    expect(parsePrefs({ v: 4, videoAheadPoster: -3 }).videoAheadPoster).toBe(0);
    expect(parsePrefs({ v: 4, videoAheadPoster: 'x' }).videoAheadPoster).toBeUndefined();
  });
});

describe('camera edits keep the M15 fields', () => {
  const p = generate(5, { mode: 'dorian', voices: 2 });
  const key = { at: 3, x: 0.5, y: 0.4, h: 0.3 };

  it('mode, keys, frame and row break leave each other alone', () => {
    let q = withCameraFrame(p, 'poster');
    q = withRowBreak(q, 'scroll');
    q = withPosterKeys(q, [key]);
    expect(q.camera).toEqual({
      mode: 'keys',
      frame: 'poster',
      rowBreak: 'scroll',
      posterKeys: [key],
    });
    q = withCameraMode(q, 'follow');
    q = withCameraKeys(q, [{ at: 1, place: 0.5, window: 10, pitch: 60, range: 24 }]);
    expect(q.camera?.frame).toBe('poster');
    expect(q.camera?.rowBreak).toBe('scroll');
    expect(posterKeysOf(q)).toEqual([key]);
    expect(withCameraFrame(q, 'poster')).toBe(q);
  });

  it('panning a poster key moves its frame against the pointer; zoom keeps it in range', () => {
    // A 16:9 frame on a 16:9 artboard: the frame's width is h of the artboard's width.
    const moved = panPosterKey(key, 0.1, -0.2, 16 / 9, 16 / 9);
    expect(moved.x).toBeCloseTo(0.5 - 0.1 * 0.3);
    expect(moved.y).toBeCloseTo(0.4 + 0.2 * 0.3);
    expect(zoomPosterKey(key, 2).h).toBeCloseTo(0.6);
    expect(zoomPosterKey(key, 1e-6).h).toBeGreaterThan(0);
    expect(zoomPosterKey(key, -1)).toBe(key);
  });
});
