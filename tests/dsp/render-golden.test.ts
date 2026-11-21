/**
 * Render goldens (M6-a): every fixture and example piece renders bit-identically to the pinned
 * hashes, so new timbre paths (FM, noise, additive) cannot change existing sounds. Regenerate
 * with UPDATE_RENDER_GOLDEN=1 only for an intended change to existing sounds, and say why in the
 * build log.
 *
 * The renders must also be identical on every platform, so they may not touch Math's
 * transcendental functions, whose last bits differ between V8 builds (arm64 fuses multiply-adds;
 * docs/build-log.md, "Portable DSP math"): they throw while the goldens render.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_MIX, FIXTURE_NAMES, fixtureScore } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { BLOCK_FRAMES } from '../../src/dsp/constants';

vi.setConfig({ testTimeout: 120_000 });

const RATE = 48000;
const GOLDEN = join(import.meta.dirname, 'render-golden.json');
const EXAMPLES = join(import.meta.dirname, '../../examples');

function digest(out: { left: Float32Array; right: Float32Array }): string {
  const h = createHash('sha256');
  h.update(new Uint8Array(out.left.buffer));
  h.update(new Uint8Array(out.right.buffer));
  return h.digest('hex').slice(0, 32);
}

const frames = (s: number) => Math.ceil((s * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;

function pieceFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['', 'compositions']) {
    for (const f of readdirSync(join(EXAMPLES, dir)).sort())
      if (f.endsWith('.algorhythms.json')) out.push(join(dir, f));
  }
  return out;
}

function renderAll(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of FIXTURE_NAMES) {
    hashes[`fixture:${name}`] = digest(
      renderOffline({ score: fixtureScore(name), mix: FIXTURE_MIX, sampleRate: RATE }, frames(6)),
    );
  }
  for (const file of pieceFiles()) {
    const parsed = parsePiece(JSON.parse(readFileSync(join(EXAMPLES, file), 'utf8')));
    if (!parsed.ok) throw new Error(`${file}: ${parsed.errors.join('; ')}`);
    const piece = parsed.piece;
    const out = renderOffline(
      { score: compile(piece), mix: piece.mix, timbres: piece.timbres, sampleRate: RATE },
      frames(20),
    );
    hashes[`piece:${file}`] = digest(out);
  }
  return hashes;
}

/** Math members whose results are not guaranteed to be correctly rounded. */
const NON_PORTABLE = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'pow',
  'exp',
  'expm1',
  'log',
  'log2',
  'log10',
  'log1p',
  'cbrt',
  'hypot',
] as const;

/** Runs `fn` with the non-portable Math members replaced by throwing stubs. */
function withoutNativeMath<T>(fn: () => T): T {
  const M = Math as unknown as Record<string, unknown>;
  const saved = NON_PORTABLE.map((k) => M[k]);
  for (const k of NON_PORTABLE)
    M[k] = () => {
      throw new Error(`Math.${k} called while rendering: use dsp/pmath.ts`);
    };
  try {
    return fn();
  } finally {
    NON_PORTABLE.forEach((k, i) => (M[k] = saved[i]));
  }
}

describe('render goldens', () => {
  it('fixtures and example pieces render bit-identically', () => {
    const hashes = withoutNativeMath(renderAll);
    if (process.env.UPDATE_RENDER_GOLDEN || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(hashes, null, 2) + '\n');
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    expect(hashes).toEqual(golden);
  });
});
