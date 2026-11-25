/**
 * Over the poster's camera keys (PLAN.md §15 M15 "Storage", "Panels"): Keys starts from the view,
 * + Key adds the frame the preview shows (in poster space, at its time), the markers are the
 * poster keys, Delete removes one, and One row keeps its own keys.
 */

import { expect, test, type Page } from '@playwright/test';
import { openPoster, switchMode, videoWorkspace, seekPreview } from './export-open';
import { chooseSegment } from './export-diag';
import type { PieceCamera } from '../../src/core/types';
import type * as ExportRun from '../../src/app/export-run';

interface HookWindow {
  __algorhythms: {
    store: { getState(): { piece: { camera?: PieceCamera } } };
    exportRun(): Promise<typeof ExportRun>;
  };
}

const camera = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.camera ?? null,
  );
const markers = (page: Page) => page.getByTestId('camera-key');

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = videoWorkspace(page).getByTestId(testId).getByLabel(label, { exact: true });
  await input.click();
  await expect(input).toBeChecked();
}

async function previewAt(page: Page, t: number): Promise<void> {
  await seekPreview(page, t);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const r = (
          await (window as unknown as HookWindow).__algorhythms.exportRun()
        ).lastPreviewRequest();
        return r?.kind === 'video' ? r.t : NaN;
      }),
    )
    .toBeCloseTo(t, 3);
}

test('Over the poster: Keys from the view, + Key at the preview, Delete; One row keeps its own', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  // A poster edit gives the piece a poster: it plays Over the poster.
  await openPoster(page);
  await chooseSegment(page, 'look-guides', 'Lines');
  await switchMode(page, 'Video');
  await expect(
    page.getByTestId('video-frame').getByLabel('Over the poster', { exact: true }),
  ).toBeChecked();
  await expect(page.getByTestId('timeline-keys')).toContainText('Choose Keys');

  await choose(page, 'export-camera', 'Keys');
  await expect.poll(async () => (await camera(page))?.posterKeys?.length ?? 0).toBeGreaterThan(0);
  const seeded = (await camera(page))!;
  expect(seeded.keys ?? []).toEqual([]);
  await expect(markers(page)).toHaveCount(seeded.posterKeys!.length);

  // + Key adds the frame the preview shows, in poster space.
  await previewAt(page, 20);
  await page.getByTestId('camera-key-add').click();
  await expect(markers(page)).toHaveCount(seeded.posterKeys!.length + 1);
  const keys = (await camera(page))!.posterKeys!;
  const added = keys.find((k) => Math.abs(k.at - 20) < 0.05)!;
  expect(added, JSON.stringify(keys)).toBeTruthy();
  for (const v of [added.x, added.y]) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
  expect(added.h).toBeGreaterThan(0);
  expect(added.h).toBeLessThanOrEqual(1.0001);
  expect(keys.map((k) => k.at)).toEqual([...keys.map((k) => k.at)].sort((a, b) => a - b));

  // Delete removes the selected key.
  await page.getByTestId('camera-key-delete').click();
  await expect(markers(page)).toHaveCount(seeded.posterKeys!.length);

  // One row: its own keys (none yet), the poster keys kept.
  await choose(page, 'video-frame', 'One row');
  const row = (await camera(page))!;
  expect(row.frame).toBe('row');
  expect(row.posterKeys).toHaveLength(seeded.posterKeys!.length);
  await choose(page, 'video-frame', 'Over the poster');
  await expect(markers(page)).toHaveCount(seeded.posterKeys!.length);
});
