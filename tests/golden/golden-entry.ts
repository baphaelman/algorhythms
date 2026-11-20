/**
 * Entry for the browser bundle of the cross-engine golden test (tests/e2e/golden-cross-engine):
 * the core compiler, the schema and the canonical hash, exposed on globalThis.
 */
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { canonicalJson, hashString } from './canonical';

/** Parses and compiles a piece file; returns the hash of the canonical compiled score. */
function goldenHash(json: unknown): string {
  const parsed = parsePiece(json);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return hashString(canonicalJson(compile(parsed.piece)));
}

(globalThis as unknown as { __algorhythmsGolden: unknown }).__algorhythmsGolden = { goldenHash };

export { goldenHash };
