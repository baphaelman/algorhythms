/**
 * Property-run watchdog. A property whose predicate never returns (an endless loop in the code
 * under test) blocks the test thread, so neither Vitest's timeout nor fast-check's time limits can
 * fire, and nothing says which input hung. This watchdog runs in a worker thread: when an
 * fc.assert makes no progress (no run starts or ends) for `limitMs`, it prints the seed, the run's
 * path and the test name to stderr and kills the test process, turning the hang into a
 * reproducible failure.
 *
 * Plain Node (no Vitest import) so tests/unit/prop-watchdog.test.ts can drive it in a child process.
 */
import { Worker } from 'node:worker_threads';

// Shared layout: Int32 [active, run, seed, gen, labelLength], then the label's UTF-8 bytes.
const ACTIVE = 0;
const RUN = 1;
const SEED = 2;
const GEN = 3;
const LABEL_LEN = 4;
const HEADER = 32;
const LABEL_MAX = 1024;

const WORKER = `
// getBuiltinModule works whether the eval runs as CommonJS or as a module.
const { workerData } = process.getBuiltinModule('node:worker_threads');
const { writeSync } = process.getBuiltinModule('node:fs');
const { sab, limitMs, pid, reportFd } = workerData;
const i32 = new Int32Array(sab, 0, 8);
const label = new Uint8Array(sab, ${HEADER});
const nap = new Int32Array(new SharedArrayBuffer(4));
let gen = -1;
let since = Date.now();
for (;;) {
  Atomics.wait(nap, 0, 0, Math.min(250, limitMs / 4));
  const g = Atomics.load(i32, ${GEN});
  if (g !== gen || Atomics.load(i32, ${ACTIVE}) === 0) {
    gen = g;
    since = Date.now();
    continue;
  }
  if (Date.now() - since < limitMs) continue;
  const run = Atomics.load(i32, ${RUN});
  const seed = Atomics.load(i32, ${SEED});
  const name = Buffer.from(label.slice(0, Atomics.load(i32, ${LABEL_LEN}))).toString('utf8');
  const path = String(Math.max(0, run - 1));
  writeSync(reportFd,
    '\\n[property watchdog] no progress for ' + limitMs + ' ms in "' + name + '"\\n' +
    '  seed ' + seed + ', run ' + run + ', path "' + path + '" (exact unless it was shrinking)\\n' +
    '  replay: fc.assert(prop, { seed: ' + seed + ', path: "' + path + '" }),\\n' +
    '  or PROP_SEED=' + seed + ' PROP_PATH=' + path + ' for suites that read them\\n');
  process.kill(pid, 'SIGKILL');
}
`;

export interface Watchdog {
  /** Marks an fc.assert as started; `seed` is the seed it runs with. */
  begin(seed: number, label: string): void;
  /** Marks it as finished. */
  end(): void;
  /** fast-check global hooks: each run's start and end count as progress. */
  beforeEach(): void;
  afterEach(): void;
}

/** Starts the watchdog thread (unref'd, so it never keeps the process alive). */
export function startWatchdog(limitMs: number, reportFd = 2): Watchdog {
  const sab = new SharedArrayBuffer(HEADER + LABEL_MAX);
  const i32 = new Int32Array(sab, 0, 8);
  const label = new Uint8Array(sab, HEADER);
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { sab, limitMs, pid: process.pid, reportFd },
  });
  worker.unref();
  const tick = (): void => {
    Atomics.add(i32, GEN, 1);
  };
  return {
    begin(seed, name) {
      const bytes = new TextEncoder().encode(name).slice(0, LABEL_MAX);
      label.set(bytes);
      Atomics.store(i32, LABEL_LEN, bytes.length);
      Atomics.store(i32, SEED, seed | 0);
      Atomics.store(i32, RUN, 0);
      tick();
      Atomics.store(i32, ACTIVE, 1);
    },
    end() {
      Atomics.store(i32, ACTIVE, 0);
      tick();
    },
    beforeEach() {
      Atomics.add(i32, RUN, 1);
      tick();
    },
    afterEach: tick,
  };
}
