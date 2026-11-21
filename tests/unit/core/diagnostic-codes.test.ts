/** Every diagnostic code that core can emit is registered in DIAGNOSTIC_CODES, at its level. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CODES } from '../../../src/core/compiler/diagnostics';

const CORE = join(import.meta.dirname, '../../../src/core');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('DIAGNOSTIC_CODES', () => {
  it('registers every emitted code with its level', () => {
    const found = new Map<string, Set<string>>();
    const add = (code: string, level: string): void => {
      if (!found.has(code)) found.set(code, new Set());
      if (level) found.get(code)!.add(level);
    };
    for (const f of files(CORE)) {
      if (f.endsWith('schema.ts')) continue; // Zod issue codes, not diagnostics
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/'(info|warn|error)',\s*'([a-z0-9-]+)'/g)) add(m[2], m[1]);
      for (const m of src.matchAll(/code:\s*'([a-z0-9-]+)'/g)) add(m[1], '');
    }
    expect(found.size).toBeGreaterThan(20);
    // A code may be emitted at more than one level (`unknown-voice`); the registered one is used.
    for (const [code, levels] of found) {
      expect(DIAGNOSTIC_CODES[code], code).toBeDefined();
      if (levels.size > 0) expect([...levels], code).toContain(DIAGNOSTIC_CODES[code].level);
    }
  });
});
