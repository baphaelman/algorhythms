/**
 * M5 acceptance (PLAN.md §15): every example piece's share link is ≤ 2,000 characters, measured
 * as the full URL on the live site. Exempt: compositions the owner chose to ship whole although
 * their links are longer (Share offers a file instead).
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

/**
 * Owner, 2026-11-22: Sunday Lane ships whole (about 2,530 characters). 2026-11-23: Night Sleeper,
 * added at the owner's request with its six custom timbres (about 3,380). Crease, same day, the
 * same way.
 */
const LONG_OK = new Set([
  'examples/compositions/sunday-lane.algorhythms.json',
  'examples/compositions/night-sleeper.algorhythms.json',
  'examples/compositions/crease.algorhythms.json',
]);

const pieces: [string, string][] = ['examples', 'examples/compositions'].flatMap((dir) =>
  read(join(ROOT, dir)).map(([f, t]): [string, string] => [`${dir}/${f}`, t]),
);

describe('share link length (M5)', () => {
  for (const [name, text] of pieces) {
    it(`${name} ${LONG_OK.has(name) ? 'is exempt from the limit' : `fits in ${LONG_LINK_CHARS} characters`} and round-trips`, async () => {
      const r = parsePiece(text);
      if (!r.ok) throw new Error(r.errors.join('; '));
      const link = await encodeShareLink(r.piece, SITE);
      if (!LONG_OK.has(name)) expect(link.length).toBeLessThanOrEqual(LONG_LINK_CHARS);
      const back = parsePiece(await decodeShareLink(link));
      expect(back.ok && back.piece).toEqual(r.piece);
    });
  }
});
