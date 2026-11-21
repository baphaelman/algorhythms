/**
 * The property hang watchdog (tests/support/prop-watchdog.ts): a stalled fc.assert is killed with
 * its seed and path on stderr; one that keeps making progress, or has finished, is left alone.
 * Each case runs in a child Node process, since the watchdog kills the process it watches.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODULE = fileURLToPath(new URL('../support/prop-watchdog.ts', import.meta.url));

function child(body: string) {
  const script = `import { startWatchdog } from ${JSON.stringify(MODULE)};\n${body}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('property watchdog', { timeout: 90_000 }, () => {
  it('kills a stalled run and reports its seed, path and test name', () => {
    const r = child(`
      const d = startWatchdog(300);
      d.begin(1234, 'compiler > is deterministic');
      d.beforeEach(); d.afterEach(); d.beforeEach(); d.afterEach(); d.beforeEach();
      for (;;);
    `);
    expect(r.signal).toBe('SIGKILL');
    expect(r.stderr).toContain('"compiler > is deterministic"');
    expect(r.stderr).toContain('seed 1234, run 3, path "2"');
  });

  it('leaves progressing and finished properties alone', () => {
    const r = child(`
      const d = startWatchdog(300);
      const busy = (ms) => { const t = Date.now() + ms; while (Date.now() < t); };
      d.begin(7, 'steady');
      for (let i = 0; i < 12; i++) { d.beforeEach(); busy(50); d.afterEach(); }
      d.end();
      busy(900); // idle outside fc.assert: not a hang
    `);
    expect(r.stderr).not.toContain('watchdog');
    expect(r.status).toBe(0);
  });
});
