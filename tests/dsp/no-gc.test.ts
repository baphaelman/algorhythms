/**
 * No garbage collection in the render loop (PLAN.md §8.11): 60 s of audio from `process()`, after
 * a warm-up, in a child Node process with --trace-gc switched on for exactly that span, must not
 * print a single GC line (and a 'gc' PerformanceObserver must see none). The young generation may
 * also grow by at most MAX_BYTES over the run: allocation too small to set off a GC still fails.
 *
 * The workload is 24 continuously gliding voices plus reverb and delay, using every ease except
 * the solver-based expo and bézier. Those two allocate a little per control tick, because V8 cannot
 * inline their solvers into the audio loop (docs/build-log.md, M2); the last test measures how
 * often that makes the young generation collect, and only reports it. The 'lock' run covers the
 * unison lock: unisons, merges, births into held unisons and a seek every 5 s. In every run half
 * the voices pulse (R9-3b `withPulses`).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeLiveSchedule } from './live-schedule';

const ROOT = path.resolve(import.meta.dirname, '../..');
/** The timer and flag calls around the run allocate ~2 KB; one interpreted seek ~8 KB. */
const MAX_BYTES = 6000;

function runHarness(
  mode: 'plain' | 'all' | 'lock' | 'm6' | 'timbre' | 'fx' | 'parts' | 'live',
  extra: string[] = [],
): {
  gcLines: string[];
  summary: { ms: number; observedGc: number; newSpaceBytes: number; messages?: number };
} {
  const res = spawnSync(
    process.execPath,
    ['--import', './tests/dsp/node/register.mjs', 'tests/dsp/node/gc-harness.ts', mode, ...extra],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  if (res.status !== 0) throw new Error(`harness failed: ${res.stderr}`);
  const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  const summary = JSON.parse(lines[lines.length - 1]) as {
    ms: number;
    observedGc: number;
    newSpaceBytes: number;
    messages?: number;
  };
  const gcLines = lines.filter((l) => /Scavenge|Mark-Compact|Mark-sweep|Minor|MinorMS/.test(l));
  return { gcLines, summary };
}

describe('no GC in process()', () => {
  it('runs 60 s of 24 voices + FX with no scavenge', () => {
    const { gcLines, summary } = runHarness('plain');
    console.info(
      `no-GC run: 60 s of audio in ${summary.ms} ms, ${gcLines.length} GC lines, ${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated`,
    );
    expect(gcLines).toEqual([]);
    expect(summary.observedGc).toBe(0);
    expect(summary.newSpaceBytes).toBeLessThanOrEqual(MAX_BYTES);
  }, 120_000);

  it('runs 60 s of unisons, merges, births into unisons and seeks with no scavenge', () => {
    const { gcLines, summary } = runHarness('lock');
    console.info(
      `no-GC run (unison lock): 60 s of audio in ${summary.ms} ms, ${gcLines.length} GC lines, ${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated`,
    );
    expect(gcLines).toEqual([]);
    expect(summary.observedGc).toBe(0);
    expect(summary.newSpaceBytes).toBeLessThanOrEqual(MAX_BYTES);
  }, 120_000);

  it("runs 60 s of the unison-lock workload with seeks under mix.normalise 'part' with no scavenge", () => {
    const { gcLines, summary } = runHarness('parts');
    console.info(
      `no-GC run (per-part normalisation): 60 s of audio in ${summary.ms} ms, ${gcLines.length} GC lines, ${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated`,
    );
    expect(gcLines).toEqual([]);
    expect(summary.observedGc).toBe(0);
    expect(summary.newSpaceBytes).toBeLessThanOrEqual(MAX_BYTES);
  }, 120_000);

  it('runs 60 s of 24 M6 voices (bells, FM, noise) + FX with no scavenge', () => {
    const { gcLines, summary } = runHarness('m6');
    console.info(
      `no-GC run (M6 timbres): 60 s of audio in ${summary.ms} ms, ${gcLines.length} GC lines, ${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated`,
    );
    expect(gcLines).toEqual([]);
    expect(summary.observedGc).toBe(0);
    expect(summary.newSpaceBytes).toBeLessThanOrEqual(MAX_BYTES);
  }, 120_000);

  it('runs 60 s of timbre changes (overlapping fades, every path, locked voices) and seeks with no scavenge', () => {
    const { gcLines, summary } = runHarness('timbre');
    console.info(
      `no-GC run (timbre changes): 60 s of audio in ${summary.ms} ms, ${gcLines.length} GC lines, ${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated`,
    );
    expect(gcLines).toEqual([]);
    expect(summary.observedGc).toBe(0);
    expect(summary.newSpaceBytes).toBeLessThanOrEqual(MAX_BYTES);
  }, 120_000);

  it('runs 60 s of master FX edits (tilt, low-pass, size and delay crossfades) with no scavenge', () => {
    const { gcLines, summary } = runHarness('fx');
    console.info(
      `no-GC run (FX edits): 60 s of audio in ${summary.ms} ms, ${gcLines.length} GC lines, ${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated`,
    );
    expect(gcLines).toEqual([]);
    expect(summary.observedGc).toBe(0);
    // 240 edits. setMix and the FX pass values through typed arrays, so an edit allocates nothing
    // once optimised (measured: 1864 B, as the plain run); the slack is 32 B per edit for message
    // handling caught unoptimised. 8 B per block in process() would be 180 KB.
    expect(summary.newSpaceBytes).toBeLessThanOrEqual(MAX_BYTES + 240 * 32);
  }, 120_000);

  it('runs 60 s of live input (24 voices, key changes, bends, releases) with no scavenge', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'algorhythms-live-'));
    const file = path.join(dir, 'session.json');
    try {
      const made = writeLiveSchedule(file);
      const { gcLines, summary } = runHarness('live', [file]);
      console.info(
        `no-GC run (live): 60 s of audio in ${summary.ms} ms, ${summary.messages} live messages ` +
          `(${made.messages}, ${made.presses} re-planning a press, + ${made.bends} bends), ` +
          `${gcLines.length} GC lines, ` +
          `${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated`,
      );
      expect(made.presses).toBeGreaterThan(50); // the press-window rewind path is exercised
      expect(gcLines).toEqual([]);
      expect(summary.observedGc).toBe(0);
      expect(summary.newSpaceBytes).toBeLessThanOrEqual(MAX_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('reports the GC rate when expo and bézier glides are included', () => {
    const { gcLines, summary } = runHarness('all');
    console.info(
      `with expo/bézier glides: ${gcLines.filter((l) => l.includes('Scavenge')).length} scavenges per 60 s ` +
        `(${summary.observedGc} observed, ${summary.newSpaceBytes} B allocated)`,
    );
    expect(gcLines.every((l) => !/Mark-Compact|Mark-sweep/.test(l))).toBe(true); // never a major GC
  }, 120_000);
});
