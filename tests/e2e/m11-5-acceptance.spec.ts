/**
 * M11.5 acceptance (PLAN.md §15 M11.5) checks the C1–C3 specs didn't cover: the camera survives
 * Save as file and reopening it; key markers show only the section's keys; the Camera controls
 * and the editor's Camera toggle fit and read at 1280, 1440, 1920 and 600 px, light and dark,
 * and are reached by Tab in order.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { escapeOut, openVideoExport } from './export-open';
import type { CameraKey, PieceCamera } from '../../src/core/types';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: { camera?: PieceCamera } } };
    actions: { loadPiece(p: unknown): void };
  };
}

const KEYS: CameraKey[] = [
  { at: 0, window: 8, place: 0.25, pitch: 62, range: 30 },
  { at: 20, window: 12, place: 0.5, pitch: 66, range: 20, ease: 'linear' },
  { at: 40, window: 10, place: 0.6, pitch: 64, range: 26 },
  { at: 70, window: 16, place: 0.6, pitch: 64, range: 36 },
];

/** The workspace's Video mode (M15: the old Export dialog's place). */
const dialog = (page: Page) => page.getByTestId('video-workspace');
const markers = (page: Page) => page.getByTestId('camera-key');

const cameraOf = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.camera ?? null,
  );

async function load(page: Page, camera?: PieceCamera): Promise<void> {
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  if (!camera) return;
  await page.evaluate((camera) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece) as Record<string, unknown>;
    p.camera = camera;
    h.actions.loadPiece(p);
  }, camera);
}

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await input.click();
  await expect(input).toBeChecked();
}

async function openVideo(page: Page): Promise<void> {
  await openVideoExport(page);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('the camera survives Save as file and opening that file', async ({ page }) => {
  const camera: PieceCamera = { mode: 'keys', keys: KEYS };
  await load(page, camera);
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByTestId('menu-button').click();
      await page.getByTestId('save-file').click();
    })(),
  ]);
  const text = readFileSync(await file.path(), 'utf8');
  expect(JSON.parse(text).camera).toEqual(camera);

  await load(page);
  expect(await cameraOf(page)).toBeNull();
  await page.getByTestId('file-input').setInputFiles({
    name: file.suggestedFilename(),
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect.poll(() => cameraOf(page)).toEqual(camera);
});

test('with a section, only its keys are on the timeline; arrows keep a key inside it', async ({
  page,
}) => {
  await load(page, { mode: 'keys', keys: KEYS });
  await openVideo(page);
  await expect(dialog(page).getByTestId('export-camera').getByLabel('Keys')).toBeChecked();
  await expect(markers(page)).toHaveCount(4);
  await choose(page, 'export-section', 'Custom');
  const start = page.getByTestId('section-start-text');
  await start.fill('15');
  await start.press('Enter');
  const end = page.getByTestId('section-end-text');
  await end.fill('45');
  await end.press('Enter');
  // 20 s and 40 s are inside 15–45; 0 s and 70 s aren't drawn (they piled up at the ends).
  await expect(markers(page)).toHaveCount(2);
  expect(await markers(page).evaluateAll((els) => els.map((e) => e.dataset.at))).toEqual([
    '20.000',
    '40.000',
  ]);
  // Shift+→ (10 s) from 40 s stops at the section's end; the marker keeps focus.
  await markers(page).nth(1).focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(markers(page).nth(1)).toHaveAttribute('data-at', '45.000');
  await expect(markers(page).nth(1)).toBeFocused();
  expect((await cameraOf(page))!.keys!.map((k) => k.at)).toEqual([0, 20, 45, 70]);
  // Whole piece shows them all again.
  await choose(page, 'export-section', 'Whole piece');
  await expect(markers(page)).toHaveCount(4);
});

const SIZES = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [600, 800],
] as const;

for (const [w, h] of SIZES) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`Camera controls and the editor toggle fit at ${w}×${h} ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: w, height: h });
      await load(page, { mode: 'keys', keys: KEYS });

      // The editor's toggle: on screen, one line, not clipped.
      const toggle = page.getByTestId('camera-path-toggle');
      await expect(toggle).toBeVisible();
      const tb = (await toggle.boundingBox())!;
      expect(tb.x + tb.width).toBeLessThanOrEqual(w);
      expect(tb.y + tb.height).toBeLessThanOrEqual(h);
      expect(tb.height).toBeLessThan(40);

      await openVideo(page);
      await expect(markers(page)).toHaveCount(4);
      const slider = (await page.getByTestId('preview-time').boundingBox())!;
      const boxes = await markers(page).evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          return { x: r.x, y: r.y, w: r.width, h: r.height, border: cs.borderTopColor };
        }),
      );
      for (const b of boxes) {
        // Under the slider, within its width (± half a marker), and visible.
        expect(b.y).toBeGreaterThanOrEqual(slider.y);
        expect(b.x + b.w / 2).toBeGreaterThanOrEqual(slider.x - 1);
        expect(b.x + b.w / 2).toBeLessThanOrEqual(slider.x + slider.width + 1);
        expect(b.w).toBeGreaterThanOrEqual(10);
        expect(b.border).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      }
      // In time order, left to right.
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x);
      // The key buttons and count fit beside each other, inside the dialog.
      const add = (await page.getByTestId('camera-key-add').boundingBox())!;
      const count = (await page.getByTestId('camera-key-count').boundingBox())!;
      const dlg = (await dialog(page).boundingBox())!;
      expect(Math.abs(add.y - count.y)).toBeLessThan(add.height);
      expect(count.x + count.width).toBeLessThanOrEqual(dlg.x + dlg.width);
      await expect(page.getByTestId('camera-key-count')).toHaveText('4 keys');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    });
  }
}

test('Tab: the preview slider, then each key in time order, then + Key and Delete', async ({
  page,
  browserName,
}) => {
  await load(page, { mode: 'keys', keys: KEYS });
  await openVideo(page);
  await expect(markers(page)).toHaveCount(4);
  await markers(page).nth(1).click();
  await page.getByTestId('preview-time').focus();
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(tab);
    seen.push(
      await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        return a.dataset.testid === 'camera-key' ? `key ${a.dataset.at}` : (a.dataset.testid ?? '');
      }),
    );
  }
  expect(seen).toEqual([
    'key 0.000',
    'key 20.000',
    'key 40.000',
    'key 70.000',
    'camera-key-add',
    'camera-key-delete',
  ]);
  // Escape from a marker leaves it, then the workspace; focus back on Menu.
  await markers(page).first().focus();
  await escapeOut(page);
  await expect(page.getByTestId('menu-button')).toBeFocused();
  // The editor's toggle by keyboard (Enter; Space always plays).
  await page.getByTestId('camera-path-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('camera-path-toggle')).toHaveAttribute('aria-pressed', 'true');
});
