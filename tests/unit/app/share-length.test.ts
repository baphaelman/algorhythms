/**
 * M5 acceptance (PLAN.md §15): every example piece's share link is ≤ 2,000 characters, measured
 * as the full URL on the live site.
 *
 * fixtures/compositions-rev9/ holds the rewritten compositions (branch `compositions-rev9`, not
 * merged yet). The compositions now in examples/compositions/ predate that rewrite and are far
 * over (5.5k–20k characters); they are checked only once they match their rewrite.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LONG_LINK_CHARS, decodeShareLink, encodeShareLink } from '../../../src/app/share';
import { parsePiece } from '../../../src/core/schema';

const SITE = 'https://baphaelman.github.io/algorhythms/';
const ROOT = join(import.meta.dirname, '../../..');
const REV9 = join(import.meta.dirname, 'fixtures/compositions-rev9');

const read = (dir: string): [string, string][] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.algorhythms.json'))
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')]);

const rewrites = new Map(read(REV9));
const pieces: [string, string][] = [
  ...read(join(ROOT, 'examples')).map(([f, t]): [string, string] => [`examples/${f}`, t]),
  ...read(join(ROOT, 'examples/compositions'))
    .filter(([f, t]) => !rewrites.has(f) || rewrites.get(f) === t)
    .map(([f, t]): [string, string] => [`examples/compositions/${f}`, t]),
  ...[...rewrites].map(([f, t]): [string, string] => [`compositions-rev9/${f}`, t]),
];

describe('share link length (M5)', () => {
  for (const [name, text] of pieces) {
    it(`${name} fits in ${LONG_LINK_CHARS} characters and round-trips`, async () => {
      const r = parsePiece(text);
      if (!r.ok) throw new Error(r.errors.join('; '));
      const link = await encodeShareLink(r.piece, SITE);
      expect(link.length).toBeLessThanOrEqual(LONG_LINK_CHARS);
      const back = parsePiece(await decodeShareLink(link));
      expect(back.ok && back.piece).toEqual(r.piece);
    });
  }
});
