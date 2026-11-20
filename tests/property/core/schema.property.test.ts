/** Property tests for core/schema.ts: unknown fields survive load and save (PLAN.md §5, §14). */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import { fullPiece } from '../../unit/core/schema-fixtures';

/** Every plain object in `value` that may take extra keys (all but the `timbres` record). */
function objectNodes(value: unknown, parentKey = '', out: Record<string, unknown>[] = []) {
  if (Array.isArray(value)) {
    for (const v of value) objectNodes(v, parentKey, out);
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (parentKey !== 'timbres') out.push(obj);
    for (const [k, v] of Object.entries(obj)) objectNodes(v, k, out);
  }
  return out;
}

const NODE_COUNT = objectNodes(fullPiece()).length;
const extraKey = fc.string({ minLength: 1, maxLength: 8 }).map((s) => `x-${s}`);
const injection = fc.record({
  node: fc.nat({ max: NODE_COUNT - 1 }),
  key: extraKey,
  value: fc.jsonValue({ maxDepth: 3 }),
});

describe('schema round trip', () => {
  it('keeps arbitrary unknown fields anywhere through parse → serialize → parse', () => {
    fc.assert(
      fc.property(fc.array(injection, { minLength: 1, maxLength: 12 }), (injections) => {
        const input = fullPiece();
        const nodes = objectNodes(input);
        for (const { node, key, value } of injections) nodes[node][key] = value;
        // JSON drops what it can't represent (e.g. −0 becomes 0), so compare against JSON data.
        const expected = JSON.parse(JSON.stringify(input)) as unknown;

        const first = parsePiece(input);
        if (!first.ok) throw new Error(first.errors.join('\n'));
        expect(first.piece).toEqual(expected);

        const text = serializePiece(first.piece);
        const second = parsePiece(text);
        if (!second.ok) throw new Error(second.errors.join('\n'));
        expect(second.piece).toEqual(first.piece);
        expect(serializePiece(second.piece)).toBe(text);
      }),
      { numRuns: 150 },
    );
  });
});
