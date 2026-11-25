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
import { DEFAULT_EXPORT_FORM } from '../../../src/app/export-options';
import {
  VIDEO_LOOK_KEYS,
  changedFields,
  docWithForm,
  formWithDoc,
  posterFields,
  posterLook,
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
});
