import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  lookOf,
  parsePrefs,
  type ExportForm,
  type LookForm,
} from '../../../src/app/export-options';
import {
  LOOK_CONTROLS,
  followAtHint,
  futureFromPercent,
  futurePercent,
  hudSummary,
  lookControls,
  type LookControl,
  type LookSegments,
  type LookSlider,
  type LookToggle,
} from '../../../src/app/look-controls';
import { DEFAULT_HUD } from '../../../src/render/hud';
import { EXPORT_LOOK, lookStyle } from '../../../src/render/look';

const ctl = (id: string) => LOOK_CONTROLS.find((c) => c.id === id)!;
const seg = (id: string) => ctl(id) as LookSegments;
const slider = (id: string) => ctl(id) as LookSlider;
const toggle = (id: string) => ctl(id) as LookToggle;
const form = (look: Partial<LookForm> = {}, f: Partial<ExportForm> = {}): ExportForm => ({
  ...DEFAULT_EXPORT_FORM,
  ...f,
  look: { ...DEFAULT_EXPORT_FORM.look, ...look },
});
const pick = (f: ExportForm, id: string, v: string): ExportForm => ({
  ...f,
  ...seg(id).apply(f, v),
});
const slide = (f: ExportForm, id: string, n: number): ExportForm => ({
  ...f,
  ...slider(id).apply(f, n),
});
const flip = (f: ExportForm, id: string, on: boolean): ExportForm => ({
  ...f,
  ...toggle(id).apply(f, on),
});

/** The control's value as a plain value (flags: the on flags). */
function valueOf(c: LookControl, f: ExportForm): unknown {
  if (c.type === 'flags') return c.flags.filter((x) => f.look[x.key]).map((x) => x.id);
  return c.value(f);
}

describe('look-controls', () => {
  it('the defaults show the EXPORT_LOOK values', () => {
    const f = DEFAULT_EXPORT_FORM;
    const values = Object.fromEntries(LOOK_CONTROLS.map((c) => [c.id, valueOf(c, f)]));
    expect(values).toEqual({
      guides: 'off',
      beats: 'off',
      moments: 'labels',
      future: 0,
      'follow-at': 80,
      playhead: true,
      level: true,
      thickness: true,
      pulse: true,
      heads: ['dots', 'rings', 'hz'],
      width: 1,
    });
  });

  it('continuous values are sliders, yes/no switches, small sets segments; no dropdowns', () => {
    const by = (t: LookControl['type']) =>
      LOOK_CONTROLS.filter((c) => c.type === t).map((c) => c.id);
    expect(by('slider')).toEqual(['future', 'follow-at', 'width']);
    expect(by('toggle')).toEqual(['playhead', 'level', 'thickness', 'pulse']);
    expect(by('segments')).toEqual(['guides', 'beats', 'moments']);
    expect(by('flags')).toEqual(['heads']);
    for (const c of LOOK_CONTROLS) {
      if (c.type !== 'segments') continue;
      expect(c.choices.length, c.id).toBeGreaterThanOrEqual(2);
      expect(c.choices.length, c.id).toBeLessThanOrEqual(4);
      // Short enough for one bar at phone width.
      expect(c.choices.map((o) => o.label).join('').length, c.id).toBeLessThanOrEqual(28);
    }
  });

  it('every segment round-trips: applying it selects it, and touches only the Look', () => {
    for (const c of LOOK_CONTROLS) {
      if (c.type !== 'segments') continue;
      for (const o of c.choices) {
        const f = pick(DEFAULT_EXPORT_FORM, c.id, o.value);
        expect(c.value(f), `${c.id} ${o.value}`).toBe(o.value);
        const { look: _l, ...rest } = f;
        const { look: _l0, ...rest0 } = DEFAULT_EXPORT_FORM;
        expect(rest).toEqual(rest0);
      }
      expect(c.apply(DEFAULT_EXPORT_FORM, 'nonsense')).toEqual({});
    }
  });

  it('maps to the same fields as the old checkboxes, radios and dropdowns', () => {
    const f0 = DEFAULT_EXPORT_FORM;
    expect(pick(f0, 'guides', 'labels').look).toMatchObject({ guides: true, guideLabels: true });
    expect(pick(f0, 'guides', 'lines').look).toMatchObject({ guides: true, guideLabels: false });
    expect(pick(form({ guides: true, guideLabels: true }), 'guides', 'off').look).toMatchObject({
      guides: false,
      guideLabels: false,
    });
    expect(pick(f0, 'moments', 'labels').look).toMatchObject({ markers: false, sections: true });
    expect(pick(f0, 'moments', 'markers').look).toMatchObject({ markers: true, sections: false });
    expect(pick(f0, 'moments', 'all').look).toMatchObject({ markers: true, sections: true });
    expect(pick(f0, 'moments', 'off').look).toMatchObject({ markers: false, sections: false });
    expect(flip(f0, 'level', false).look.levelOpacity).toBe(false);
    expect(flip(f0, 'thickness', false).look.thickness).toBe(false);
    expect(flip(f0, 'pulse', false).look.pulseMarks).toBe(false);
    expect(flip(f0, 'playhead', false).look.playhead).toBe(false);
    expect(pick(f0, 'beats', 'auto').look.beats).toBe('auto');
    expect(pick(f0, 'beats', 'every').look.beats).toBe('every');
    // Heads: each flag is its own field, so every combination is reachable.
    const heads = ctl('heads');
    expect(heads.type === 'flags' && heads.flags.map((x) => x.key)).toEqual([
      'dots',
      'rings',
      'hzLabels',
    ]);
  });

  it('Ahead of the playhead: 0 hidden, 100 full, between dimmed at that opacity', () => {
    const f0 = DEFAULT_EXPORT_FORM;
    expect(slide(f0, 'future', 0).look.future).toBe('hidden');
    expect(slide(f0, 'future', 100).look.future).toBe('full');
    expect(slide(f0, 'future', 50).look).toMatchObject({ future: 'dimmed', futureOpacity: 0.5 });
    expect(slide(f0, 'future', 1).look).toMatchObject({ future: 'dimmed', futureOpacity: 0.01 });
    expect(slide(f0, 'future', 99).look).toMatchObject({ future: 'dimmed', futureOpacity: 0.99 });
    expect(slide(f0, 'future', 0.3).look.future).toBe('hidden');
    // Hidden and Full keep the dimmed opacity (as the old radios did).
    const dim = slide(f0, 'future', 75);
    expect(slide(dim, 'future', 100).look).toMatchObject({ future: 'full', futureOpacity: 0.75 });
    expect(slide(dim, 'future', 0).look).toMatchObject({ future: 'hidden', futureOpacity: 0.75 });
    // The slider shows each state where it maps back to it.
    for (const n of [0, 1, 20, 35, 50, 99, 100]) {
      expect(slider('future').value(slide(f0, 'future', n))).toBe(n);
      expect(futurePercent(futureFromPercent(n) as LookForm)).toBe(n);
    }
    // Stored dimmed opacities show at their percentage, never at an end.
    expect(futurePercent({ future: 'dimmed', futureOpacity: 0.6 })).toBe(60);
    expect(futurePercent({ future: 'dimmed', futureOpacity: 0.001 })).toBe(1);
    expect(futurePercent({ future: 'dimmed', futureOpacity: 0.999 })).toBe(99);
    expect(slider('future').text(0)).toBe('Hidden');
    expect(slider('future').text(100)).toBe('Full');
    expect(slider('future').text(50)).toBe('50 %');
    // The renderer's opacity is the slider's.
    const app = { dark: false, colors: 'pitch' } as const;
    const styleAt = (n: number) => lookStyle(lookOf(slide(f0, 'future', n), 'video', app));
    expect(styleAt(50).futureOpacity).toBe(0.5);
    expect(styleAt(0)).toMatchObject({ futureOpacity: 0, aheadHidden: true });
    expect(styleAt(100).futureOpacity).toBe(1);
    expect(slider('future').apply(f0, NaN)).toEqual({});
  });

  it('Playhead at: continuous 10..90 %; follows Ahead until moved', () => {
    const f0 = DEFAULT_EXPORT_FORM;
    const at = slider('follow-at');
    expect([at.min, at.max, at.step]).toEqual([10, 90, 1]);
    expect(at.value(f0)).toBe(80);
    const dim = slide(f0, 'future', 35);
    expect(dim.videoFollowAt).toBeNull();
    expect(at.value(dim)).toBe(35);
    expect(followAtHint(dim)).toMatch(/35 % follows Ahead/);
    const set = slide(dim, 'follow-at', 62);
    expect(set.videoFollowAt).toBe(62);
    expect(at.value(slide(set, 'future', 0))).toBe(62);
    expect(followAtHint(set)).toBe('Across the frame.');
    expect(followAtHint({ ...set, videoCamera: 'whole' })).toMatch(/^Follow only/);
    expect(slide(f0, 'follow-at', 5).videoFollowAt).toBe(10);
    expect(slide(f0, 'follow-at', 47.4).videoFollowAt).toBe(47);
    // A stored place off the old steps shows as is.
    expect(at.value(form({}, { videoFollowAt: 45 }))).toBe(45);
    expect(at.text(62)).toBe('62 %');
  });

  it('Line width: a factor 0.5×..2×; names show at their factor', () => {
    const w = slider('width');
    expect([w.min, w.max]).toEqual([0.5, 2]);
    expect(w.value(form({ lineWidth: 'bold' }))).toBe(1.75);
    expect(w.value(form({ lineWidth: 'thin' }))).toBe(0.6);
    expect(w.value(DEFAULT_EXPORT_FORM)).toBe(1);
    expect(slide(DEFAULT_EXPORT_FORM, 'width', 1.5).look.lineWidth).toBe(1.5);
    expect(slide(DEFAULT_EXPORT_FORM, 'width', 3).look.lineWidth).toBe(2);
    expect(slide(DEFAULT_EXPORT_FORM, 'width', 0.30000001).look.lineWidth).toBe(0.5);
    expect(w.text(1)).toBe('1×');
    expect(w.text(1.75)).toBe('1.75×');
    const style = (lineWidth: LookForm['lineWidth']) =>
      lookStyle({ ...EXPORT_LOOK, lineWidth }).lineScale;
    expect(style(1.5)).toBe(1.5);
    expect(style(1)).toBeUndefined();
    expect(style('bold')).toBe(1.75);
    expect(style(9)).toBe(2);
  });

  it('stored prefs: old shapes load into the new controls', () => {
    const p = parsePrefs({
      v: 2,
      look: { future: 'dimmed', futureOpacity: 0.35, lineWidth: 'bold' },
      videoFollowAt: 65,
    });
    const f = form(p.look, { videoFollowAt: p.videoFollowAt! });
    expect(slider('future').value(f)).toBe(35);
    expect(slider('width').value(f)).toBe(1.75);
    expect(slider('follow-at').value(f)).toBe(65);
    // New shapes: a numeric width (clamped); a dimmed 0 or 1 is Hidden or Full.
    expect(parsePrefs({ v: 2, look: { lineWidth: 1.3 } }).look!.lineWidth).toBe(1.3);
    expect(parsePrefs({ v: 2, look: { lineWidth: 7 } }).look!.lineWidth).toBe(2);
    expect(parsePrefs({ v: 2, look: { lineWidth: 'huge' } }).look!.lineWidth).toBe('normal');
    expect(parsePrefs({ v: 2, look: { future: 'dimmed', futureOpacity: 0 } }).look!.future).toBe(
      'hidden',
    );
    expect(parsePrefs({ v: 2, look: { future: 'dimmed', futureOpacity: 1 } }).look!.future).toBe(
      'full',
    );
  });

  it('video and poster show their own controls', () => {
    const ids = (k: 'video' | 'poster') => lookControls(k).map((c) => c.id);
    expect(ids('video')).not.toContain('background');
    for (const id of ['future', 'follow-at', 'playhead', 'heads']) {
      expect(ids('poster')).not.toContain(id);
      expect(ids('video')).toContain(id);
    }
    expect(ids('poster')).not.toContain('background'); // in the Colours group
  });

  it('hudSummary counts readouts', () => {
    expect(hudSummary(DEFAULT_HUD)).toBe('6 readouts');
    expect(hudSummary(['chord'])).toBe('1 readout');
    expect(hudSummary([])).toBe('None');
  });
});
