/**
 * The camera UI (PLAN.md §15 M11.5 C3): the Export dialog's Camera (Follow / Auto / Keys write
 * the piece, one undo entry each; Edit copies Auto's keys), key markers on the preview's
 * timeline (add, move, delete by mouse and keyboard), the preview shaping the selected key (the
 * export's frame matches), and the editor's Camera toggle (off: Follow as today; on while
 * playing: the camera path; a zoom turns it off; remembered). The camera survives a reload and
 * a share link.
 */

import { expect, test, type Page } from '@playwright/test';
import { guarded } from './export-diag';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';
import type { CameraKey, PieceCamera } from '../../src/core/types';
import { cameraPathAt } from '../../src/render/camera-path';

interface HookWindow {
  __algorhythms: {
    store: {
      getState(): {
        piece: { camera?: PieceCamera; meta: { title: string } };
        compiled: unknown;
        view: { window: number; cameraPath: boolean };
        transport: { status: string };
      };
    };
    actions: { loadPiece(p: unknown): void; seek(t: number): void };
    editor: { undo(): boolean };
    frameStats: {
      t: number;
      start: number;
      window: number;
      path: boolean;
      aspect: number;
      drawn: number;
    };
    encodeShareLink(piece: unknown, base: string): string;
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

const KEYS: CameraKey[] = [
  { at: 0, window: 8, place: 0.25, pitch: 62, range: 30 },
  { at: 2.5, window: 20, place: 0.5, pitch: 66, range: 20, ease: 'linear' },
  { at: 5, window: 6, place: 0.7, pitch: 60, range: 36 },
];

const dialog = (page: Page) => page.getByTestId('export-dialog');
const markers = (page: Page) => page.getByTestId('camera-key');

const cameraOf = (page: Page) =>
  page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().piece.camera ?? null,
  );

const keysOf = async (page: Page) => (await cameraOf(page))?.keys ?? [];

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = dialog(page).getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `choose ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** Kite Day, optionally with a camera; nothing played yet. */
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

async function openVideo(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(dialog(page)).toBeVisible();
  await choose(page, 'export-format', 'Video (MP4)');
  await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  await choose(page, 'export-vsize', '720p');
}

/** Sets the preview's time and waits until it has drawn there. */
async function previewAt(page: Page, t: number): Promise<void> {
  await page.getByTestId('preview-time').fill(String(t));
  await previewDrawnAt(page, t);
}

async function previewDrawnAt(page: Page, t: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const req = (
          await (window as unknown as HookWindow).__algorhythms.exportRun()
        ).lastPreviewRequest();
        return req?.kind === 'video' ? req.t : NaN;
      }),
    )
    .toBeCloseTo(t, 2);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
}

/** Undo inside the dialog (focus on a non-text control). */
async function undoHere(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+z');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('Camera: Auto by default; a choice writes the piece and undoes; Edit copies Auto', async ({
  page,
}) => {
  await load(page);
  await openVideo(page);
  const group = dialog(page).getByTestId('export-camera');
  await expect(group.getByLabel('Auto', { exact: true })).toBeChecked();
  expect(await cameraOf(page)).toBeNull();
  await expect(page.getByTestId('camera-keys')).toHaveCount(0);

  await choose(page, 'export-camera', 'Follow');
  expect(await cameraOf(page)).toEqual({ mode: 'follow' });
  await expect(page.getByTestId('export-window')).toBeVisible();
  await undoHere(page);
  await expect.poll(() => cameraOf(page)).toBeNull();
  await expect(group.getByLabel('Auto', { exact: true })).toBeChecked();
  await expect(page.getByTestId('export-window')).toHaveCount(0);

  // Whole piece is the dialog's own: the piece keeps no camera.
  await choose(page, 'export-camera', 'Whole piece');
  expect(await cameraOf(page)).toBeNull();
  await choose(page, 'export-camera', 'Auto');
  expect(await cameraOf(page)).toEqual({ mode: 'auto' });

  // Edit: Auto's keys for this video (C2's, at its aspect) as Keys.
  await previewAt(page, 3);
  const auto = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'video') throw new Error('not video');
    const s = h.store.getState();
    return (await h.videoExport()).videoAutoKeys(s.compiled as never, req.options);
  });
  expect(auto.length).toBeGreaterThan(1);
  await guarded(page, 'Edit', () => page.getByTestId('camera-edit').click());
  await expect(group.getByLabel('Keys', { exact: true })).toBeChecked();
  const r = { camera: (await cameraOf(page))! };
  expect(r.camera.mode).toBe('keys');
  expect(r.camera.keys).toEqual(auto);
  await expect(markers(page)).toHaveCount(r.camera.keys!.length);
  // One undo entry back to Auto.
  await undoHere(page);
  await expect.poll(() => cameraOf(page)).toEqual({ mode: 'auto' });
  await expect(group.getByLabel('Auto', { exact: true })).toBeChecked();
});

test('keys by mouse: add at the preview time, drag in time, delete; one undo each', async ({
  page,
}) => {
  await load(page, { mode: 'keys', keys: KEYS });
  await openVideo(page);
  await expect(dialog(page).getByTestId('export-camera').getByLabel('Keys')).toBeChecked();
  await expect(markers(page)).toHaveCount(3);

  // Add: from the view shown at 7 s (held after the last key), so the picture stays.
  await previewAt(page, 7);
  await page.getByTestId('camera-key-add').click();
  await expect(markers(page)).toHaveCount(4);
  const added = (await keysOf(page))[3];
  expect(added.at).toBeCloseTo(7, 2);
  expect(added.window).toBeCloseTo(KEYS[2].window, 6);
  expect(added.place).toBeCloseTo(KEYS[2].place, 3);
  await expect(markers(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('camera-key-count')).toHaveText('Key 4 of 4');

  // Drag the middle key right; the preview follows it.
  const m = markers(page).nth(1);
  const box = (await m.boundingBox())!;
  const track = (await page.getByTestId('camera-keys').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + track.width * 0.02, box.y + 4, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + track.width * 0.04, box.y + 4, { steps: 4 });
  await page.mouse.up();
  const moved = (await keysOf(page))[1].at;
  expect(moved).toBeGreaterThan(2.6);
  expect(moved).toBeLessThan(5);
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-t', moved.toFixed(3));
  await undoHere(page);
  await expect.poll(async () => (await keysOf(page))[1].at).toBe(2.5);

  // Click selects, Delete removes it.
  await markers(page).nth(0).click();
  await expect(markers(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('camera-key-delete').click();
  await expect(markers(page)).toHaveCount(3);
  expect((await keysOf(page)).map((k) => k.at)).toEqual([2.5, 5, 7]);
  await undoHere(page);
  await expect(markers(page)).toHaveCount(4);
});

test('keys by keyboard: Tab reaches the markers; arrows move; Delete removes; focus stays', async ({
  page,
  browserName,
}) => {
  await load(page, { mode: 'keys', keys: KEYS });
  await openVideo(page);
  await page.getByTestId('preview-time').focus();
  // WebKit (macOS) tabs to buttons with Option-Tab only (build log, M11 interactions pass).
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  const first = markers(page).nth(0);
  await expect(first).toBeFocused();
  // A visible ring.
  const ring = await first.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(ring).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await keysOf(page))[0].at).toBe(1);
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => (await keysOf(page))[0].at).toBeCloseTo(1.1, 6);
  // Stops short of the next key.
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await keysOf(page))[0].at).toBeCloseTo(2.45, 6);
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-t', '2.450');
  // ↑ moves the view up a semitone; = zooms in.
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await keysOf(page))[0].pitch).toBe(63);
  await page.keyboard.press('=');
  await expect.poll(async () => (await keysOf(page))[0].window).toBeCloseTo(6.4, 6);
  // Each press is one undo entry.
  await undoHere(page);
  await expect.poll(async () => (await keysOf(page))[0].window).toBe(8);
  await first.focus();
  await page.keyboard.press('Delete');
  await expect(markers(page)).toHaveCount(2);
  await expect(markers(page).nth(0)).toBeFocused();
  // Tab on to Add; Enter adds a key at the preview time.
  await previewAt(page, 9);
  await page.getByTestId('camera-key-add').focus();
  await page.keyboard.press('Enter');
  await expect(markers(page)).toHaveCount(3);
  // Escape still closes the dialog.
  await markers(page).nth(2).focus();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('the preview shapes the selected key: drag pans, wheel zooms; the export frame matches', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await load(page, { mode: 'keys', keys: KEYS });
  await openVideo(page);
  // No key selected: a drag on the preview changes nothing.
  const canvas = page.getByTestId('preview-canvas');
  const c = (await canvas.boundingBox())!;
  const mid = { x: c.x + c.width * 0.5, y: c.y + c.height * 0.55 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 60, mid.y + 40, { steps: 5 });
  await page.mouse.up();
  expect(await keysOf(page)).toEqual(KEYS);

  await markers(page).nth(1).click();
  await previewDrawnAt(page, 2.5);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + c.width * 0.05, mid.y + c.height * 0.1, { steps: 5 });
  await page.mouse.move(mid.x + c.width * 0.1, mid.y + c.height * 0.2, { steps: 5 });
  await page.mouse.up();
  let k = (await keysOf(page))[1];
  expect(k.place).toBeCloseTo(0.6, 2);
  expect(k.pitch).toBeCloseTo(66 + 0.2 * 20, 1);
  expect(k.at).toBe(2.5);
  // One entry for the whole drag.
  await undoHere(page);
  await expect.poll(async () => (await keysOf(page))[1].place).toBe(0.5);

  // Wheel down zooms out (the window); with Shift, the pitch range.
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await keysOf(page))[1].window).toBeGreaterThan(25);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await keysOf(page))[1].range).toBeLessThan(16);
  k = (await keysOf(page))[1];

  // The preview is the export's frame with the new key, and moved off the old picture.
  await previewAt(page, 2.5);
  const r = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest()!;
    if (req.kind !== 'video') throw new Error('not video');
    const piece = h.store.getState().piece as never;
    const m = await h.videoExport();
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
    const live = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const ref = m.referenceFrameAt(piece, req.options, 2.5, req.scale, c.width, c.height).data;
    let bad = 0;
    for (let i = 0; i < live.length; i += 4)
      if (Math.max(...[0, 1, 2, 3].map((j) => Math.abs(live[i + j] - ref[i + j]))) > 16) bad++;
    return { bad: bad / (live.length / 4), camera: req.options.camera };
  });
  expect(r.camera).toBe('keys');
  expect(r.bad).toBeLessThan(0.002);
  expect(k.window).toBeGreaterThan(25);
});

test('editor Camera: off follows as today; on while playing draws the path; a zoom turns it off', async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Keys with no move in the first 4 s would hide a mismatch: these move from 0.
  const keys: CameraKey[] = [
    { at: 0, window: 6, place: 0.2, pitch: 64, range: 24 },
    { at: 6, window: 14, place: 0.6, pitch: 68, range: 30 },
  ];
  await load(page, { mode: 'keys', keys });
  const toggle = page.getByTestId('camera-path-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  const sample = () =>
    page.evaluate(() => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const f = h.frameStats;
      return {
        t: f.t,
        start: f.start,
        window: f.window,
        path: f.path,
        aspect: f.aspect,
        editorWindow: h.store.getState().view.window,
        status: h.store.getState().transport.status,
      };
    });

  // Off: the editor's own window, no path.
  await page.getByTestId('play').click();
  await expect.poll(async () => (await sample()).status).toBe('playing');
  for (let i = 0; i < 3; i++) {
    const s = await sample();
    expect(s.path).toBe(false);
    expect(s.window).toBeCloseTo(s.editorWindow, 6);
    await page.waitForTimeout(150);
  }
  await page.getByTestId('play').click();

  // On: the frame's camera is the path at the frame's time.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Stopped: the normal view.
  expect((await sample()).path).toBe(false);
  await page.evaluate(() => (window as unknown as HookWindow).__algorhythms.actions.seek(0.5));
  await page.getByTestId('play').click();
  await expect.poll(async () => (await sample()).path).toBe(true);
  for (let i = 0; i < 5; i++) {
    const s = await sample();
    // Windows are seconds at 16:9: the editor's canvas shows them scaled to its aspect.
    const want = cameraPathAt(keys, s.t, s.aspect)!;
    expect(s.path).toBe(true);
    expect(Math.abs(s.aspect - 16 / 9)).toBeGreaterThan(0.05);
    expect(s.start, `start at ${s.t}`).toBeCloseTo(want.start, 6);
    expect(s.window, `window at ${s.t}`).toBeCloseTo(want.window, 6);
    await page.waitForTimeout(200);
  }
  await page.getByTestId('play').click();

  // Auto (no camera): the 16:9 Auto video's camera at the playhead (C2's keys), at this aspect.
  await page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const p = structuredClone(h.store.getState().piece) as Record<string, unknown>;
    delete p.camera;
    h.actions.loadPiece(p);
    h.actions.seek(0.5);
  });
  await page.getByTestId('play').click();
  await expect.poll(async () => (await sample()).path).toBe(true);
  for (let i = 0; i < 4; i++) {
    const s = await sample();
    const video = await page.evaluate(async (t) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const m = await h.videoExport();
      const st = h.store.getState();
      const opts = { aspect: '16:9', size: '720', fps: 30, theme: 'dark', hud: true };
      const o = { ...opts, camera: 'auto' } as never;
      const cam = m.videoCameraAt(st.piece as never, st.compiled as never, o, t);
      return { cam, keys: m.videoAutoKeys(st.compiled as never, o) };
    }, s.t);
    // The video's camera, its window scaled to the editor's aspect about the playhead.
    const f = s.aspect / (16 / 9);
    expect(s.window, `auto window at ${s.t}`).toBeCloseTo(video.cam.window * f, 6);
    expect(s.start, `auto start at ${s.t}`).toBeCloseTo(s.t - (s.t - video.cam.start) * f, 6);
    expect(s.start).toBeCloseTo(cameraPathAt(video.keys, s.t, s.aspect)!.start, 6);
    await page.waitForTimeout(200);
  }
  // A zoom while playing turns it off.
  await page.getByTestId('zoom-in').click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await sample()).path).toBe(false);
  await page.getByTestId('play').click();

  // Remembered per browser.
  await toggle.click();
  await page.reload();
  await expect(page.getByTestId('camera-path-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('the camera survives a reload (My pieces) and a share link', async ({ page, context }) => {
  await load(page);
  await openVideo(page);
  // Keys starts from Auto's keys; + Key adds one.
  await choose(page, 'export-camera', 'Keys');
  const n = (await keysOf(page)).length;
  expect(n).toBeGreaterThan(1);
  await previewAt(page, 4.3);
  await page.getByTestId('camera-key-add').click();
  await expect(markers(page)).toHaveCount(n + 1);
  await page.getByTestId('export-close').click();
  const camera = await cameraOf(page);
  expect(camera?.keys).toHaveLength(n + 1);
  // The autosave (500 ms debounce) has stored it: a quick reload can beat the pagehide flush.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const r = indexedDB.open('algorhythms', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('pieces', { keyPath: 'id' });
            r.onsuccess = () => {
              const g = r.result.transaction('pieces').objectStore('pieces').count();
              g.onsuccess = () => {
                resolve(g.result);
                r.result.close();
              };
            };
          }),
      ),
    )
    .toBeGreaterThan(0);

  // Share link: a fresh page opens the same camera.
  const link = await page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms;
    return h.encodeShareLink(h.store.getState().piece, location.href.split('#')[0].split('?')[0]);
  });
  const fresh = await context.newPage();
  await fresh.goto(link);
  await expect(fresh.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await cameraOf(fresh)).toEqual(camera);
  await fresh.close();

  // Reload: the autosaved piece reopens from My pieces with its camera.
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-my-pieces').click();
  await page.getByTestId('my-piece-open').first().click();
  await expect.poll(() => cameraOf(page)).toEqual(camera);
});
