/**
 * Auto camera cost (PLAN.md §15 M11.5 C2): keys for every example and composition in < 50 ms
 * (the best of three, warm). A timing gate: `pnpm test:perf`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import { autoCameraPlan } from '../../../src/render/auto-camera';

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const files = [
  ...readdirSync(EXAMPLES).filter((f) => f.endsWith('.algorhythms.json')),
  ...readdirSync(join(EXAMPLES, 'compositions'))
    .filter((f) => f.endsWith('.algorhythms.json'))
    .map((f) => `compositions/${f}`),
];

it('makes keys for every example and composition in < 50 ms', () => {
  const slow: string[] = [];
  for (const f of files) {
    const r = parsePiece(readFileSync(join(EXAMPLES, f), 'utf8'));
    if (!r.ok) throw new Error(r.errors.join('; '));
    const c = compile(r.piece);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      autoCameraPlan(c);
      best = Math.min(best, performance.now() - t);
    }
    if (best >= 50) slow.push(`${f}: ${best.toFixed(1)} ms`);
  }
  expect(slow).toEqual([]);
});
