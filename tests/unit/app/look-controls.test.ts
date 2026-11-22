import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  type ExportForm,
  type LookForm,
} from '../../../src/app/export-options';
import {
  LOOK_CONTROLS,
  followAtHint,
  hudSummary,
  lookControls,
} from '../../../src/app/look-controls';
import { DEFAULT_HUD } from '../../../src/render/hud';

const ctl = (id: string) => LOOK_CONTROLS.find((c) => c.id === id)!;
const form = (look: Partial<LookForm> = {}, f: Partial<ExportForm> = {}): ExportForm => ({
  ...DEFAULT_EXPORT_FORM,
  ...f,
  look: { ...DEFAULT_EXPORT_FORM.look, ...look },
});
const apply = (f: ExportForm, id: string, v: string): ExportForm => ({
  ...f,
  ...ctl(id).apply(f, v),
});

describe('look-controls', () => {
  it('the defaults select the EXPORT_LOOK values', () => {
    const f = DEFAULT_EXPORT_FORM;
    const values = Object.fromEntries(LOOK_CONTROLS.map((c) => [c.id, c.value(f)]));
    expect(values).toEqual({
      guides: 'off',
      beats: 'off',
      moments: 'labels',
      future: 'hidden',
      'follow-at': '80',
      playhead: 'on',
      level: 'on',
      thickness: 'on',
      pulse: 'on',
      heads: 'all',
      colors: 'app',
      width: 'normal',
      background: 'off',
    });
  });

  it('two-way choices are switches (on / off); the rest stay dropdowns', () => {
    const toggles = LOOK_CONTROLS.filter((c) => c.toggle).map((c) => c.id);
    expect(toggles).toEqual(['playhead', 'level', 'thickness', 'pulse', 'background']);
    for (const c of LOOK_CONTROLS) {
      const values = c.choices(DEFAULT_EXPORT_FORM).map((o) => o.value);
      if (c.toggle) expect(values, c.id).toEqual(['on', 'off']);
      else expect(values.length, c.id).toBeGreaterThan(2);
    }
  });

  it('every option round-trips: applying it selects it, and touches only its fields', () => {
    for (const c of LOOK_CONTROLS) {
      for (const o of c.choices(DEFAULT_EXPORT_FORM)) {
        const f = apply(DEFAULT_EXPORT_FORM, c.id, o.value);
        expect(c.value(f), `${c.id} ${o.value}`).toBe(o.value);
        // The selected value is always among the choices.
        expect(c.choices(f).some((x) => x.value === c.value(f))).toBe(true);
        // Nothing outside the Look or the playhead place changes.
        const { look: _l, videoFollowAt: _v, ...rest } = f;
        const { look: _l0, videoFollowAt: _v0, ...rest0 } = DEFAULT_EXPORT_FORM;
        expect(rest).toEqual(rest0);
      }
    }
  });

  it('maps to the same fields as the old checkboxes and radios', () => {
    const f0 = DEFAULT_EXPORT_FORM;
    expect(apply(f0, 'guides', 'labels').look).toMatchObject({ guides: true, guideLabels: true });
    expect(apply(f0, 'guides', 'lines').look).toMatchObject({ guides: true, guideLabels: false });
    expect(apply(form({ guides: true, guideLabels: true }), 'guides', 'off').look).toMatchObject({
      guides: false,
      guideLabels: false,
    });
    expect(apply(f0, 'moments', 'labels').look).toMatchObject({ markers: false, sections: true });
    expect(apply(f0, 'moments', 'markers').look).toMatchObject({ markers: true, sections: false });
    expect(apply(f0, 'future', 'dimmed:50').look).toMatchObject({
      future: 'dimmed',
      futureOpacity: 0.5,
    });
    // Hidden and Full keep the dimmed opacity (as the old radios did).
    const dim = apply(f0, 'future', 'dimmed:75');
    expect(apply(dim, 'future', 'full').look).toMatchObject({
      future: 'full',
      futureOpacity: 0.75,
    });
    expect(apply(f0, 'heads', 'dots').look).toMatchObject({
      dots: true,
      rings: false,
      hzLabels: false,
    });
    expect(apply(f0, 'heads', 'none').look).toMatchObject({
      dots: false,
      rings: false,
      hzLabels: false,
    });
    expect(apply(f0, 'level', 'off').look.levelOpacity).toBe(false);
    expect(apply(f0, 'thickness', 'off').look.thickness).toBe(false);
    expect(apply(f0, 'pulse', 'off').look.pulseMarks).toBe(false);
    expect(apply(f0, 'playhead', 'off').look.playhead).toBe(false);
    expect(apply(f0, 'beats', 'auto').look.beats).toBe('auto');
    expect(apply(f0, 'beats', 'every').look.beats).toBe('every');
    expect(apply(f0, 'background', 'on').look.transparent).toBe(true);
    expect(apply(f0, 'colors', 'custom').look.colors).toBe('custom');
    expect(apply(f0, 'width', 'bold').look.lineWidth).toBe('bold');
    expect(ctl('future').apply(f0, 'nonsense')).toEqual({});
  });

  it('Playhead at follows the future until chosen', () => {
    const f0 = DEFAULT_EXPORT_FORM;
    expect(ctl('follow-at').value(f0)).toBe('80');
    const dim = apply(f0, 'future', 'dimmed:35');
    expect(dim.videoFollowAt).toBeNull();
    expect(ctl('follow-at').value(dim)).toBe('35');
    expect(followAtHint(dim)).toMatch(/35 % follows Ahead/);
    const set = apply(dim, 'follow-at', '65');
    expect(set.videoFollowAt).toBe(65);
    expect(ctl('follow-at').value(apply(set, 'future', 'hidden'))).toBe('65');
    expect(followAtHint(set)).toBe('Across the frame.');
    expect(followAtHint({ ...set, videoCamera: 'whole' })).toMatch(/^Follow only/);
  });

  it('a stored state no option names gets its own option', () => {
    const odd = form(
      { future: 'dimmed', futureOpacity: 0.6, dots: false, rings: true, hzLabels: false },
      {
        videoFollowAt: 45,
      },
    );
    const has = (id: string, v: string) =>
      ctl(id)
        .choices(odd)
        .find((c) => c.value === v);
    expect(ctl('future').value(odd)).toBe('dimmed:60');
    expect(has('future', 'dimmed:60')?.label).toBe('Dimmed 60 %');
    expect(has('follow-at', '45')?.label).toBe('45 %');
    expect(ctl('heads').value(odd)).toBe('custom:010');
    expect(has('heads', 'custom:010')?.label).toBe('Rings (no dots)');
    // Each list is sorted and has no duplicates.
    const vals = ctl('follow-at')
      .choices(odd)
      .map((c) => Number(c.value));
    expect(vals).toEqual([...vals].sort((a, b) => a - b));
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('video and poster show their own controls', () => {
    const ids = (k: 'video' | 'poster') => lookControls(k).map((c) => c.id);
    expect(ids('video')).not.toContain('background');
    for (const id of ['future', 'follow-at', 'playhead', 'heads']) {
      expect(ids('poster')).not.toContain(id);
      expect(ids('video')).toContain(id);
    }
    expect(ids('poster')).toContain('background');
  });

  it('hudSummary counts readouts', () => {
    expect(hudSummary(DEFAULT_HUD)).toBe('6 readouts');
    expect(hudSummary(['chord'])).toBe('1 readout');
    expect(hudSummary([])).toBe('None');
  });
});
