/** The Colours group's placed gradients (M14 P5): old forms unchanged, new forms and edits. */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SCHEMES,
  DEFAULT_COLOURS,
  addStop,
  backgroundOf,
  gradientAngle,
  gradientStops,
  parseColours,
  removeStop,
  schemeOf,
  withAngle,
  withShape,
  withStop,
  type ColoursForm,
} from '../../../src/app/export-colours';
import { POSTER_MAX_AREA, POSTER_MAX_SIDE } from '../../../src/app/export-options';
import { pictureScale } from '../../../src/app/poster-picture';
import { LIGHT_TOKENS } from '../../../src/render/palettes';
import { patchPicture, setPicture } from '../../../src/render/poster-edit';

const T = LIGHT_TOKENS;
const c = (p: Partial<ColoursForm>): ColoursForm => ({ ...DEFAULT_COLOURS, ...p });
const grad = (p: Partial<ColoursForm> = {}) =>
  c({ background: 'gradient', bgFrom: '#101010', bgTo: '#f0f0f0', ...p });

describe('placed gradients in the colours form', () => {
  it('M11 gradients resolve exactly as before (the built-in schemes too)', () => {
    for (const dir of ['vertical', 'horizontal', 'radial'] as const)
      expect(backgroundOf(grad({ bgDir: dir }), T)).toEqual({
        kind: 'gradient',
        from: '#101010',
        to: '#f0f0f0',
        dir,
      });
    for (const s of BUILTIN_SCHEMES) {
      const bg = backgroundOf(s.colours, T);
      if (s.colours.background === 'gradient') expect(bg?.kind).toBe('gradient');
      expect(schemeOf(s.colours)).toBe(s.id);
    }
  });

  it('an angle, a moved centre or stops make a placed gradient', () => {
    expect(backgroundOf(grad(withAngle(45)), T)).toEqual({
      kind: 'linear',
      stops: [
        { color: '#101010', at: 0 },
        { color: '#f0f0f0', at: 1 },
      ],
      angle: 45,
    });
    expect(backgroundOf(grad({ bgDir: 'radial', bgCx: 0.2, bgR: 0.7 }), T)).toMatchObject({
      kind: 'radial',
      cx: 0.2,
      cy: 0.5,
      r: 0.7,
    });
    const three = grad(addStop(grad(), T));
    expect(backgroundOf(three, T)).toMatchObject({
      kind: 'linear',
      angle: 180,
      stops: [{ at: 0 }, { at: 0.5 }, { at: 1 }],
    });
  });

  it('the panel shows M11 directions as Linear at 180° / 90°; shape switches keep it', () => {
    expect(gradientAngle(grad())).toBe(180);
    expect(gradientAngle(grad({ bgDir: 'horizontal' }))).toBe(90);
    expect(withShape(grad(), 'linear')).toEqual({});
    expect(withShape(grad(), 'radial')).toEqual({ bgDir: 'radial' });
    expect(withShape(grad({ bgDir: 'radial' }), 'linear')).toEqual({ bgDir: 'linear' });
    expect(withAngle(-90)).toEqual({ bgDir: 'linear', bgAngle: 270 });
  });

  it('stops: edit, add (in the widest gap), remove (two stay), at most eight', () => {
    let f = grad();
    expect(gradientStops(f, T)).toEqual([
      { color: '#101010', at: 0 },
      { color: '#f0f0f0', at: 1 },
    ]);
    f = { ...f, ...withStop(f, T, 1, { at: 0.6, color: '#ff0000' }) };
    expect(f.bgStops).toEqual([
      { color: '#101010', at: 0 },
      { color: '#ff0000', at: 0.6 },
    ]);
    f = { ...f, ...addStop(f, T) };
    expect(f.bgStops?.[2]).toMatchObject({ at: 0.3 });
    expect(removeStop(grad(), T, 0)).toEqual({});
    f = { ...f, ...removeStop(f, T, 0) };
    expect(f.bgStops).toHaveLength(2);
    for (let i = 0; i < 10; i++) f = { ...f, ...addStop(f, T) };
    expect(f.bgStops).toHaveLength(8);
  });

  it('stored values: new fields read back, bad ones dropped', () => {
    const f = grad({
      bgDir: 'linear',
      bgAngle: 30,
      bgCx: 0.1,
      bgCy: 0.9,
      bgR: 1.5,
      bgStops: [
        { color: '#000000', at: 0 },
        { color: '#ffffff', at: 0.5 },
        { color: '#ff0000', at: 1 },
      ],
    });
    expect(parseColours(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(parseColours({ bgAngle: 400, bgR: 9, bgStops: [{ color: '#000000', at: 0 }] })).toEqual(
      DEFAULT_COLOURS,
    );
  });
});

describe('background pictures in the piece', () => {
  const src = 'data:image/png;base64,AAAA';

  it('stored minimally: defaults dropped, patches merged, removal leaves no doc', () => {
    const d = setPicture(undefined, { src, w: 4, h: 2, fit: 'cover', x: 0.5, y: 0.5, dim: 0 });
    expect(d).toEqual({ picture: { src, w: 4, h: 2 } });
    const p = patchPicture(d, { fit: 'tile', x: 0, dim: 0.3 });
    expect(p?.picture).toEqual({ src, w: 4, h: 2, fit: 'tile', x: 0, dim: 0.3 });
    expect(patchPicture(undefined, { dim: 1 })).toBeUndefined();
    expect(setPicture(p, undefined)).toBeUndefined();
    expect(setPicture({ rows: 3, picture: { src, w: 4, h: 2 } }, undefined)).toEqual({ rows: 3 });
  });

  it('a picked picture is downscaled to fit the poster size cap', () => {
    expect(pictureScale(1920, 1080)).toBe(1);
    expect(pictureScale(16000, 1000)).toBe(POSTER_MAX_SIDE / 16000);
    const k = pictureScale(6000, 6000);
    expect(6000 * k * 6000 * k).toBeLessThanOrEqual(POSTER_MAX_AREA + 1);
    expect(6000 * k).toBeLessThanOrEqual(POSTER_MAX_SIDE);
  });
});
