/** M14 P6: switch details, the default poster (Revert), the background gradient's handles. */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLOURS,
  RADIUS_MAX,
  gradientAngle,
  gradientStops,
  type ColoursForm,
} from '../../../src/app/export-colours';
import { DEFAULT_EXPORT_FORM } from '../../../src/app/export-options';
import {
  centredLine,
  dragGradientHandle,
  gradientHandles,
  type GradientHandle,
} from '../../../src/app/gradient-handles';
import {
  DETAILS,
  parseOpenDetails,
  toggledDetails,
  type DetailsId,
} from '../../../src/app/poster-details';
import { defaultPosterDoc, docWithForm, posterFields } from '../../../src/app/poster-doc';
import type { PosterDoc } from '../../../src/core/types';
import { GROUP_FIELDS, POSTER_GROUPS } from '../../../src/render';
import { LIGHT_TOKENS } from '../../../src/render/palettes';

const T = LIGHT_TOKENS;
const W = 3840;
const H = 2160;
const c = (p: Partial<ColoursForm>): ColoursForm => ({
  ...DEFAULT_COLOURS,
  background: 'gradient',
  bgFrom: '#ff0000',
  bgTo: '#0000ff',
  ...p,
});
const handle = (f: ColoursForm, kind: GradientHandle['kind'], stop?: number) =>
  gradientHandles(f, T, W, H)!.handles.find(
    (h) => h.kind === kind && (stop === undefined || h.stop === stop),
  )!;

describe('switch details', () => {
  it('each opens real groups that have style fields besides Visible', () => {
    for (const d of Object.values(DETAILS)) {
      expect(d.groups.length).toBeGreaterThan(0);
      for (const g of d.groups) {
        expect(POSTER_GROUPS).toContain(g);
        expect(GROUP_FIELDS[g].filter((f) => f !== 'visible').length).toBeGreaterThan(2);
      }
    }
  });

  it('the remembered open list: known ids once; bad stores read as none', () => {
    expect(parseOpenDetails('["pulseMarks","nope","hud","pulseMarks"]')).toEqual([
      'pulseMarks',
      'hud',
    ]);
    expect(parseOpenDetails(null)).toEqual([]);
    expect(parseOpenDetails('{')).toEqual([]);
    expect(parseOpenDetails('{"a":1}')).toEqual([]);
    const open: DetailsId[] = ['hud'];
    expect(toggledDetails(open, 'pulseMarks')).toEqual(['hud', 'pulseMarks']);
    expect(toggledDetails(['hud', 'pulseMarks'], 'hud')).toEqual(['pulseMarks']);
  });
});

describe('the default poster (Revert)', () => {
  const ctx = { dark: false, duration: 60, loop: null };

  it('is the export defaults: only the resolved theme', () => {
    expect(defaultPosterDoc(ctx)).toEqual({ look: { theme: 'light' } });
    expect(defaultPosterDoc({ ...ctx, dark: true })).toEqual({ look: { theme: 'dark' } });
  });

  it('drops objects, styles, rows by sections and the picture', () => {
    const busy: PosterDoc = {
      rows: 3,
      texts: [],
      groups: { pulseMarks: { size: 2 } },
      rowsBy: 'sections',
      rowSections: { a: { label: 'A' } },
      picture: { src: 'data:image/png;base64,AA', w: 1, h: 1 },
    };
    // The form keeps P5's fields (a panel change must not drop them) …
    const kept = docWithForm(busy, posterFields(DEFAULT_EXPORT_FORM), ctx)!;
    expect(kept.rowsBy).toBe('sections');
    expect(kept.rowSections).toEqual({ a: { label: 'A' } });
    expect(kept.picture?.w).toBe(1);
    // … and the default doc has none of them.
    expect(defaultPosterDoc(ctx)).not.toHaveProperty('groups');
  });
});

describe('gradient handles', () => {
  it('none without a gradient background', () => {
    expect(gradientHandles(DEFAULT_COLOURS, T, W, H)).toBeNull();
  });

  it('linear: the ends at the first and last stops on the line through the centre', () => {
    const f = c({ bgDir: 'linear', bgAngle: 90 });
    const g = gradientHandles(f, T, W, H)!;
    expect(g.shape).toBe('linear');
    expect(handle(f, 'start')).toMatchObject({ x: 0, y: H / 2 });
    expect(handle(f, 'end')).toMatchObject({ x: W, y: H / 2 });
    // M11's vertical gradient: top to bottom, through the centre.
    const v = c({ bgDir: 'vertical' });
    expect(handle(v, 'start')).toMatchObject({ x: W / 2, y: 0 });
    expect(handle(v, 'end')).toMatchObject({ x: W / 2, y: H });
    // A stop between the ends.
    const three = c({
      bgDir: 'linear',
      bgAngle: 90,
      bgStops: [
        { color: '#ff0000', at: 0 },
        { color: '#00ff00', at: 0.25 },
        { color: '#0000ff', at: 1 },
      ],
    });
    expect(handle(three, 'stop', 1)).toMatchObject({ x: W / 4, y: H / 2 });
  });

  it('a handle outside the poster is shown on its edge', () => {
    const f = c({ bgDir: 'linear', bgAngle: 45 });
    const end = handle(f, 'end');
    expect(end.y).toBeLessThan(0);
    expect(end.shown.y).toBeCloseTo(0, 6);
    expect(end.shown.x).toBeGreaterThan(W / 2);
    expect(end.shown.x).toBeLessThanOrEqual(W);
  });

  it('dragging an end turns the angle and moves that end along the line', () => {
    const f = c({ bgDir: 'linear', bgAngle: 90 });
    // The end straight down, halfway: 180°, the end stop at 3/4 of the line.
    const p = dragGradientHandle(f, T, handle(f, 'end'), W / 2, H, W, H);
    expect(p.bgAngle).toBe(180);
    expect(p.bgDir).toBe('linear');
    expect(p.bgStops?.map((s) => s.at)).toEqual([0, 1]);
    const q = dragGradientHandle(f, T, handle(f, 'end'), (W * 3) / 4, H / 2, W, H);
    expect(q.bgAngle).toBe(90);
    expect(q.bgStops?.map((s) => s.at)).toEqual([0, 0.75]);
    // The start: the line points from it through the centre.
    const r = dragGradientHandle(f, T, handle(f, 'start'), W / 2, 0, W, H);
    expect(r.bgAngle).toBe(180);
  });

  it('the stops between keep their places relative to the ends', () => {
    const f = c({
      bgDir: 'linear',
      bgAngle: 90,
      bgStops: [
        { color: '#ff0000', at: 0 },
        { color: '#00ff00', at: 0.5 },
        { color: '#0000ff', at: 1 },
      ],
    });
    const p = dragGradientHandle(f, T, handle(f, 'end'), W / 2, H / 2 + 1e-9, W, H);
    // At the centre: no direction, so the angle stays; the end comes in to the middle.
    expect(p.bgAngle).toBeUndefined();
    expect(p.bgStops?.map((s) => s.at)).toEqual([0, 0.25, 0.5]);
    const q = dragGradientHandle(f, T, handle(f, 'end'), W * 0.6, H / 2, W, H);
    expect(q.bgStops?.map((s) => s.at)).toEqual([0, 0.3, 0.6]);
  });

  it('an end past the centre keeps its direction (no flip on a small drag)', () => {
    const f = c({
      bgDir: 'linear',
      bgAngle: 90,
      bgStops: [
        { color: '#ff0000', at: 0.6 },
        { color: '#0000ff', at: 1 },
      ],
    });
    const s = handle(f, 'start');
    const p = dragGradientHandle(f, T, s, s.x + 10, s.y + 1, W, H);
    expect(p.bgAngle).toBe(90);
  });

  it('dragging a stop moves it along the line; the angle stays', () => {
    const f = c({
      bgDir: 'linear',
      bgAngle: 90,
      bgStops: [
        { color: '#ff0000', at: 0 },
        { color: '#00ff00', at: 0.25 },
        { color: '#0000ff', at: 1 },
      ],
    });
    const p = dragGradientHandle(f, T, handle(f, 'stop', 1), W * 0.4, H * 0.9, W, H);
    expect(p.bgStops?.map((s) => s.at)).toEqual([0, 0.4, 1]);
    expect(p.bgAngle).toBeUndefined();
    expect(gradientAngle({ ...f, ...p })).toBe(90);
  });

  it('radial: the centre and the radius', () => {
    const f = c({ bgDir: 'radial', bgCx: 0.5, bgCy: 0.5, bgR: 0.5 });
    const g = gradientHandles(f, T, W, H)!;
    expect(g.shape).toBe('radial');
    const hd = Math.hypot(W, H) / 2;
    expect(handle(f, 'centre')).toMatchObject({ x: W / 2, y: H / 2 });
    expect(handle(f, 'radius').x).toBeCloseTo(W / 2 + 0.5 * hd, 6);
    expect(g.circle?.r).toBeCloseTo(0.5 * hd, 6);
    expect(dragGradientHandle(f, T, handle(f, 'centre'), W * 0.25, H * 0.75, W, H)).toEqual({
      bgCx: 0.25,
      bgCy: 0.75,
    });
    expect(dragGradientHandle(f, T, handle(f, 'radius'), W / 2, H / 2 + hd, W, H)).toEqual({
      bgR: 1,
    });
    expect(dragGradientHandle(f, T, handle(f, 'radius'), W * 100, H / 2, W, H).bgR).toBe(
      RADIUS_MAX,
    );
  });

  it('centredLine: an axis-aligned line through the centre', () => {
    expect(centredLine(180, W, H)).toEqual({ x0: W / 2, y0: 0, x1: W / 2, y1: H });
    expect(centredLine(90, W, H)).toEqual({ x0: 0, y0: H / 2, x1: W, y1: H / 2 });
    expect(gradientStops(c({}), T).length).toBe(2);
  });
});
