import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORM,
  LENGTH_MAX,
  LENGTH_MIN,
  checkForm,
  formatLength,
  generateFromRequest,
  hashSeed,
  newSeed,
  parseSeed,
  type GenerateForm,
} from '../../../src/app/generate-options';
import { generate } from '../../../src/core/generate';

const form = (over: Partial<GenerateForm> = {}): GenerateForm => ({
  ...DEFAULT_FORM,
  seed: '1234',
  ...over,
});

function request(f: GenerateForm, now?: string) {
  const c = checkForm(f, now);
  if (!c.ok) throw new Error(JSON.stringify(c.errors));
  return c.request;
}

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

describe('checkForm: the mapping to generate()', () => {
  it('maps the defaults to core defaults (no length)', () => {
    const r = request(form());
    expect(r.seed).toBe(1234);
    expect(r.options).toEqual({ mode: 'dorian', voices: 12, density: 0.45 });
    expect('length' in r.options).toBe(false);
  });
  it('passes mode, voices, density, length and now through', () => {
    const r = request(
      form({ mode: 'lydian', voices: 5, density: 0.8, naturalLength: false, length: 300 }),
      '2026-01-02T03:04:05Z',
    );
    expect(r.options).toEqual({
      mode: 'lydian',
      voices: 5,
      density: 0.8,
      length: 300,
      now: '2026-01-02T03:04:05Z',
    });
  });
  it('ignores a stale length while the natural length is on', () => {
    expect(request(form({ naturalLength: true, length: 9999 })).options.length).toBeUndefined();
  });
  it('rejects bad fields with a message each', () => {
    const c = checkForm(
      form({ seed: '', voices: 1, density: 1.5, naturalLength: false, length: LENGTH_MIN - 1 }),
    );
    expect(c.ok).toBe(false);
    if (!c.ok)
      expect(Object.keys(c.errors).sort()).toEqual(['density', 'length', 'seed', 'voices']);
    expect(checkForm(form({ voices: 33 })).ok).toBe(false);
    expect(checkForm(form({ voices: 2.5 })).ok).toBe(false);
    expect(checkForm(form({ density: Number.NaN })).ok).toBe(false);
    expect(checkForm(form({ naturalLength: false, length: LENGTH_MAX + 1 })).ok).toBe(false);
    expect(checkForm(form({ voices: 2, density: 0 })).ok).toBe(true);
    expect(checkForm(form({ voices: 32, density: 1 })).ok).toBe(true);
  });
});

describe('generateFromRequest', () => {
  it('is generate(): the same seed and options give the same piece', () => {
    const f = form({ seed: 'hello', mode: 'aeolian', voices: 6, density: 0.3 });
    const a = generateFromRequest(request(f));
    const b = generateFromRequest(request({ ...f }));
    expect(b).toEqual(a);
    expect(a).toEqual(generate(hashSeed('hello'), { mode: 'aeolian', voices: 6, density: 0.3 }));
    expect(a.voices).toHaveLength(6);
  });
  it('differs when the seed or an option changes', () => {
    const a = generateFromRequest(request(form()));
    expect(generateFromRequest(request(form({ seed: '1235' }))).moments).not.toEqual(a.moments);
    expect(generateFromRequest(request(form({ mode: 'pentatonic' }))).key.scale).toBe(
      'pentatonic-major',
    );
    expect(generateFromRequest(request(form({ voices: 8 }))).voices).toHaveLength(8);
  });
  it('a longer chosen length gives a longer piece', () => {
    const end = (f: GenerateForm) => generateFromRequest(request(f)).end?.at ?? 0;
    expect(end(form({ naturalLength: false, length: 600 }))).toBeGreaterThan(
      end(form({ naturalLength: false, length: 200 })),
    );
  });
});

describe('formatLength', () => {
  it('formats m:ss', () => {
    expect(formatLength(150)).toBe('2:30');
    expect(formatLength(600)).toBe('10:00');
    expect(formatLength(100)).toBe('1:40');
  });
});
