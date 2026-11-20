import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
    include: ['tests/{unit,property,golden,dsp}/**/*.test.ts'],
    environment: 'node',
  },
}));
