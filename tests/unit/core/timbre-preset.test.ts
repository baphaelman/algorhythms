import { describe, expect, it } from 'vitest';
import {
  parseTimbrePreset,
  serializeTimbrePreset,
  TIMBRE_PRESET_FORMAT,
  timbrePresetFileName,
} from '../../../src/core/timbre-preset';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import type { Timbre } from '../../../src/core/types';

const file = (timbre: unknown, extra: object = {}) => ({
  format: TIMBRE_PRESET_FORMAT,
  version: 1,
  name: 'x',
  timbre,
  ...extra,
});
const errors = (input: unknown): string[] => {
  const r = parseTimbrePreset(input);
  return r.ok ? [] : r.errors;
};

describe('timbre preset files', () => {
  it('round-trip every built-in exactly, text and all', () => {
    for (const [name, t] of Object.entries(BUILTIN_TIMBRES)) {
      const text = serializeTimbrePreset(name, t);
      const r = parseTimbrePreset(text);
      expect(r.ok, name).toBe(true);
      if (!r.ok) continue;
      expect(r.name).toBe(name);
      expect(r.timbre).toStrictEqual(t);
      expect(serializeTimbrePreset(r.name, r.timbre)).toBe(text);
    }
  });

  it('need the format marker; a piece file is told apart', () => {
    expect(errors({ ...file(BUILTIN_TIMBRES.sine), format: undefined })[0]).toMatch(/format/);
    expect(errors({ ...file(BUILTIN_TIMBRES.sine), format: 'algorhythms' })[0]).toMatch(/piece/);
    expect(errors('not json')[0]).toMatch(/Not JSON/);
    expect(errors([1, 2])[0]).toMatch(/object/);
    expect(errors({ ...file(BUILTIN_TIMBRES.sine), name: '  ' }).length).toBeGreaterThan(0);
    expect(errors({ ...file(BUILTIN_TIMBRES.sine), version: 0 }).length).toBeGreaterThan(0);
  });

  it('warn about a newer version but load it, keeping unknown fields', () => {
    const r = parseTimbrePreset(
      file({ ...BUILTIN_TIMBRES.sine, sparkle: 3 }, { version: 7, made: 'later' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings[0]).toMatch(/newer/);
    expect((r.timbre as Timbre & { sparkle: number }).sparkle).toBe(3);
  });

  it('fill defaults for omitted timbre fields', () => {
    const r = parseTimbrePreset(file({ harmonics: [1, 0.5] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timbre).toStrictEqual({
      harmonics: [1, 0.5],
      stretch: 0,
      brightness: { tilt: 0, track: 0 },
      detuneSpread: 0,
      accent: 0,
      articulation: { amount: 0, attack: 0.01, decay: 0.2 },
      vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
    });
  });

  it('enforce the schema bounds', () => {
    const t = BUILTIN_TIMBRES.sine;
    const bad: [string, unknown][] = [
      ['33 partials', { ...t, harmonics: Array(33).fill(0.1) }],
      ['stretch > 1', { ...t, stretch: 1.01 }],
      ['stretch < −0.5', { ...t, stretch: -0.51 }],
      ['fm ratio 0', { ...t, fm: { ratio: 0, index: 1, indexTrack: 0 } }],
      ['fm ratio > 32', { ...t, fm: { ratio: 33, index: 1, indexTrack: 0 } }],
      ['fm index > 20', { ...t, fm: { ratio: 1, index: 20.5, indexTrack: 0 } }],
      ['fm track > 4', { ...t, fm: { ratio: 1, index: 1, indexTrack: 5 } }],
      ['noise level > 4', { ...t, noise: { level: 4.1, bandwidth: 1 } }],
      ['noise band 0', { ...t, noise: { level: 1, bandwidth: 0 } }],
      ['noise band > 8', { ...t, noise: { level: 1, bandwidth: 9 } }],
      ['negative detune', { ...t, detuneSpread: -1 }],
      ['negative attack', { ...t, articulation: { ...t.articulation, attack: -0.1 } }],
      ['jitter > 1', { ...t, vibrato: { ...t.vibrato, jitter: 1.5 } }],
      ['non-finite partial', { ...t, harmonics: [1, 'a'] }],
    ];
    for (const [what, timbre] of bad) expect(errors(file(timbre)).length, what).toBeGreaterThan(0);
    const edge: Timbre = {
      ...t,
      harmonics: Array(32).fill(1),
      stretch: 1,
      fm: { ratio: 32, index: 20, indexTrack: -4 },
      noise: { level: 4, bandwidth: 8 },
      vibrato: { ...t.vibrato, jitter: 1 },
    };
    expect(errors(file(edge))).toEqual([]);
  });

  it('name files safely', () => {
    expect(timbrePresetFileName('Bell 2')).toBe('Bell 2.algorhythms-timbre.json');
    expect(timbrePresetFileName('a/b:c')).toBe('a-b-c.algorhythms-timbre.json');
    expect(timbrePresetFileName('  ')).toBe('timbre.algorhythms-timbre.json');
  });
});
