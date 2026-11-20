import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import type { CompiledScore } from '../../../src/core/types';
import { drawScore, type Ctx2D, type ScoreStyle } from '../../../src/render';
import { piece } from '../core/compiler-fixtures';

interface Text {
  text: string;
  x: number;
  align: unknown;
  fill: unknown;
}

/** Records fillText calls (text, x, alignment, colour); every other method is a no-op. */
function fakeCtx(): { ctx: Ctx2D; texts: Text[]; measures: () => number } {
  const texts: Text[] = [];
  let measured = 0;
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', textAlign: 'left' };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText')
        return (s: string) => {
          measured++;
          return { width: s.length * 7 };
        };
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'fillText')
        return (text: string, x: number) =>
          texts.push({ text, x, align: target.textAlign, fill: target.fillStyle });
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, texts, measures: () => measured };
}

const TOKENS = {
  paper: '#000001',
  ink: '#000002',
  ink2: '#000003',
  rule: '#000004',
  accent: '#000005',
  panel: '#000006',
};
const style = (hud = true): ScoreStyle =>
  ({
    tokens: TOKENS,
    dark: false,
    colors: 'ink',
    oklch: true,
    futureOpacity: 0,
    hud,
  }) as ScoreStyle;
const cam = { window: 20, overview: 0 };

const score: CompiledScore = compile(
  piece({
    start: [48, 55, 64, 72],
    key: { tonic: 'C', scale: 'major' },
    moments: [
      {
        type: 'chord',
        at: 4,
        notes: { kind: 'chord', symbol: 'ii7' },
        voicing: 'even',
        assign: 'ordered',
      },
      {
        type: 'chord',
        at: 10,
        notes: { kind: 'pitches', pitches: [45, 53, 60, 65] },
        voicing: 'even',
        assign: 'ordered',
      },
    ],
  }),
);

function draw(t: number, width = 1000, hud = true) {
  const f = fakeCtx();
  drawScore(f.ctx, score, cam, style(hud), t, { width, height: 600 }, 1);
  return f;
}

describe('HUD chord', () => {
  it('shows nothing before the first chord moment', () => {
    const { texts } = draw(2);
    expect(texts.some((x) => /ii7|Dm7/.test(x.text))).toBe(false);
    expect(texts.some((x) => /^c major · (following|whole piece)$/.test(x.text))).toBe(true);
  });

  it('shows the current chord top right in ink, above the key line', () => {
    const { texts } = draw(6);
    const chord = texts.find((x) => x.text === 'ii7 · Dm7');
    expect(chord).toMatchObject({ align: 'right', x: 1000 - 25, fill: TOKENS.ink });
    expect(texts.some((x) => /^c major · (following|whole piece)$/.test(x.text))).toBe(true);
    expect(draw(12).texts.some((x) => x.text === 'F/A')).toBe(true);
  });

  it('is omitted with the HUD', () => {
    expect(draw(6, 1000, false).texts.some((x) => x.text === 'ii7 · Dm7')).toBe(false);
  });

  it('measures each label once, not every frame', () => {
    const a = draw(6).measures();
    const b = draw(6.1).measures();
    expect(a + b).toBeLessThanOrEqual(1);
  });

  it('drops the formula when a phone-width screen cannot fit both', () => {
    const wide = draw(6).texts;
    const phone = draw(6, 220).texts;
    expect(wide.some((x) => x.text.startsWith('f(n)'))).toBe(true);
    expect(phone.some((x) => x.text.startsWith('f(n)'))).toBe(false);
    expect(phone.some((x) => x.text === 'ii7 · Dm7')).toBe(true);
  });
});
