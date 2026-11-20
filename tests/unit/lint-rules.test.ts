/**
 * Proves the architecture lint rules fire (PLAN.md §7.11, §14): import boundaries per layer,
 * the portable-math ban in core/, and the clock/random ban in core/ and dsp/.
 * Code is linted in memory under virtual file paths, using the repository's real config.
 */

import { ESLint } from 'eslint';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RULES = new Set([
  'algorhythms/import-boundaries',
  'no-restricted-properties',
  'no-restricted-globals',
  'no-restricted-syntax',
]);

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

/** Lints `code` as if it lived at `file` and returns the architecture-rule ids that fired. */
async function fired(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return result.messages.filter((m) => m.ruleId && RULES.has(m.ruleId)).map((m) => m.ruleId!);
}

const BOUNDARY = 'algorhythms/import-boundaries';

describe('import boundaries (§14)', () => {
  const cases: [file: string, code: string, ok: boolean][] = [
    // core imports nothing internal
    ['src/core/x.ts', "export { a } from './types';", true],
    ['src/core/x.ts', "import { a } from '../dsp/a'; export { a };", false],
    ['src/core/x.ts', "import type { A } from '../render/a'; export type { A };", false],
    ['src/core/x.ts', "import { a } from '../app/a'; export { a };", false],
    ['src/core/x.ts', "import { z } from 'zod'; export { z };", true],
    ['src/core/x.ts', "import p from '../../package.json'; export { p };", false],
    // dsp: types only from core, values only from the two leaves
    [
      'src/dsp/x.ts',
      "import type { Segment } from '../core/types'; export type { Segment };",
      true,
    ],
    [
      'src/dsp/x.ts',
      "import { PIECE_VERSION } from '../core/types'; export { PIECE_VERSION };",
      false,
    ],
    [
      'src/dsp/x.ts',
      "import { type Segment } from '../core/types'; export type { Segment };",
      false,
    ],
    ['src/dsp/x.ts', "import { ease } from '../core/ease'; export { ease };", true],
    [
      'src/dsp/x.ts',
      "import { evalFlatSegment } from '../core/segment'; export { evalFlatSegment };",
      true,
    ],
    ['src/dsp/x.ts', "import { flatten } from '../core/flat'; export { flatten };", false],
    [
      'src/dsp/x.ts',
      "import type { FlatScore } from '../core/flat'; export type { FlatScore };",
      true,
    ],
    ['src/dsp/fx/x.ts', "import { ease } from '../../core/ease'; export { ease };", true],
    ['src/dsp/x.ts', "import { a } from '../audio/a'; export { a };", false],
    ['src/dsp/x.ts', "export { a } from '../render/a';", false],
    // render and midi import core only
    ['src/render/x.ts', "import { flatten } from '../core/flat'; export { flatten };", true],
    ['src/render/x.ts', "import { a } from '../dsp/a'; export { a };", false],
    ['src/render/x.ts', "import { a } from '../audio/a'; export { a };", false],
    [
      'src/midi/x.ts',
      "import { evalSegment } from '../core/segment'; export { evalSegment };",
      true,
    ],
    ['src/midi/x.ts', "import { a } from '../render/a'; export { a };", false],
    ['src/midi/x.ts', "const m = import('../app/a'); export { m };", false],
    // audio imports core and dsp
    ['src/audio/x.ts', "import { flatten } from '../core/flat'; export { flatten };", true],
    ['src/audio/worklet/x.worklet.ts', "import { a } from '../../dsp/a'; export { a };", true],
    ['src/audio/x.ts', "import { a } from '../render/a'; export { a };", false],
    ['src/audio/x.ts', "import { a } from '../app/a'; export { a };", false],
    // app imports anything
    [
      'src/app/x.ts',
      "import { a } from '../audio/a'; import { b } from '../render/b'; export { a, b };",
      true,
    ],
    // core/ease and core/segment are leaves
    ['src/core/ease.ts', "import type { EaseRef } from './types'; export type { EaseRef };", true],
    [
      'src/core/ease.ts',
      "import { PIECE_VERSION } from './types'; export { PIECE_VERSION };",
      false,
    ],
    ['src/core/segment.ts', "import { ease } from './ease'; export { ease };", true],
    ['src/core/segment.ts', "import { flatten } from './flat'; export { flatten };", false],
  ];

  it.each(cases)('%s: %s → allowed=%s', async (file, code, ok) => {
    const ids = await fired(file, code);
    if (ok) expect(ids).toEqual([]);
    else expect(ids).toContain(BOUNDARY);
  });
});

describe('portable math in core (§7.11)', () => {
  const banned = [
    'export const y = Math.sin(1);',
    'export const y = Math.cos(1);',
    'export const y = Math.tan(1);',
    'export const y = Math.pow(2, 0.5);',
    'export const y = Math.exp(1);',
    'export const y = Math.log(2);',
    'export const y = Math.log2(2);',
    'export const y = Math.log10(2);',
    'export const y = Math.random();',
    'export const y = Math.atan2(1, 2);',
    "export const y = Math['sin'](1);",
    'const { sin } = Math; export const y = sin(1);',
    'export const y = 2 ** 0.5;',
    'export const f = (x: number, k: number) => x ** k;',
    'let x = 2; x **= 3; export { x };',
    'export const y = Date.now();',
    'export const y = new Date();',
    'export const y = performance.now();',
  ];
  it.each(banned)('core rejects: %s', async (code) => {
    expect(await fired('src/core/x.ts', code)).not.toEqual([]);
  });

  const allowed = [
    'export const y = Math.sqrt(2) + Math.floor(1.5) + Math.round(1.5) + Math.abs(-1);',
    'export const y = Math.min(1, 2) + Math.max(1, 2) + Math.imul(3, 5);',
    'export const y = 3 ** 2;',
    'export const y = Math.PI * Math.LN2;',
  ];
  it.each(allowed)('core allows: %s', async (code) => {
    expect(await fired('src/core/x.ts', code)).toEqual([]);
  });

  it('render may use native Math', async () => {
    expect(await fired('src/render/x.ts', 'export const y = Math.sin(1);')).toEqual([]);
  });
});

describe('no randomness or clock in dsp (§8.10)', () => {
  it.each([
    'export const y = Math.random();',
    'export const y = Date.now();',
    'export const y = new Date();',
    'export const y = performance.now();',
  ])('dsp rejects: %s', async (code) => {
    expect(await fired('src/dsp/x.ts', code)).not.toEqual([]);
  });

  it('dsp may use native transcendental Math (audio is exempt from §7.11)', async () => {
    expect(await fired('src/dsp/x.ts', 'export const y = Math.sin(1) * Math.pow(2, 0.5);')).toEqual(
      [],
    );
  });
});
