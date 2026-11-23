import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SCHEMES,
  DEFAULT_COLOURS,
  backgroundOf,
  coloursFromOld,
  coloursLook,
  contrastWarning,
  deleteScheme,
  parseColours,
  parseHex,
  partColour,
  partsOf,
  pitchEnds,
  saveScheme,
  schemeOf,
  type ColoursForm,
} from '../../../src/app/export-colours';
import { contrastRatio, worstContrast } from '../../../src/render/colours';
import { DARK_TOKENS, LIGHT_TOKENS } from '../../../src/render/palettes';

const c = (p: Partial<ColoursForm>): ColoursForm => ({ ...DEFAULT_COLOURS, ...p });

describe('export colours', () => {
  it('defaults resolve to nothing (the export draws as before)', () => {
    expect(coloursLook(DEFAULT_COLOURS, { tokens: LIGHT_TOKENS, dark: false })).toBeUndefined();
    expect(schemeOf(DEFAULT_COLOURS)).toBe('theme');
  });

  it('resolves background, lines and swatches', () => {
    const ctx = { tokens: DARK_TOKENS, dark: true };
    expect(backgroundOf(c({ background: 'solid' }), DARK_TOKENS)).toEqual({
      kind: 'solid',
      color: DARK_TOKENS.paper,
    });
    expect(
      coloursLook(c({ background: 'gradient', bgFrom: '#000000', bgDir: 'radial' }), ctx),
    ).toEqual({
      background: { kind: 'gradient', from: '#000000', to: DARK_TOKENS.panel, dir: 'radial' },
    });
    // By pitch: theme hues until a stop is set; the other end then takes the theme's end.
    expect(coloursLook(c({ lines: 'pitch' }), ctx)!.lines).toEqual({ kind: 'pitch' });
    const [, hi] = pitchEnds(true);
    expect(coloursLook(c({ lines: 'pitch', low: '#112233' }), ctx)!.lines).toEqual({
      kind: 'pitch',
      stops: ['#112233', hi],
    });
    expect(
      coloursLook(c({ lines: 'pitch', low: '#000000', mid: '#ff0000', high: '#ffffff' }), ctx)!
        .lines,
    ).toEqual({ kind: 'pitch', stops: ['#000000', '#ff0000', '#ffffff'] });
    expect(coloursLook(c({ lines: 'one' }), ctx)!.lines).toEqual({
      kind: 'one',
      color: DARK_TOKENS.ink,
    });
    expect(coloursLook(c({ hud: '#abcdef', glow: '#010203' }), ctx)).toEqual({
      hud: '#abcdef',
      glow: '#010203',
    });
  });

  it('per part: one colour per part, by pool index; unset parts take the palette', () => {
    const parts = ['Melody', undefined, 'Melody', 'Bass'];
    expect(partsOf(parts)).toEqual(['Melody', '', 'Bass']);
    const look = coloursLook(c({ lines: 'part', parts: { Bass: '#00ff00' } }), {
      tokens: LIGHT_TOKENS,
      dark: false,
      parts,
    });
    const m = partColour(0, false);
    expect(look!.lines).toEqual({
      kind: 'part',
      colors: [m, partColour(1, false), m, '#00ff00'],
    });
    expect(new Set([0, 1, 2, 3, 4, 5, 6, 7].map((k) => partColour(k, true))).size).toBe(8);
  });

  it('schemes: built-ins are recognised, an edit shows Custom, saved ones round-trip', () => {
    for (const s of BUILTIN_SCHEMES) expect(schemeOf(s.colours)).toBe(s.id);
    const night = BUILTIN_SCHEMES.find((s) => s.id === 'night')!.colours;
    const edited = { ...night, hud: '#ffffff' };
    expect(schemeOf(edited)).toBe('custom');
    let saved = saveScheme([], '  Mine ', edited);
    expect(saved.map((s) => s.name)).toEqual(['Mine']);
    expect(schemeOf(edited, saved)).toBe('saved:Mine');
    saved = saveScheme(saved, 'Mine', night); // same name replaces
    expect(saved).toHaveLength(1);
    expect(saveScheme(saved, '   ', edited)).toHaveLength(1);
    expect(deleteScheme(saved, 'Mine')).toEqual([]);
    // Parts compare by content, not key order.
    expect(
      schemeOf(c({ parts: { a: '#000000', b: '#111111' } }), [
        { id: 'x', name: 'x', colours: c({ parts: { b: '#111111', a: '#000000' } }) },
      ]),
    ).toBe('saved:x');
  });

  it('every built-in scheme keeps HUD text and labels ≥ 4.5:1 on its background', () => {
    for (const s of BUILTIN_SCHEMES) {
      const bg = backgroundOf(s.colours, LIGHT_TOKENS);
      expect(worstContrast(s.colours.hud!, bg, '#fff'), s.id).toBeGreaterThanOrEqual(4.5);
      expect(worstContrast(s.colours.labels!, bg, '#fff'), s.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastWarning(s.colours, LIGHT_TOKENS, false)).toBeNull();
    }
  });

  it('contrast: WCAG ratio, gradients by their worst point, warning under 3:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('oklch(1 0 0)', '#000')).toBeCloseTo(21, 1);
    const grad = { kind: 'gradient', from: '#ffffff', to: '#000000', dir: 'vertical' } as const;
    expect(worstContrast('#ffffff', grad, '')).toBeCloseTo(1, 5);
    expect(contrastWarning(DEFAULT_COLOURS, LIGHT_TOKENS, false)).toBeNull();
    expect(contrastWarning(DEFAULT_COLOURS, DARK_TOKENS, false)).toBeNull();
    // Light theme text on a black background: the HUD's secondary ink fails.
    const black = c({ background: 'solid', bg: '#000000' });
    expect(contrastWarning(black, LIGHT_TOKENS, false)).toMatch(/^Low contrast .*HUD text/);
    expect(contrastWarning(black, LIGHT_TOKENS, true)).toBeNull(); // transparent poster
    expect(
      contrastWarning(c({ ...black, hud: '#ffffff', labels: '#cccccc' }), LIGHT_TOKENS, false),
    ).toBeNull();
    expect(
      contrastWarning(
        c({
          background: 'gradient',
          bgFrom: '#ffffff',
          bgTo: '#000000',
          hud: '#ffffff',
          labels: '#ffffff',
        }),
        LIGHT_TOKENS,
        false,
      ),
    ).toMatch(/Low contrast/);
  });

  it('hex fields: short and bare forms, junk refused', () => {
    expect(parseHex('#3A6')).toBe('#33aa66');
    expect(parseHex('3a66cc')).toBe('#3a66cc');
    expect(parseHex(' #ABCDEF ')).toBe('#abcdef');
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('red')).toBeNull();
  });

  it('stored values: bad fields fall back; old line colours migrate', () => {
    expect(parseColours(null)).toEqual(DEFAULT_COLOURS);
    expect(
      parseColours({
        lines: 'nope',
        background: 'transparent',
        bgDir: 'radial',
        parts: { a: 1, b: '#0000FF' },
      }),
    ).toEqual({ ...DEFAULT_COLOURS, bgDir: 'radial', parts: { b: '#0000ff' } });
    expect(coloursFromOld('app', null)).toEqual(DEFAULT_COLOURS);
    expect(coloursFromOld('pitch', '#123456')).toEqual(c({ lines: 'pitch' }));
    expect(coloursFromOld('ink', '#123456')).toEqual(c({ lines: 'one', one: '#123456' }));
  });
});
