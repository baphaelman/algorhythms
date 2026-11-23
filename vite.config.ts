import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Timing and GC gates. Their results depend on machine load, so they fail when parallel builders
 * load the dev machine. `pnpm test` skips them; `pnpm test:perf` runs them, and CI runs both.
 */
const PERF_TESTS = [
  'tests/dsp/rtf.test.ts',
  'tests/dsp/no-gc.test.ts',
  'tests/unit/core/compiler-perf.test.ts',
  'tests/unit/render/auto-camera-perf.test.ts',
];

/**
 * GitHub Pages serves a project site from /<repo>/. Production builds (and `vite preview`, which
 * serves those builds) use that base; the dev server uses '/'. Forks with a different repository
 * name set ALGORHYTHMS_BASE (CI does this automatically).
 */
export const PAGES_BASE = process.env.ALGORHYTHMS_BASE ?? '/algorhythms/';

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? PAGES_BASE : '/',
  plugins: [react()],
  worker: {
    // Workers and the AudioWorklet module are emitted as ES modules. An AudioWorklet module is
    // always evaluated as a module script, and the export worker (M2) is created with type 'module'.
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      // fixtures.html is the hidden M2 listening page (not linked from the site).
      input: { main: 'index.html', fixtures: 'fixtures.html' },
    },
  },
  test: {
    environment: 'node',
    // fast-check with a hang watchdog: a property run that never returns fails with its seed and
    // path (tests/support/fast-check.ts).
    alias: [
      {
        find: /^fast-check$/,
        replacement: fileURLToPath(new URL('./tests/support/fast-check.ts', import.meta.url)),
      },
    ],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/{unit,property,golden,dsp}/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...PERF_TESTS],
        },
      },
      { extends: true, test: { name: 'perf', include: PERF_TESTS } },
    ],
  },
}));
