/**
 * M17 W1 (PLAN.md §15 "The video in the piece"): the record ↔ form helpers, and frame fidelity:
 * a piece with a record draws the same frames whatever the viewer remembers; one without follows
 * the viewer's options as before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  DEFAULT_LOOK_FORM,
  followWindowOf,
  videoOptions,
  type ExportForm,
  type VideoContext,
} from '../../../src/app/export-options';
import { frameOptions } from '../../../src/app/video-export';
import {
  defaultVideoWindow,
  formForPiece,
  formSettled,
  formWithRecord,
  recordFromForm,
  videoContextFor,
  videoFields,
} from '../../../src/app/video-doc';
import { canonicalPiece, roundTime } from '../../../src/core/canonical';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PieceVideo } from '../../../src/core/types';
import { drawVideoFrame } from '../../../src/render';
import { SvgContext, asCtx2D } from '../../../src/render/svg';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const r = parsePiece(JSON.parse(readFileSync(join(SONGS, 'kite-day.algorhythms.json'), 'utf8')));
if (!r.ok) throw new Error(r.errors.join('; '));
const KITE: Piece = r.piece;
const KITE_C = compile(KITE);
const D = KITE_C.duration;

/** Two viewers' remembered options and apps, as different as they come. */
const VIEWER_A: ExportForm = {
  ...DEFAULT_EXPORT_FORM,
  videoAspect: '1:1',
  videoCamera: 'follow',
  videoFollowAt: 70,
  videoWindow: 5,
  videoHud: ['time'],
  hudLayout: { time: { anchor: 'tr', x: -0.02, y: 0.02 } },
  videoTitleCard: true,
  videoEndCard: 5,
  look: { ...DEFAULT_LOOK_FORM, theme: 'light', guides: true, glow: 0.8 },
};
const VIEWER_B: ExportForm = {
  ...DEFAULT_EXPORT_FORM,
  look: { ...DEFAULT_LOOK_FORM, theme: 'dark' },
};
const LIVE_A: VideoContext = { window: 7, duration: D, dark: false, colors: 'pitch', loop: null };
const LIVE_B: VideoContext = { window: 40, duration: D, dark: true, colors: 'custom', loop: null };

/** The maker's edited video: what the Video workspace shows. */
const MAKER: ExportForm = {
  ...DEFAULT_EXPORT_FORM,
  format: 'video',
  videoAspect: '9:16',
  videoCamera: 'follow',
  videoWindow: null,
  videoHud: ['time', 'chord'],
  hudLayout: { time: { anchor: 'bl', x: 0.03, y: -0.04 } },
  section: 'custom',
  sectionSpan: { start: 4, end: 30 },
  videoFadeIn: 1,
  videoTitleCard: true,
  videoSubtitle: 'for Sam',
  videoFadeOut: 1.5,
  videoEndCard: 10,
  videoCredit: '',
  look: { ...DEFAULT_LOOK_FORM, theme: 'current', glow: 0.4, playhead: false, future: 'full' },
};
const LIVE_MAKER: VideoContext = {
  window: 9,
  duration: D,
  dark: true,
  colors: 'pitch',
  loop: null,
};

const withRecord = (piece: Piece, rec: PieceVideo): Piece =>
  canonicalPiece({ ...piece, video: rec });

/** Frame k of `piece`'s video as a viewer with `base` options and app `live` draws it. */
function frame(piece: Piece, base: ExportForm, live: VideoContext, k: number): string {
  const form = formForPiece(base, piece, D);
  const ctx = videoContextFor(piece, live);
  const o = { ...videoOptions(form, piece, ctx), size: '720' as const, fps: 30 as const };
  const svg = new SvgContext(1280, 720);
  drawVideoFrame(asCtx2D(svg), KITE_C, frameOptions(piece, o, KITE_C), k, 30);
  return svg.toSvg();
}

describe('the video record (M17)', () => {
  it('stores only what differs from the defaults (the theme always, resolved)', () => {
    const rec = recordFromForm({ ...DEFAULT_EXPORT_FORM, videoWindow: null }, KITE, {
      ...LIVE_MAKER,
      window: KITE.view.window,
    });
    expect(rec).toEqual({ look: { theme: 'dark' } });
  });

  it('captures what the form shows: the editor zoom as the window, the section as times', () => {
    const rec = recordFromForm(MAKER, KITE, LIVE_MAKER);
    expect(rec).toMatchObject({
      aspect: '9:16',
      hud: ['time', 'chord'],
      hudLayout: { time: { anchor: 'bl', x: 0.03, y: -0.04 } },
      section: { start: 4, end: 30 },
      fadeIn: 1,
      titleCard: true,
      subtitle: 'for Sam',
      fadeOut: 1.5,
      endCard: 10,
      credit: '',
      look: { theme: 'dark', glow: 0.4, playhead: false, future: 'full' },
    });
    expect(rec.window).toBe(
      roundTime(followWindowOf({ videoWindow: null, videoAspect: '9:16' }, LIVE_MAKER)),
    );
    expect(rec.window).not.toBe(defaultVideoWindow(KITE, '9:16', D));
    // Whole piece is the record's; Follow, Auto and Keys are the piece's camera.
    expect(recordFromForm({ ...MAKER, videoCamera: 'whole' }, KITE, LIVE_MAKER).whole).toBe(true);
    expect(recordFromForm(MAKER, KITE, LIVE_MAKER).whole).toBeUndefined();
  });

  it('a Loop region section is stored as its times', () => {
    const loop = { ...LIVE_MAKER, loop: { start: 10, end: 20 } };
    expect(recordFromForm({ ...MAKER, section: 'loop' }, KITE, loop).section).toEqual({
      start: 10,
      end: 20,
    });
  });

  it("'app' lines keep the maker's app colours only when they differ from the piece's", () => {
    const same = recordFromForm(MAKER, KITE, { ...LIVE_MAKER, colors: KITE.view.colors });
    expect(same.look?.appColors).toBeUndefined();
    const other = KITE.view.colors === 'custom' ? 'pitch' : 'custom';
    const rec = recordFromForm(MAKER, KITE, { ...LIVE_MAKER, colors: other });
    expect(rec.look?.appColors).toBe(other);
    expect(videoContextFor(withRecord(KITE, rec), LIVE_A).colors).toBe(other);
    expect(videoContextFor(withRecord(KITE, { look: {} }), LIVE_B).colors).toBe(KITE.view.colors);
    expect(videoContextFor(KITE, LIVE_B)).toBe(LIVE_B);
  });

  it('the form shows the record over the defaults, never over the viewer’s options', () => {
    const piece = withRecord(KITE, recordFromForm(MAKER, KITE, LIVE_MAKER));
    const a = videoFields(formWithRecord(VIEWER_A, piece, D));
    const b = videoFields(formWithRecord(VIEWER_B, piece, D));
    expect(a).toEqual(b);
    expect(a.videoAspect).toBe('9:16');
    expect(a.videoHud).toEqual(['time', 'chord']);
    expect(a.videoFollowAt).toBeNull();
    expect(a.look.theme).toBe('dark');
    expect(a.look.guides).toBe(DEFAULT_LOOK_FORM.guides);
    expect(a.videoCredit).toBe('');
    // File settings stay the viewer's.
    expect(formWithRecord(VIEWER_A, piece, D).videoSize).toBe(VIEWER_A.videoSize);
    // Written again from what it shows, the record is the same.
    expect(
      recordFromForm(formWithRecord(VIEWER_A, piece, D), piece, videoContextFor(piece, LIVE_A)),
    ).toEqual(piece.video);
  });

  it('an empty record is the fixed defaults; a piece without one keeps the viewer’s form', () => {
    const piece = withRecord(KITE, {});
    const f = formWithRecord(VIEWER_A, piece, D);
    expect(f.videoAspect).toBe('16:9');
    expect(f.videoTitleCard).toBe(false);
    expect(f.videoWindow).toBe(defaultVideoWindow(KITE, '16:9', D));
    expect(f.look).toEqual(DEFAULT_LOOK_FORM);
    expect(formForPiece(VIEWER_A, KITE, D)).toBe(VIEWER_A);
  });

  it('with a poster, the poster’s section and Look keys draw over the record’s', () => {
    const piece = withRecord(
      { ...KITE, poster: { section: { start: 2, end: 12 }, look: { theme: 'light' } } },
      recordFromForm(MAKER, KITE, LIVE_MAKER),
    );
    const f = formWithRecord(VIEWER_A, piece, D);
    expect(f.sectionSpan).toEqual({ start: 2, end: 12 });
    expect(f.look.theme).toBe('light');
    // The video's own Look keys are the record's.
    expect(f.look.playhead).toBe(false);
    // Over the poster, a record without a window frames one row.
    expect(defaultVideoWindow(piece, '16:9', D)).toBeNull();
  });

  it('after a write the form keeps Current and Loop region when they show the record', () => {
    const live = { ...LIVE_MAKER, loop: { start: 10, end: 20 } };
    const form = { ...MAKER, section: 'loop' as const };
    const piece = withRecord(KITE, recordFromForm(form, KITE, live));
    const ctx = videoContextFor(piece, live);
    const f = formSettled(form, piece, D, ctx);
    expect(f.look.theme).toBe('current');
    expect(f.section).toBe('loop');
    expect(f.videoWindow).toBe(piece.video?.window);
  });
});

describe('frame fidelity (M17)', () => {
  const ks = [0, 150, 600];

  it('a piece with a record draws byte-identical frames under different remembered options', () => {
    const piece = withRecord(KITE, recordFromForm(MAKER, KITE, LIVE_MAKER));
    for (const k of ks)
      expect(frame(piece, VIEWER_A, LIVE_A, k)).toBe(frame(piece, VIEWER_B, LIVE_B, k));
  });

  it("the watcher's frames are the maker's", () => {
    const piece = withRecord(KITE, recordFromForm(MAKER, KITE, LIVE_MAKER));
    const ctx = videoContextFor(piece, LIVE_MAKER);
    // The maker's workspace after the write (`settle`).
    const maker = formSettled(MAKER, piece, D, ctx);
    for (const k of ks) {
      const o = { ...videoOptions(maker, piece, ctx), size: '720' as const, fps: 30 as const };
      const svg = new SvgContext(1280, 720);
      drawVideoFrame(asCtx2D(svg), KITE_C, frameOptions(piece, o, KITE_C), k, 30);
      expect(frame(piece, VIEWER_A, LIVE_A, k)).toBe(svg.toSvg());
    }
  });

  it('a piece with a record and a poster draws the same frames for every viewer', () => {
    const piece = withRecord(
      { ...KITE, poster: { rows: 2, look: { theme: 'light' } } },
      recordFromForm(MAKER, KITE, LIVE_MAKER),
    );
    for (const k of ks)
      expect(frame(piece, VIEWER_A, LIVE_A, k)).toBe(frame(piece, VIEWER_B, LIVE_B, k));
  });

  it('a piece without a record still follows the viewer’s options', () => {
    expect(frame(KITE, VIEWER_A, LIVE_A, 150)).not.toBe(frame(KITE, VIEWER_B, LIVE_B, 150));
  });
});
