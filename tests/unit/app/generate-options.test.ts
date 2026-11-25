import { describe, expect, it } from 'vitest';
import {
  checkSeed,
  generateFromBrief,
  hashSeed,
  newSeed,
  parseSeed,
} from '../../../src/app/generate-options';
import { composeDirectedPiece, isComposedTitle } from '../../../src/core/compose-directed';
import { generate } from '../../../src/core/generate';

describe('parseSeed', () => {
  it('takes whole numbers modulo 2^32', () => {
    expect(parseSeed('7')).toBe(7);
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed('4294967303')).toBe(7);
    expect(parseSeed('-1')).toBe(0xffffffff);
    const big = parseSeed('123456789012345678901234567890')!;
    expect(big).toBeGreaterThanOrEqual(0);
    expect(big).toBeLessThan(2 ** 32);
  });
  it('hashes other text to a stable uint32', () => {
    const a = parseSeed('moonlight')!;
    expect(a).toBe(hashSeed('moonlight'));
    expect(a).toBe(parseSeed('moonlight'));
    expect(a).not.toBe(parseSeed('Moonlight'));
    expect(parseSeed('1.5')).toBe(hashSeed('1.5'));
    expect(Number.isInteger(a) && a >= 0 && a < 2 ** 32).toBe(true);
  });
  it('is null for blank text', () => {
    expect(parseSeed('')).toBeNull();
    expect(parseSeed('   ')).toBeNull();
  });
  it('newSeed is an integer in range', () => {
    expect(newSeed(() => 0)).toBe(0);
    expect(newSeed(() => 0.999999999)).toBeLessThan(2 ** 32);
    expect(Number.isInteger(newSeed())).toBe(true);
  });
});

describe('checkSeed: Generate = every answer on Surprise me (PLAN §15 M12)', () => {
  it('gives a brief with only the seed', () => {
    expect(checkSeed('1234')).toEqual({ ok: true, brief: { seed: 1234 } });
    expect(checkSeed('moonlight')).toEqual({ ok: true, brief: { seed: hashSeed('moonlight') } });
  });
  it('refuses a blank seed', () => {
    const c = checkSeed('  ');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toMatch(/Enter a seed/);
  });
});

describe('generateFromBrief', () => {
  it('is the directed composer with every answer on Surprise me', () => {
    const a = generateFromBrief({ seed: 4242 });
    expect(a).toEqual(composeDirectedPiece({ seed: 4242 }));
    expect(generateFromBrief({ seed: 4242 })).toEqual(a);
    expect(isComposedTitle(a.meta.title)).toBe(true);
    expect(a.meta.title).toMatch(/ 4242$/);
    expect(a.moments).not.toEqual(generate(4242).moments);
  });
  it('differs when the seed changes', () => {
    expect(generateFromBrief({ seed: 4243 }).moments).not.toEqual(
      generateFromBrief({ seed: 4242 }).moments,
    );
  });
  it('stamps now as created and modified, nothing else changes', () => {
    const now = '2026-01-02T03:04:05Z';
    const a = generateFromBrief({ seed: 7 }, now);
    expect(a.meta.created).toBe(now);
    expect(a.meta.modified).toBe(now);
    const { meta: _m, ...rest } = a;
    const { meta: _n, ...plain } = generateFromBrief({ seed: 7 });
    expect(rest).toEqual(plain);
  });
});
