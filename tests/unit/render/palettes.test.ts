import { describe, expect, it } from 'vitest';
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  isDarkColor,
  lineColor,
  pitchStops,
  readTokens,
  type PaletteInput,
} from '../../../src/render';

const base: PaletteInput = { tokens: LIGHT_TOKENS, dark: false, oklch: true, colors: 'pitch' };

describe('pitch palette', () => {
  it('runs from cool (low) to warm (high)', () => {
    const stops = pitchStops(false, true);
    expect(stops[0].at).toBe(0);
    expect(stops[stops.length - 1].at).toBe(1);
    const hue = (c: string) => Number(/ ([\d.]+)\)$/.exec(c)![1]);
    // blue-violet at the bottom, orange-red at the top
    expect(hue(stops[0].color)).toBeGreaterThan(200);
    expect(hue(stops[stops.length - 1].color)).toBeLessThan(60);
  });
});

describe('lineColor', () => {
  it('ink uses the theme ink', () => {
    expect(lineColor({ ...base, colors: 'ink', tokens: DARK_TOKENS }, 4)).toBe(DARK_TOKENS.ink);
  });
  it('pitch mode has no solid colour (a gradient is used)', () => {
    expect(lineColor({ ...base, colors: 'pitch' }, 0)).toBeNull();
  });
  it('custom uses VoiceDef.color and falls back to the ink', () => {
    const p: PaletteInput = { ...base, colors: 'custom', customColors: ['#ff0000', undefined] };
    expect(lineColor(p, 0)).toBe('#ff0000');
    expect(lineColor(p, 1)).toBe(LIGHT_TOKENS.ink);
    expect(lineColor(p, 7)).toBe(LIGHT_TOKENS.ink);
  });
});

describe('theme tokens', () => {
  it('light and dark sets differ in every token and match the prototype', () => {
    expect(LIGHT_TOKENS.paper).toBe('#EEF1F4');
    expect(DARK_TOKENS.paper).toBe('#0F1217');
    for (const k of Object.keys(LIGHT_TOKENS) as (keyof typeof LIGHT_TOKENS)[]) {
      expect(DARK_TOKENS[k]).not.toBe(LIGHT_TOKENS[k]);
    }
    expect(isDarkColor(DARK_TOKENS.paper)).toBe(true);
    expect(isDarkColor(LIGHT_TOKENS.paper)).toBe(false);
  });

  it('readTokens takes CSS values and falls back per token', () => {
    const t = readTokens((k) => (k === '--paper' ? ' #123456 ' : ''), 'dark');
    expect(t.paper).toBe('#123456');
    expect(t.ink).toBe(DARK_TOKENS.ink);
  });
});
