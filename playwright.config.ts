import { defineConfig, devices, type LaunchOptions } from '@playwright/test';

/**
 * Every browser runs against two servers:
 * - `dev`:  the Vite dev server (unbundled modules, base '/');
 * - `prod`: `vite preview` of a fresh production build (bundled, base '/algorhythms/').
 * Project names are `<engine>-<mode>`, so CI can select e.g. `--project='webkit-*'`.
 */
const base = process.env.ALGORHYTHMS_BASE ?? '/algorhythms/';
// Ports and the build folder can be overridden (E2E_DEV_PORT, E2E_PROD_PORT, E2E_OUT_DIR) so two
// people or agents can run the suite side by side.
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 5180);
const PROD_PORT = Number(process.env.E2E_PROD_PORT ?? 4180);
const OUT_DIR = process.env.E2E_OUT_DIR ?? 'dist';
const devURL = `http://localhost:${DEV_PORT}/`;
const prodURL = `http://localhost:${PROD_PORT}${base}`;

// Local runs must be silent (headless browsers on macOS still play to the speakers), without
// touching Web Audio behaviour: the graph and clock keep running, only the output is muted.
// Playwright's WebKit has no mute option, so WebKit runs only on CI or with E2E_WEBKIT=1.
const runWebkit = !!process.env.CI || process.env.E2E_WEBKIT === '1';
const engines: { name: string; device: (typeof devices)[string]; launch: LaunchOptions }[] = [
  {
    name: 'chromium',
    device: devices['Desktop Chrome'],
    launch: { args: ['--mute-audio'] },
  },
  {
    name: 'firefox',
    device: devices['Desktop Firefox'],
    launch: { firefoxUserPrefs: { 'media.volume_scale': '0.0' } },
  },
  ...(runWebkit ? [{ name: 'webkit', device: devices['Desktop Safari'], launch: {} }] : []),
];

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  use: { trace: 'retain-on-failure' },
  projects: engines.flatMap(({ name, device, launch }) => [
    { name: `${name}-dev`, use: { ...device, launchOptions: launch, baseURL: devURL } },
    { name: `${name}-prod`, use: { ...device, launchOptions: launch, baseURL: prodURL } },
  ]),
  webServer: [
    {
      command: `pnpm exec vite --port ${DEV_PORT} --strictPort`,
      url: devURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && pnpm exec vite preview --outDir ${OUT_DIR} --port ${PROD_PORT} --strictPort`,
      url: prodURL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
