/**
 * No garbage collection in the render loop (PLAN.md §8.11): 60 s of audio from `process()`, after
 * a warm-up, in a child Node process with --trace-gc switched on for exactly that span, must not
 * print a single GC line (and a 'gc' PerformanceObserver must see none).
 *
 * The workload is 24 continuously gliding voices plus reverb and delay, using every ease except
 * the solver-based expo and bézier. Those two allocate a little per control tick, because V8 cannot
 * inline their solvers into the audio loop (docs/build-log.md, M2); the second test measures how
 * often that makes the young generation collect, and only reports it.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

function runHarness(mode: 'plain' | 'all'): { gcLines: string[]; summary: { ms: number; observedGc: number } } {
  const res = spawnSync(
    process.execPath,
    ['--import', './tests/dsp/node/register.mjs', 'tests/dsp/node/gc-harness.ts', mode],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  if (res.status !== 0) throw new Error(`harness failed: ${res.stderr}`);
  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  const summary = JSON.parse(lines[lines.length - 1]) as { ms: number; observedGc: number };
  const gcLines = lines.filter((l) => /Scavenge|Mark-Compact|Mark-sweep|Minor|MinorMS/.test(l));
  return { gcLines, summary };
}

describe('no GC in process()', () => {
  it('runs 60 s of 24 voices + FX with no scavenge', () => {
    const { gcLines, summary } = runHarness('plain');
    console.info(
      `no-GC run: 60 s of audio in ${summary.ms} ms, ${gcLines.length} GC lines, ${summary.observedGc} observed`,
    );
    expect(gcLines).toEqual([]);
    expect(summary.observedGc).toBe(0);
  }, 120_000);

  it('reports the GC rate when expo and bézier glides are included', () => {
    const { gcLines, summary } = runHarness('all');
    console.info(
      `with expo/bézier glides: ${gcLines.filter((l) => l.includes('Scavenge')).length} scavenges per 60 s ` +
        `(${summary.observedGc} observed)`,
    );
    expect(gcLines.every((l) => !/Mark-Compact|Mark-sweep/.test(l))).toBe(true); // never a major GC
  }, 120_000);
});
