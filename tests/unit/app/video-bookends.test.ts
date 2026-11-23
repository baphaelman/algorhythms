/**
 * Ready for YouTube (PLAN.md §12): the export form's opening and ending and Look additions, as
 * they map to VideoOptions and the Look and are remembered; the video's timeline (lead-in
 * samples, padding to the end card).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  EXPORT_PREFS_KEY,
  PITCH_GUIDES_MAX,
  bookendsOf,
  loadExportPrefs,
  lookOf,
  parsePitchGuides,
  parsePrefs,
  saveExportPrefs,
  videoOptions,
  type ExportForm,
} from '../../../src/app/export-options';
import { VIDEO_SAMPLE_RATE, videoAudioFrames, videoTimeline } from '../../../src/app/video-export';
import { compile } from '../../../src/core/compiler/compile';
import { generate } from '../../../src/core/generate';
import { END_CREDIT, videoLength } from '../../../src/render/video';

const form = (over: Partial<ExportForm> = {}): ExportForm => ({ ...DEFAULT_EXPORT_FORM, ...over });
const P = (() => {
  const p = generate(5, { mode: 'dorian', voices: 3 });
  return { ...p, meta: { ...p.meta, title: 'Clip' } };
})();
const ctx = { dark: true, colors: 'pitch' as const, window: 12, duration: 60 };

describe('opening and ending in the form', () => {
  it('all off by default: no bookends, VideoOptions as before', () => {
    expect(bookendsOf(form(), P)).toBeUndefined();
    expect(videoOptions(form({ format: 'video' }), P, ctx)).not.toHaveProperty('bookends');
    expect(DEFAULT_EXPORT_FORM.videoCredit).toBe(END_CREDIT);
  });
  it('maps each option; the title defaults to the piece’s name', () => {
    const b = bookendsOf(
      form({
        videoFadeIn: 1.25,
        videoLeadIn: 2,
        videoTitleCard: true,
        videoSubtitle: ' live ',
        videoFadeOut: 9,
        videoEndCard: 10,
      }),
      P,
    );
    expect(b).toEqual({
      fadeIn: 1.3,
      leadIn: 2,
      title: { text: 'Clip', subtitle: 'live' },
      fadeOut: 3,
      endCard: 10,
      credit: END_CREDIT,
    });
    expect(bookendsOf(form({ videoTitleCard: true, videoTitle: 'Other' }), P)?.title).toEqual({
      text: 'Other',
    });
    expect(bookendsOf(form({ videoEndCard: 5, videoCredit: '' }), P)).toEqual({ endCard: 5 });
    // The end card's credit is only drawn with an end card.
    expect(bookendsOf(form({ videoCredit: 'x' }), P)).toBeUndefined();
    const o = videoOptions(form({ videoLeadIn: 1, videoEndCard: 5 }), P, ctx);
    expect(o.bookends).toEqual({ leadIn: 1, endCard: 5, credit: END_CREDIT });
  });
  it('remembers the options (not the title text) and reads them back clamped', () => {
    const store = new Map<string, string>();
    const st = { getItem: (k: string) => store.get(k) ?? null, setItem: store.set.bind(store) };
    const f = form({
      videoFadeIn: 2,
      videoLeadIn: 1.5,
      videoTitleCard: true,
      videoTitle: 'Per piece',
      videoSubtitle: 'also',
      videoFadeOut: 1,
      videoEndCard: 20,
      videoCredit: 'Mine',
    });
    expect(saveExportPrefs(f, st)).toBe(true);
    const p = loadExportPrefs(st);
    expect(p).toMatchObject({
      videoFadeIn: 2,
      videoLeadIn: 1.5,
      videoTitleCard: true,
      videoFadeOut: 1,
      videoEndCard: 20,
      videoCredit: 'Mine',
    });
    expect(p).not.toHaveProperty('videoTitle');
    expect(p).not.toHaveProperty('videoSubtitle');
    expect(store.has(EXPORT_PREFS_KEY)).toBe(true);
    expect(parsePrefs({ videoFadeIn: 7, videoLeadIn: -1, videoEndCard: 7 })).toEqual({
      videoFadeIn: 3,
      videoLeadIn: 0,
    });
  });
});

describe('Look additions in the form', () => {
  it('pass through to the Look; absent by default', () => {
    expect(lookOf(form(), 'video', ctx)).not.toHaveProperty('glow');
    const f = form({
      look: {
        ...DEFAULT_EXPORT_FORM.look,
        glow: 0.6,
        vignette: 0.3,
        pitchGuides: { pitches: [64], labels: true },
      },
    });
    const l = lookOf(f, 'poster', ctx);
    expect(l.glow).toBe(0.6);
    expect(l.vignette).toBe(0.3);
    expect(l.pitchGuides).toEqual({ pitches: [64], labels: true });
  });
  it('are remembered and validated', () => {
    const p = parsePrefs({
      v: 4,
      look: { glow: 2, vignette: 'x', pitchGuides: { pitches: [64, 'a', 300, 52.5] } },
    });
    expect(p.look?.glow).toBe(1);
    expect(p.look).not.toHaveProperty('vignette');
    expect(p.look?.pitchGuides).toEqual({ pitches: [64, 52.5], labels: true });
    expect(parsePitchGuides({ pitches: [] })).toBeNull();
    expect(parsePitchGuides({ pitches: Array(20).fill(60) })?.pitches).toHaveLength(
      PITCH_GUIDES_MAX,
    );
  });
});

describe('videoTimeline', () => {
  const score = compile(P);
  const music = videoAudioFrames(score, P.mix);
  it('no bookends: the music alone', () => {
    expect(videoTimeline(score, P.mix, {})).toEqual({ lead: 0, music, total: music });
  });
  it('lead-in in whole samples; silence to the end card’s end', () => {
    const sr = VIDEO_SAMPLE_RATE;
    const tl = videoTimeline(score, P.mix, { bookends: { leadIn: 1.23456, endCard: 20 } });
    expect(tl.lead).toBe(Math.round(1.23456 * sr));
    expect(tl.bookends?.leadIn).toBe(tl.lead / sr);
    const len = videoLength(tl.bookends, score.duration, music / sr);
    expect(tl.total).toBe(Math.ceil(len * sr - 1e-6));
    expect(tl.total).toBeGreaterThan(tl.lead + music);
    // A short card inside the ring-out: no padding beyond the music.
    const short = videoTimeline(score, P.mix, { bookends: { leadIn: 1, endCard: 0.001 } });
    expect(short.total).toBe(short.lead + music);
    // A section's music is its span.
    const sec = { start: 10, end: 20 };
    const s = videoTimeline(score, P.mix, { section: sec, bookends: { endCard: 5 } });
    expect(s.music).toBe(10 * sr);
    expect(s.total).toBe(15 * sr);
  });
});
