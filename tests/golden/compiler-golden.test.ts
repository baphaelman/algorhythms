/**
 * Golden tests (PLAN.md §14): every example piece's compiled output is pinned by a hash of its
 * canonical serialisation, with a readable summary. The cross-engine e2e test
 * (tests/e2e/golden-cross-engine.spec.ts) checks Chromium, Firefox and WebKit against the same
 * hashes. After an intended compiler change, regenerate with UPDATE_GOLDEN=1 and review the diff.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { summarize, type ScoreSummary } from './canonical';
import { goldenHash } from './golden-entry';

const EXAMPLES = join(import.meta.dirname, '../../examples');
const GOLDEN = join(import.meta.dirname, 'examples.golden.json');

const files = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.algorhythms.json'))
  .sort();

function load(file: string) {
  const parsed = parsePiece(JSON.parse(readFileSync(join(EXAMPLES, file), 'utf8')));
  if (!parsed.ok) throw new Error(`${file}: ${parsed.errors.join('; ')}`);
  return parsed;
}

describe('example pieces (golden)', () => {
  it('there are 4–6 examples, all CC0', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeLessThanOrEqual(6);
    for (const f of files) {
      const meta = load(f).piece.meta as { license?: string };
      expect(meta.license).toBe('CC0-1.0');
    }
  });

  it('every example parses without warnings and compiles with no error diagnostics', () => {
    const types = new Set<string>();
    for (const f of files) {
      const parsed = load(f);
      expect(parsed.warnings).toEqual([]);
      const score = compile(parsed.piece);
      expect(
        score.diagnostics.filter((d) => d.level === 'error'),
        f,
      ).toEqual([]);
      for (const m of parsed.piece.moments) types.add(m.type);
    }
    // Together the examples show every v1 moment type.
    expect([...types].sort()).toEqual([
      'chord',
      'key',
      'level',
      'merge',
      'pin',
      'shift',
      'split',
      'spread',
      'unison',
      'walk',
    ]);
  });

  it('compiled output matches the golden summaries', () => {
    const actual: Record<string, ScoreSummary> = {};
    for (const f of files) {
      const parsed = load(f);
      actual[f] = summarize(compile(parsed.piece));
      expect(goldenHash(JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')))).toBe(actual[f].hash);
    }
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, ScoreSummary>;
    expect(actual).toEqual(golden);
  });
});
