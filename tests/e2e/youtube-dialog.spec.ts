/**
 * The Export dialog's "Ready for YouTube" controls (PLAN.md §12, §15 M11): the YouTube and Shorts
 * presets (and Custom), the Shorts length warning, Loudness measured in a worker (with the > 6 dB
 * warning on Crease), Glow / Vignette / guide notes in the preview, Opening & ending in the
 * preview (title card at its time, the end card's whole-piece view), Thumbnail and Copy
 * description. With SHOTS_OUT set, two dialog screenshots are written there.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';

interface HookWindow {
  __algorhythms: {
    store: {
      getState(): {
        piece: { end: { at?: number }; meta: { title: string } };
        compiled: { duration: number };
      };
    };
    actions: { setPiece(p: unknown): void; recompileNow(): void };
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

const dialog = (page: Page) => page.getByTestId('export-dialog');
const radio = (page: Page, testId: string, label: string) =>
  dialog(page).getByTestId(testId).getByLabel(label, { exact: true });

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = radio(page, testId, label);
  await input.click();
  await expect(input).toBeChecked();
}

async function openVideo(page: Page, example = 'kite-day'): Promise<void> {
  await page.goto(`./?example=${example}`);
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openDialog(page, 'Video (MP4)');
}

async function openDialog(page: Page, format: string): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await choose(page, 'export-format', format);
  if (format === 'Video (MP4)') {
    await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  }
}

/** The preview's last request (options, score time, video time). */
async function lastPreview(page: Page) {
  return page.evaluate(async () =>
    (await (window as unknown as HookWindow).__algorhythms.exportRun()).lastPreviewRequest(),
  );
}

/** Waits for the preview to draw after `act`, then its pixels as a data URL. */
async function previewAfter(page: Page, act: () => Promise<void>): Promise<string> {
  const canvas = page.getByTestId('preview-canvas');
  const before = Number(await canvas.getAttribute('data-draws'));
  await act();
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-draws')))
    .toBeGreaterThan(before);
  return canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
}

/** Mean absolute difference (0..255) between two canvases' pixels, given as data URLs. */
async function pixelDiff(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    async ([x, y]) => {
      const load = async (u: string) => {
        const img = await createImageBitmap(await (await fetch(u)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const [p, q] = await Promise.all([load(x), load(y)]);
      let d = 0;
      for (let i = 0; i < p.length; i++) d += Math.abs(p[i] - q[i]);
      return d / p.length;
    },
    [a, b],
  );
}

test('YouTube and Shorts presets set their options; changing one shows Custom', async ({
  page,
}, info) => {
  const shots = process.env.SHOTS_OUT;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await openVideo(page);
  const preset = (label: string) => radio(page, 'export-preset', label);
  await expect(preset('Custom')).toBeChecked();
  await expect(preset('Custom')).toBeDisabled();

  await preset('YouTube').click();
  await expect(preset('YouTube')).toBeChecked();
  const sizes = await page.evaluate(async () =>
    (await (window as unknown as HookWindow).__algorhythms.exportRun()).videoSizes({
      aspect: '16:9',
      fps: 60,
    }),
  );
  const big = sizes.includes('2160') ? '4K' : '1440p';
  await expect(radio(page, 'export-aspect', '16:9')).toBeChecked();
  await expect(radio(page, 'export-vsize', big)).toBeChecked();
  await expect(radio(page, 'export-fps', '60 fps')).toBeChecked();
  await expect(radio(page, 'export-quality', 'High')).toBeChecked();
  await expect(radio(page, 'export-loudness', '−14 LUFS')).toBeChecked();
  await expect(page.getByTestId('bookends-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('vb-title-card')).toBeChecked();
  await expect(page.getByTestId('vb-end-card').getByLabel('10 s', { exact: true })).toBeChecked();
  const req = await lastPreview(page);
  expect(req?.kind === 'video' && req.options.bookends).toMatchObject({
    endCard: 10,
    title: { text: 'Kite Day' },
  });
  if (shots && info.project.name === 'chromium-dev') {
    await page.getByTestId('bookends-button').click();
    await expect(page.getByTestId('bookends-button')).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(300);
    await dialog(page).evaluate((d) => (d.scrollTop = 0));
    await dialog(page).screenshot({ path: join(shots, 'youtube-preset-1440x900.png') });
    await page.getByTestId('bookends-button').click();
    await page.waitForTimeout(300);
    await page.getByTestId('bookends').scrollIntoViewIfNeeded();
    await page.getByTestId('bookends').screenshot({ path: join(shots, 'opening-ending.png') });
  }

  // Changing one of its options shows Custom; choosing it again restores them.
  await choose(page, 'export-fps', '30 fps');
  await expect(preset('Custom')).toBeChecked();
  await preset('YouTube').click();
  await expect(radio(page, 'export-fps', '60 fps')).toBeChecked();
  await page.getByTestId('vb-end-card').getByLabel('5 s', { exact: true }).click();
  await expect(preset('Custom')).toBeChecked();

  // Shorts: 9:16 1080×1920, 60 fps, High, −14 LUFS, no end card.
  await preset('Shorts').click();
  await expect(preset('Shorts')).toBeChecked();
  await expect(radio(page, 'export-aspect', '9:16')).toBeChecked();
  await expect(radio(page, 'export-vsize', '1080p')).toBeChecked();
  await expect(radio(page, 'export-fps', '60 fps')).toBeChecked();
  await expect(radio(page, 'export-quality', 'High')).toBeChecked();
  await expect(radio(page, 'export-loudness', '−14 LUFS')).toBeChecked();
  await expect(page.getByTestId('vb-end-card').getByLabel('Off', { exact: true })).toBeChecked();
  await expect(page.getByTestId('shorts-warn')).toHaveCount(0);
  await choose(page, 'export-quality', 'Max');
  await expect(preset('Custom')).toBeChecked();
  await choose(page, 'export-quality', 'High');
  await expect(preset('Shorts')).toBeChecked();
  await choose(page, 'export-loudness', 'Off');
  await expect(preset('Custom')).toBeChecked();

  // Keyboard: the preset is a radio group (Custom is skipped).
  await preset('YouTube').focus();
  await page.keyboard.press('ArrowRight');
  await expect(preset('Shorts')).toBeChecked();
  await expect(preset('Shorts')).toBeFocused();
});

test('Shorts warns when the section is over 3 minutes', async ({ page }) => {
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece);
    p.end.at = 200;
    h.actions.setPiece(p);
    h.actions.recompileNow();
  });
  await openDialog(page, 'Video (MP4)');
  await radio(page, 'export-preset', 'Shorts').click();
  await expect(page.getByTestId('shorts-warn')).toHaveText(/at most 3 min; this is 3:2\d/);
  await choose(page, 'export-section', 'Custom');
  await expect(page.getByTestId('shorts-warn')).toHaveCount(0);
});

test('Loudness shows the measured value and gain, and warns on Crease', async ({ page }, info) => {
  test.skip(info.project.name.endsWith('-prod'), 'once');
  test.setTimeout(120_000);
  await page.goto('./?example=crease');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await openDialog(page, 'WAV');
  await expect(page.getByTestId('loudness-measure')).toHaveCount(0);
  await choose(page, 'export-loudness', '−14 LUFS');
  const line = page.getByTestId('loudness-measure');
  await expect(line).toHaveText(/Measuring/);
  // Y1 measured Crease at −21.9 LUFS, true peak high: about 7 dB of limiting at −14.
  await expect(line).toHaveText(/^Now −2[12]\.\d LUFS · gain \+[78]\.\d dB$/, { timeout: 90_000 });
  const warn = page.getByTestId('loudness-warn');
  await expect(warn).toBeVisible();
  expect(Number(await warn.getAttribute('data-limit'))).toBeGreaterThan(6);
  expect(await warn.getAttribute('title')).toMatch(/Glue/);
  // −16 and Off → −14 reuse the measurement (cached per piece version): no second render.
  await choose(page, 'export-loudness', '−16 LUFS');
  await expect(line).toHaveText(/^Now −2[12]\.\d LUFS · gain \+[56]\.\d dB$/);
  await choose(page, 'export-loudness', 'Off');
  await choose(page, 'export-loudness', '−14 LUFS');
  await expect(line).toHaveText(/^Now /, { timeout: 500 });
});

test('Glow, Vignette and guide notes change the preview', async ({ page }) => {
  await openVideo(page);
  const plain = await page
    .getByTestId('preview-canvas')
    .evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const glow = await previewAfter(page, () => page.getByTestId('look-glow').fill('80'));
  expect((await lastPreview(page))!.options.look!.glow).toBe(0.8);
  await expect(page.getByTestId('look-glow-value')).toHaveText('80 %');
  expect(await pixelDiff(page, plain, glow)).toBeGreaterThan(0.2);
  const vig = await previewAfter(page, () => page.getByTestId('look-vignette').fill('100'));
  expect((await lastPreview(page))!.options.look!.vignette).toBe(1);
  expect(await pixelDiff(page, glow, vig)).toBeGreaterThan(0.2);

  const input = page.getByTestId('look-pitch-input');
  const guides = await previewAfter(page, async () => {
    await input.fill('A4, C5');
    await input.press('Enter');
  });
  await expect(page.getByTestId('look-pitch-69')).toBeVisible();
  await expect(page.getByTestId('look-pitch-72')).toBeVisible();
  expect((await lastPreview(page))!.options.look!.pitchGuides).toEqual({
    pitches: [69, 72],
    labels: true,
  });
  expect(await pixelDiff(page, vig, guides)).toBeGreaterThan(0.01);
  const unlabelled = await previewAfter(page, () => page.getByTestId('look-pitch-labels').click());
  expect((await lastPreview(page))!.options.look!.pitchGuides!.labels).toBe(false);
  expect(await pixelDiff(page, guides, unlabelled)).toBeGreaterThan(0);
  // A bad name is marked, not added; × removes a note.
  await input.fill('H9');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('look-pitch-72').click();
  expect((await lastPreview(page))!.options.look!.pitchGuides!.pitches).toEqual([69]);
});

test('Opening & ending: the title card at its time, the end card the whole piece', async ({
  page,
}) => {
  await openVideo(page);
  const button = page.getByTestId('bookends-button');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await page.getByTestId('vb-lead-in').fill('1');
  await expect(page.getByTestId('vb-lead-in-value')).toHaveText('1.0 s');
  await page.getByTestId('vb-end-card').getByLabel('5 s', { exact: true }).click();
  const slider = page.getByTestId('preview-time');
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  const D = await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().compiled.duration,
  );
  // The slider spans the lead-in, the piece and the end card (and any ring-out).
  expect(min).toBeCloseTo(-1, 5);
  expect(max - min).toBeGreaterThanOrEqual(1 + D + 5 - 1e-6);

  // τ = 2.5 s: the title card fully in (0.5 s + 1 s fade in).
  const noTitle = await previewAfter(page, () => slider.fill(String(min + 2.5)));
  const req = await lastPreview(page);
  expect(req?.kind === 'video' && req.tau).toBeCloseTo(2.5, 5);
  await expect(page.getByTestId('preview-time-value')).toHaveText(/00:02\.5/);
  const titled = await previewAfter(page, () => page.getByTestId('vb-title-card').click());
  await expect(page.getByTestId('vb-title')).toHaveValue('Kite Day');
  expect(await pixelDiff(page, noTitle, titled)).toBeGreaterThan(0.3);
  // The title is drawn by the export's own moment drawing at that τ.
  const same = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const r = (await h.exportRun()).lastPreviewRequest()!;
    if (r.kind !== 'video') return -1;
    const v = await h.videoExport();
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]')!;
    const off = new OffscreenCanvas(c.width, c.height);
    const { piece, compiled } = h.store.getState() as never;
    v.previewVideoMoment(off.getContext('2d')!, piece, compiled, r.options, r.tau!, r.scale);
    const a = off.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const b = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d / a.length;
  });
  expect(same).toBeLessThan(0.5);

  // The end: the whole-piece view, no HUD boxes.
  const end = await previewAfter(page, () => slider.fill(String(max)));
  await expect(page.getByTestId('hud-overlay')).toHaveCount(0);
  const last = await previewAfter(page, () => slider.fill(String(min + 1 + D - 0.1)));
  expect(await pixelDiff(page, end, last)).toBeGreaterThan(1);
  await expect(page.getByTestId('hud-overlay')).toHaveCount(1);
});

test('Thumbnail downloads a 1280×720 JPEG under 2 MB', async ({ page }) => {
  await openVideo(page);
  for (const at of ['This frame', 'Whole piece']) {
    await page.getByTestId('thumbnail-at').getByLabel(at, { exact: true }).click();
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-thumbnail').click(),
    ]);
    expect(file.suggestedFilename()).toBe('Kite-Day-thumbnail.jpg');
    const data = readFileSync((await file.path())!);
    expect(data.length).toBeLessThan(2_000_000);
    expect([data[0], data[1]]).toEqual([0xff, 0xd8]);
    // The first SOF marker's height and width.
    let i = 2;
    while (i < data.length && !(data[i] === 0xff && data[i + 1] >= 0xc0 && data[i + 1] <= 0xc2)) {
      i += 2 + data.readUInt16BE(i + 2);
    }
    expect({ h: data.readUInt16BE(i + 5), w: data.readUInt16BE(i + 7) }).toEqual({
      h: 720,
      w: 1280,
    });
  }
});

test('Copy description puts the text, chapters when allowed, on the clipboard', async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  } else {
    // Other engines: record what is written (their clipboard can't be read back here).
    await page.addInitScript(() => {
      const w = window as unknown as { __copied?: string };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__copied = t;
            return Promise.resolve();
          },
          readText: () => Promise.resolve(w.__copied ?? ''),
        },
      });
    });
  }
  await openVideo(page, 'night-sleeper');
  await page.getByTestId('export-description').click();
  await expect(page.getByTestId('export-description')).toHaveText('Copied');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const want = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const { piece, compiled } = h.store.getState() as never;
    const m = await h.exportRun();
    return m.descriptionOf(
      { piece, compiled },
      {
        section: 'whole',
        sectionSpan: null,
      } as never,
      { duration: 0, window: 10, dark: false, colors: 'pitch' } as never,
    );
  });
  expect(text).toBe(want);
  expect(text).toMatch(/^Night Sleeper\n/);
  expect(text).toMatch(/Made with AlgoRhythms: https:\/\/baphaelman\.github\.io\/algorhythms\//);
  // Chapters only as YouTube allows them: if any, the first at 0:00.
  const ch = text.split('\n').filter((l) => /^\d+:\d\d /.test(l));
  if (ch.length > 0) {
    expect(ch.length).toBeGreaterThanOrEqual(3);
    expect(ch[0]).toMatch(/^0:00 /);
  }

  // With the share link.
  await page.getByTestId('description-link').click();
  await expect(page.getByTestId('export-description')).toBeEnabled();
  await page.getByTestId('export-description').click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/Open it in AlgoRhythms: http.*#p=/);
});
