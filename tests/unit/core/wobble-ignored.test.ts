/** Revision 8 (PLAN.md §11.3): a timbre's `wobble` is read and ignored, with one info. */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import type { Piece } from '../../../src/core/types';
import { piece } from './compiler-fixtures';

const withTimbres = (timbres: Piece['timbres']): Piece => ({
  ...piece({ start: [57, 60, 64] }),
  timbres,
});
const wobbleInfos = (p: Piece) => compile(p).diagnostics.filter((d) => d.code === 'wobble-ignored');

describe('wobble-ignored', () => {
  it('a piece timbre with wobble 2 gives one info naming it', () => {
    const d = wobbleInfos(withTimbres({ hum: { ...BUILTIN_TIMBRES.sine, wobble: 2 } }));
    expect(d).toHaveLength(1);
    expect(d[0].level).toBe('info');
    expect(d[0].message).toContain('hum');
  });

  it('several wobbling timbres still give one info', () => {
    const d = wobbleInfos(
      withTimbres({
        a: { ...BUILTIN_TIMBRES.sine, wobble: 2 },
        b: { ...BUILTIN_TIMBRES.sine, wobble: 5 },
      }),
    );
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('a, b');
  });

  it('wobble 0 or absent gives none', () => {
    expect(wobbleInfos(withTimbres({ a: { ...BUILTIN_TIMBRES.sine, wobble: 0 } }))).toEqual([]);
    expect(wobbleInfos(withTimbres({ a: { ...BUILTIN_TIMBRES.sine } }))).toEqual([]);
    expect(wobbleInfos(withTimbres({}))).toEqual([]);
  });

  it('the wobble does not change the compiled lines', () => {
    const plain = compile(withTimbres({ a: { ...BUILTIN_TIMBRES.sine } }));
    const wob = compile(withTimbres({ a: { ...BUILTIN_TIMBRES.sine, wobble: 4 } }));
    expect(wob.voices.map((v) => v.segments)).toEqual(plain.voices.map((v) => v.segments));
  });
});
