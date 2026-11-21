/**
 * What `import fc from 'fast-check'` resolves to under Vitest (an alias in vite.config.ts): the
 * real fast-check, with `assert` wrapped so every property runs with a known seed under the hang
 * watchdog (prop-watchdog.ts). A run with no progress for PROP_HANG_MS (default 30 s) fails with
 * its seed and path instead of hanging silently.
 */
import * as real from '../../node_modules/fast-check/lib/fast-check.js';
import { expect } from 'vitest';
import { startWatchdog, type Watchdog } from './prop-watchdog';

export * from '../../node_modules/fast-check/lib/fast-check.js';

const fc = real.default;
const LIMIT_MS = Number(process.env.PROP_HANG_MS ?? 30_000);

// Started on import: properties read the global hooks when they are built, before fc.assert runs.
const dog: Watchdog = startWatchdog(LIMIT_MS);
fc.configureGlobal({
  ...fc.readConfigureGlobal(),
  beforeEach: dog.beforeEach,
  afterEach: dog.afterEach,
});

/** fc.assert with an explicit seed (a random one if the caller gave none) and the watchdog. */
export const assert: typeof fc.assert = ((
  prop: Parameters<typeof fc.assert>[0],
  params?: object,
) => {
  const p = (params ?? {}) as { seed?: number };
  // fast-check draws its own seed from the clock when none is given; draw it here so it is known.
  const seed = p.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const d = dog;
  d.begin(seed, expect.getState().currentTestName ?? '(outside a test)');
  let out: unknown;
  try {
    out = fc.assert(prop as never, { ...p, seed } as never);
  } catch (e) {
    d.end();
    throw e;
  }
  if (out instanceof Promise) return out.finally(() => d.end());
  d.end();
  return out;
}) as typeof fc.assert;

export default { ...fc, assert } as typeof fc;
