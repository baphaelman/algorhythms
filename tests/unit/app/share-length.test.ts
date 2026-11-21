/**
 * M5 acceptance (PLAN.md §15): every example piece's share link is ≤ 2,000 characters, measured
 * as the full URL on the live site.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LONG_LINK_CHARS, decodeShareLink, encodeShareLink } from '../../../src/app/share';
import { parsePiece } from '../../../src/core/schema';

const SITE = 'https://baphaelman.github.io/algorhythms/';
const ROOT = join(import.meta.dirname, '../../..');

const read = (dir: string): [string, string][] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.algorhythms.json'))
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')]);

const pieces: [string, string][] = ['examples', 'examples/compositions'].flatMap((dir) =>
  read(join(ROOT, dir)).map(([f, t]): [string, string] => [`${dir}/${f}`, t]),
);

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
