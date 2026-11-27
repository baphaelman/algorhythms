/**
 * M15 acceptance (PLAN.md §15 M15 "Play the poster"): the checks the V1/V2 specs and unit tests
 * didn't cover, one test per line of `docs/m15-acceptance.md`. The camera's frames come from the
 * preview's own request (`lastPreviewRequest`) through the export's `videoPosterFrameAt`, so they
 * are the frames the MP4 draws.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { chooseSegment, setRange, setSwitch } from './export-diag';
import {
  addressSettled,
  openPoster,
  switchMode,
  videoWorkspace,
  workspace,
  seekPreview,
} from './export-open';
import type { PieceCamera, PosterDoc } from '../../src/core/types';
import type * as ExportRun from '../../src/app/export-run';
import type * as VideoExport from '../../src/app/video-export';
import { LOOK_CONTROLS } from '../../src/app/look-controls';

interface HookWindow {
  __algorhythms: {
    store: {
      getState(): {
        piece: { camera?: PieceCamera; poster?: PosterDoc };
        compiled: { duration: number };
      };
    };
    actions: { loadPiece(p: unknown): void };
    editor: { undo(): boolean };
    encodeShareLink(p: unknown): string;
    exportRun(): Promise<typeof ExportRun>;
    videoExport(): Promise<typeof VideoExport>;
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface RowInfo {
  start: number;
  end: number;
  plot: Rect;
  rect: Rect;
}

const hook = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as HookWindow).__algorhythms.store.getState();
    return { camera: s.piece.camera ?? null, poster: s.piece.poster ?? null };
  });

async function choose(page: Page, testId: string, label: string): Promise<void> {
  const input = videoWorkspace(page).getByTestId(testId).getByLabel(label, { exact: true });
  await input.click();
  await expect(input).toBeChecked();
}

/** Waits a frame, then the last preview request's options (the video's). */
async function previewOptions(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))));
  return page.evaluate(async () => {
    const r = (
      await (window as unknown as HookWindow).__algorhythms.exportRun()
    ).lastPreviewRequest();
    return r?.kind === 'video' ? r.options : null;
  });
}

/**
 * The export's frame over the poster at each of `ts` (artboard px), with the poster's size and
 * rows, from the preview's last request. Null when the video doesn't play over the poster.
 */
function framesAt(page: Page, ts: number[] | 'rows') {
  return page.evaluate(async (ts) => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest();
    if (req?.kind !== 'video') return null;
    const ve = await h.videoExport();
    const s = h.store.getState() as unknown as Parameters<typeof ve.videoPosterFrameAt>[0] & {
      piece: Parameters<typeof ve.videoPosterFrameAt>[0];
      compiled: Parameters<typeof ve.videoPosterFrameAt>[1];
    };
    const first = ve.videoPosterFrameAt(s.piece, s.compiled, req.options, 0);
    if (!first) return null;
    const L = first.layout;
    const rows = L.rows.map((r) => ({ start: r.start, end: r.end, plot: r.plot, rect: r.rect }));
    const times =
      ts === 'rows'
        ? rows.flatMap((r) => [0.2, 0.5, 0.85].map((f) => r.start + f * (r.end - r.start)))
        : ts;
    return {
      width: L.width,
      height: L.height,
      unit: L.unit,
      rows,
      aspect: req.options.aspect,
      window: req.options.window ?? null,
      rowBreak: req.options.rowBreak ?? null,
      frames: times.map((t) => ({
        t,
        F: ve.videoPosterFrameAt(s.piece, s.compiled, req.options, t)!.frame,
      })),
    };
  }, ts);
}

const RATIO = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 } as const;

const rowOf = (rows: RowInfo[], t: number) =>
  rows.findIndex((r, i) => t >= r.start && (t < r.end || i === rows.length - 1));

/** Kite Day with a poster of `rows` rows (a poster edit gives the piece its poster), in Video. */
async function posterPiece(page: Page, rows = 3): Promise<void> {
  await openPoster(page);
  await setRange(page, 'export-prows', rows);
  await chooseSegment(page, 'look-guides', 'Lines');
  await switchMode(page, 'Video');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('a piece without a poster plays One row as before; with one, Over the poster', async ({
  page,
}) => {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  if (await workspace(page).isVisible()) await switchMode(page, 'Video');
  const frame = videoWorkspace(page).getByTestId('video-frame');
  await expect(frame.getByLabel('One row', { exact: true })).toBeChecked();
  await expect(videoWorkspace(page).getByTestId('video-row-break')).toHaveCount(0);
  expect((await previewOptions(page))?.frame).toBe('row');
  expect((await hook(page)).poster).toBeNull();

  await switchMode(page, 'Poster');
  await setRange(page, 'export-prows', 3);
  await switchMode(page, 'Video');
  await expect(frame.getByLabel('Over the poster', { exact: true })).toBeChecked();
  await expect(videoWorkspace(page).getByTestId('video-row-break')).toBeVisible();
  const o = await previewOptions(page);
  expect(o?.frame).toBe('poster');
  expect((await framesAt(page, [10]))?.rows).toHaveLength(3);
});

test('Over the poster follows the slice across rows at every poster size and video aspect', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await posterPiece(page, 3);
  for (const size of ['16:9', '1:1', 'A4 portrait'] as const) {
    await switchMode(page, 'Poster');
    await workspace(page).getByTestId('export-psize').getByLabel(size, { exact: true }).click();
    await switchMode(page, 'Video');
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      await choose(page, 'export-aspect', aspect);
      await expect.poll(async () => (await previewOptions(page))?.aspect).toBe(aspect);
      const r = (await framesAt(page, 'rows'))!;
      const what = `${size} poster, ${aspect} video`;
      expect(r.width / r.height, what).toBeCloseTo(
        size === '16:9' ? 16 / 9 : size === '1:1' ? 1 : 2480 / 3508,
        2,
      );
      expect(r.rows, what).toHaveLength(3);
      const ys = new Set<number>();
      for (const { t, F } of r.frames) {
        const row = r.rows[rowOf(r.rows, t)];
        const f = (t - row.start) / (row.end - row.start);
        const x = row.plot.x + f * row.plot.w;
        expect(F.w / F.h, `${what} t ${t}`).toBeCloseTo(RATIO[aspect], 3);
        // The slice (the playhead's x across the row's plot) is inside the frame.
        expect(x, `${what} t ${t}`).toBeGreaterThanOrEqual(F.x - 0.5);
        expect(x, `${what} t ${t}`).toBeLessThanOrEqual(F.x + F.w + 0.5);
        expect(row.plot.y, `${what} t ${t}`).toBeGreaterThanOrEqual(F.y - 0.5);
        expect(row.plot.y + row.plot.h, `${what} t ${t}`).toBeLessThanOrEqual(F.y + F.h + 0.5);
        ys.add(Math.round(F.y));
      }
      // It moves down the poster, row by row.
      expect(ys.size, what).toBeGreaterThanOrEqual(3);
    }
  }
});

test('Over the poster frames one row’s height by default; the Window sets the seconds', async ({
  page,
}) => {
  await posterPiece(page, 3);
  await choose(page, 'export-aspect', '16:9');
  await expect(page.getByTestId('export-window-value')).toHaveText('One row');
  const a = (await framesAt(page, [10]))!;
  expect(a.window).toBeNull();
  const row = a.rows[0];
  // One row's slot: the row and the gap under it.
  expect(a.frames[0].F.h).toBeGreaterThanOrEqual(row.rect.h);
  expect(a.frames[0].F.h).toBeLessThan(row.rect.h * 1.5);
  // A wider Window shows more seconds: a wider (and taller) frame, the slice still in it.
  await setRange(page, 'export-window', 900);
  await expect(page.getByTestId('export-window-value')).not.toHaveText('One row');
  const b = (await framesAt(page, [10]))!;
  expect(b.window).toBeGreaterThan(0);
  const pps = row.plot.w / (row.end - row.start);
  expect(b.frames[0].F.w).toBeGreaterThan(a.frames[0].F.w * 1.2);
  // Its width shows about `window` seconds at the rows' time scale (at most the whole poster).
  expect(b.frames[0].F.w).toBeLessThanOrEqual(Math.max(b.window! * pps, b.width) + 1);
});

test('row breaks: Pan lands as the next row starts, Scroll moves evenly, Cut jumps', async ({
  page,
}) => {
  await posterPiece(page, 3);
  await choose(page, 'export-aspect', '16:9');
  const brk = videoWorkspace(page).getByTestId('video-row-break');
  await expect(brk.getByLabel('Pan', { exact: true })).toBeChecked();
  const probe = async () => {
    const r0 = (await framesAt(page, [10]))!;
    const b = r0.rows[1].start;
    const r = (await framesAt(page, [b - 4, b - 1, b - 0.5, b + 0.01]))!;
    return { rowBreak: r.rowBreak, ys: r.frames.map((f) => f.F.y) };
  };
  const pan = await probe();
  expect(pan.rowBreak).toBe('pan');
  for (const [label, id] of [
    ['Scroll', 'scroll'],
    ['Cut', 'cut'],
  ] as const) {
    await choose(page, 'video-row-break', label);
    await expect.poll(async () => (await hook(page)).camera?.rowBreak).toBe(id);
  }
  const cut = await probe();
  expect(cut.rowBreak).toBe('cut');
  await choose(page, 'video-row-break', 'Scroll');
  const scroll = await probe();
  expect(scroll.rowBreak).toBe('scroll');
  const [before, , , after] = pan.ys;
  // All three hold the row before the break, and land on the next row as it starts.
  for (const s of [pan, scroll, cut]) {
    expect(s.ys[0]).toBeCloseTo(before, 3);
    expect(s.ys[3]).toBeCloseTo(after, 3);
  }
  expect(after).toBeGreaterThan(before);
  // Cut: still on the row before half a second ahead of the break.
  expect(cut.ys[2]).toBeCloseTo(before, 3);
  // Pan and Scroll: on the way, at different places (eased vs even).
  for (const s of [pan, scroll]) {
    expect(s.ys[1]).toBeGreaterThan(before);
    expect(s.ys[2]).toBeLessThan(after);
  }
  expect(Math.abs(pan.ys[1] - scroll.ys[1])).toBeGreaterThan(1);
});

test('stays or travels: HUD readouts travel by default, text boxes stay; each switch works', async ({
  page,
}) => {
  await posterPiece(page, 3);
  const box = videoWorkspace(page).getByTestId('video-travels');
  await expect(box).toBeVisible();
  await expect(box.getByTestId('travels-hud')).toBeChecked();
  const texts = box.locator('[data-testid^="travels-text-"]');
  expect(await texts.count()).toBeGreaterThan(0);
  const tid = (await texts.first().getAttribute('data-testid'))!;
  const textId = tid.replace('travels-text-', '');
  await expect(box.getByTestId(tid)).not.toBeChecked();

  /** The travels flags the export's poster layout gives the HUD readouts and that text. */
  const flags = () =>
    page.evaluate(async (textId) => {
      const h = (window as unknown as HookWindow).__algorhythms;
      const req = (await h.exportRun()).lastPreviewRequest();
      if (req?.kind !== 'video') return null;
      const ve = await h.videoExport();
      const s = h.store.getState() as unknown as {
        piece: Parameters<typeof ve.videoPosterFrameAt>[0];
        compiled: Parameters<typeof ve.videoPosterFrameAt>[1];
      };
      const L = ve.videoPosterFrameAt(s.piece, s.compiled, req.options, 10)!.layout;
      const objs = L.objects as unknown as {
        type: string;
        group?: string;
        member?: string;
        travels?: boolean;
      }[];
      const hud = objs.filter((o) => o.type === 'label' && o.group === 'hud');
      const text = objs.find((o) => o.type === 'text' && o.member === textId);
      return {
        hud: hud.length === 0 ? null : hud.every((o) => o.travels === true),
        text: text ? text.travels === true : null,
      };
    }, textId);

  // The HUD readouts the video shows are on (a readout must exist to travel).
  const start = await flags();
  expect(start?.text).toBe(false);
  if (start?.hud !== null) expect(start?.hud).toBe(true);

  await setSwitch(page, tid, true);
  expect((await hook(page)).poster?.texts?.find((t) => t.id === textId)?.travels).toBe(true);
  await expect.poll(async () => (await flags())?.text).toBe(true);

  await setSwitch(page, 'travels-hud', false);
  expect((await hook(page)).poster?.groups?.hud?.travels).toBe(false);
  await expect.poll(async () => (await flags())?.hud ?? false).toBe(false);
});

test('the section and camera keys edit on the timeline', async ({ page }) => {
  await posterPiece(page, 3);
  await choose(page, 'export-section', 'Custom');
  const D = await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().compiled.duration,
  );
  // Drag the out handle to about 60 % of the piece, on the timeline.
  const track = (await page.getByTestId('section-range').boundingBox())!;
  const handle = (await page.getByTestId('section-end').boundingBox())!;
  const tl = (await page.getByTestId('timeline-keys').boundingBox())!;
  expect(track.y).toBeGreaterThan(tl.y - 200);
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(track.x + 0.6 * track.width, y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await previewOptions(page))?.section?.end ?? D)
    .toBeLessThan(D * 0.7);
  const end = (await previewOptions(page))!.section!.end;
  expect(end).toBeGreaterThan(D * 0.5);
  await expect(page.getByTestId('card-music')).toBeVisible();

  // Keys: seeded from the view, + Key at the preview's time; on the section's range; drag one.
  await choose(page, 'export-camera', 'Keys');
  const markers = page.getByTestId('camera-key');
  await expect.poll(() => markers.count()).toBeGreaterThan(0);
  const n = await markers.count();
  await seekPreview(page, Math.round(end * 0.6));
  await page.getByTestId('camera-key-add').click();
  await expect(markers).toHaveCount(n + 1);
  const keys = (await hook(page)).camera!.posterKeys!;
  expect(keys.length).toBeGreaterThan(1);
  const shown = await markers.evaluateAll((els) => els.map((e) => Number(e.dataset.at)));
  expect(shown).toEqual(keys.filter((k) => k.at <= end + 1e-3).map((k) => Number(k.at.toFixed(3))));
  const lane = (await page.getByTestId('camera-keys').boundingBox())!;
  const m = (await markers.nth(1).boundingBox())!;
  const from = (await previewOptions(page))!.section!.start;
  const at0 = keys[1].at;
  const want = lane.x + ((at0 - from) / (end - from)) * lane.width;
  expect(Math.abs(m.x + m.width / 2 - want)).toBeLessThan(3);
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  await page.mouse.move(m.x + m.width / 2 + 40, m.y + m.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await hook(page)).camera!.posterKeys![1].at).toBeGreaterThan(at0);
});

test('the camera and travels survive Save as file, a reload and a share link', async ({
  page,
  context,
}) => {
  await posterPiece(page, 3);
  await choose(page, 'video-row-break', 'Scroll');
  await setSwitch(page, 'travels-hud', false);
  const tid = (await videoWorkspace(page)
    .locator('[data-testid^="travels-text-"]')
    .first()
    .getAttribute('data-testid'))!;
  await setSwitch(page, tid, true);
  await choose(page, 'export-camera', 'Keys');
  await expect
    .poll(async () => (await hook(page)).camera?.posterKeys?.length ?? 0)
    .toBeGreaterThan(0);
  const want = await hook(page);
  expect(want.camera).toMatchObject({ mode: 'keys', rowBreak: 'scroll' });

  // Save as file, then open it into another piece.
  await page.getByTestId('back-to-music').click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByTestId('menu-button').click();
      await page.getByTestId('save-file').click();
    })(),
  ]);
  const text = readFileSync(await file.path(), 'utf8');
  expect(JSON.parse(text).camera).toEqual(want.camera);

  // Reload.
  await addressSettled(page);
  await page.reload();
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await hook(page)).toEqual(want);

  // Share link.
  const link = await page.evaluate(() => {
    const h = (window as unknown as HookWindow).__algorhythms;
    return h.encodeShareLink(h.store.getState().piece);
  });
  const other = await context.newPage();
  await other.goto(link);
  await expect(other.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  expect(await hook(other)).toEqual(want);
  await other.close();

  // The file.
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.getByTestId('file-input').setInputFiles({
    name: file.suggestedFilename(),
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect.poll(() => hook(page)).toEqual(want);
});

test('each video edit is one undo step', async ({ page }) => {
  await posterPiece(page, 3);
  const undo = () =>
    page.evaluate(() => (window as unknown as HookWindow).__algorhythms.editor.undo());
  const tid = (await videoWorkspace(page)
    .locator('[data-testid^="travels-text-"]')
    .first()
    .getAttribute('data-testid'))!;
  const steps: [string, () => Promise<void>][] = [
    ['frame', () => choose(page, 'video-frame', 'One row')],
    ['row break', () => choose(page, 'video-row-break', 'Cut')],
    ['readouts travel', () => setSwitch(page, 'travels-hud', false)],
    ['a text travels', () => setSwitch(page, tid, true)],
    ['camera Keys', () => choose(page, 'export-camera', 'Keys')],
    [
      '+ Key',
      async () => {
        await seekPreview(page, 33);
        await page.getByTestId('camera-key-add').click();
      },
    ],
    [
      'move a key',
      async () => {
        await page.getByTestId('camera-key').first().focus();
        await page.keyboard.press('ArrowRight');
      },
    ],
    [
      'delete a key',
      async () => {
        await page.getByTestId('camera-key').first().click();
        await page.getByTestId('camera-key-delete').click();
      },
    ],
  ];
  for (const [name, act] of steps) {
    // Keys need Keys on (the step before); the frame goes back to Over the poster.
    if (name === '+ Key' || name === 'move a key' || name === 'delete a key')
      await choose(page, 'export-camera', 'Keys');
    if (name !== 'frame')
      await expect(
        videoWorkspace(page)
          .getByTestId('video-frame')
          .getByLabel('Over the poster', { exact: true }),
      ).toBeChecked();
    const before = await hook(page);
    await act();
    await expect.poll(() => hook(page), { message: name }).not.toEqual(before);
    expect(await undo(), name).toBe(true);
    await expect.poll(() => hook(page), { message: name }).toEqual(before);
  }
});

test('every video option of the old Export dialog is reachable', async ({ page }) => {
  await posterPiece(page, 3);
  const v = videoWorkspace(page);
  // The old dialog's video side (at 00df41a): preview, play, time; preset; section; aspect,
  // size, frame rate, quality; camera, window, playhead at; loudness; the video's Look (ahead,
  // playhead line, heads, HUD readouts); opening & ending; thumbnail and description; Export.
  for (const id of ['export-mode', 'back-to-music'])
    await expect(page.getByTestId(id), id).toBeVisible();
  const video = [
    'preview-canvas',
    'preview-play',
    'preview-fullscreen',
    'timeline-playhead',
    'export-preset',
    'export-section-field',
    'export-aspect',
    'export-vsize',
    'export-fps',
    'export-quality',
    'export-camera',
    'look-follow-at',
    'look-future',
    'look-playhead',
    'look-heads',
    'look-hud-button',
    'export-loudness',
    'bookends',
    'export-thumbnail',
    'export-description',
    'export-run',
  ];
  for (const id of video) await expect(v.getByTestId(id).first(), id).toBeVisible();
  // Window under Follow; One row's own camera (Auto) and Whole piece.
  await choose(page, 'export-camera', 'Follow');
  await expect(v.getByTestId('export-window')).toBeVisible();
  await choose(page, 'video-frame', 'One row');
  for (const label of ['Follow', 'Auto', 'Keys', 'Whole piece'])
    await expect(
      v.getByTestId('export-camera').getByLabel(label, { exact: true }),
      label,
    ).toBeVisible();
  // Keys: markers, + Key, Delete, the count (on the timeline).
  await choose(page, 'export-camera', 'Keys');
  for (const id of ['camera-keys', 'camera-key-add', 'camera-key-delete', 'camera-key-count'])
    await expect(v.getByTestId(id), id).toBeVisible();
  // Opening & ending's fields.
  const be = v.getByTestId('bookends-button');
  if ((await be.getAttribute('aria-expanded')) !== 'true') await be.click();
  for (const id of ['vb-title-card', 'vb-lead-in', 'vb-fade-in', 'vb-fade-out', 'vb-end-card'])
    await expect(v.getByTestId(id).first(), id).toBeVisible();
  // The HUD list: None, Default, Reset layout.
  await v.getByTestId('look-hud-button').click();
  for (const id of ['hud-none', 'hud-default', 'hud-reset-layout'])
    await expect(v.getByTestId(id), id).toBeVisible();

  // The rest of the old video Look is the poster's: in Poster, and the video reads it.
  await switchMode(page, 'Poster');
  const inVideo = new Set(['future', 'follow-at', 'heads', 'playhead']);
  const look = LOOK_CONTROLS.filter((c) => c.kinds.includes('video') && !inVideo.has(c.id));
  expect(look.length).toBeGreaterThan(5);
  const w = workspace(page);
  for (const id of [
    'export-vtheme',
    ...look.map((c) => `look-${c.id}`),
    'look-pitch-guides',
    'colours',
    'look-reset',
  ])
    await expect(w.getByTestId(id).first(), id).toBeVisible();
});

// ---------------------------------------------------------------------------------------------
// The owner's notes on the Video workspace (2026-11-25)
// ---------------------------------------------------------------------------------------------

/** A hash of the preview canvas's pixels and the preview's time. */
const previewShot = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0;
    return { h, draws: Number(c.dataset.draws) };
  });

/** Seeks the preview to t and waits for its redraw; the frame's hash. */
async function shotAt(page: Page, t: number): Promise<number> {
  const before = (await previewShot(page)).draws;
  await seekPreview(page, t);
  await expect.poll(async () => (await previewShot(page)).draws).toBeGreaterThan(before);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))));
  return (await previewShot(page)).h;
}

/** The video's clock: the music's end and the video's end (score time). */
const clockOf = (page: Page) =>
  page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest();
    const D = h.store.getState().compiled.duration;
    const end = req?.kind === 'video' ? (req.options.section?.end ?? D) : D;
    const el = document.querySelector<HTMLElement>('[data-testid="card-ending"]');
    return { end, el: el !== null };
  });

test('the ending zooms out to the finished poster: the same after a Window change, after playing, and in the export', async ({
  page,
  browserName,
}) => {
  test.setTimeout(120_000);
  await posterPiece(page, 3);
  const be = videoWorkspace(page).getByTestId('bookends-button');
  if ((await be.getAttribute('aria-expanded')) !== 'true') await be.click();
  await chooseSegment(page, 'vb-end-card', '5 s');
  const { end, el } = await clockOf(page);
  expect(el).toBe(true);
  const playhead = page.getByTestId('timeline-playhead');
  await playhead.focus();
  await page.keyboard.press('End');
  await expect.poll(async () => Number(await playhead.getAttribute('data-t'))).toBeGreaterThan(end);
  const videoEnd = Number(await playhead.getAttribute('data-t'));

  const last = await shotAt(page, end - 0.01);
  const zoom = await shotAt(page, end + 1);
  const card = await shotAt(page, videoEnd);
  expect(new Set([card, last, zoom]).size).toBe(3);
  // The card holds until the video's end.
  expect(await shotAt(page, videoEnd - 1)).toBe(card);

  // A Window change moves the zoom's start, never the card.
  await setRange(page, 'export-window', 300);
  await expect(page.getByTestId('export-window-value')).not.toHaveText('One row');
  expect(await shotAt(page, videoEnd)).toBe(card);

  // Playing runs on through the ending to the card (WebKit can't mute here: no play).
  if (browserName !== 'webkit') {
    for (let run = 0; run < 2; run++) {
      await seekPreview(page, end - 1.5);
      await page.getByTestId('preview-play').click();
      await expect(page.getByTestId('preview-play')).toHaveAttribute('data-playing', 'false', {
        timeout: 20_000,
      });
      await expect
        .poll(async () => Number(await playhead.getAttribute('data-t')))
        .toBeCloseTo(videoEnd, 1);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
      expect((await previewShot(page)).h, `play ${run + 1}`).toBe(card);
    }
  }

  // The export draws the same ending (its frames, on the main thread): the last frames are the
  // card, a frame a second into the ending is the zoom between the last frame and the card.
  const frames = await page.evaluate(async () => {
    const h = (window as unknown as HookWindow).__algorhythms;
    const req = (await h.exportRun()).lastPreviewRequest();
    if (req?.kind !== 'video') return null;
    const ve = await h.videoExport();
    const piece = h.store.getState().piece as unknown as Parameters<typeof ve.referenceFrame>[0];
    const o = { ...req.options, size: '720' as const, fps: 30 as const };
    const D = h.store.getState().compiled.duration;
    const hash = (k: number) => {
      const d = ve.referenceFrame(piece, o, k).data;
      let x = 0;
      for (let i = 0; i < d.length; i += 4) x = (x * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0;
      return x;
    };
    const k = (s: number) => Math.round(s * 30);
    return {
      before: hash(k(D - 0.1)),
      zoom: hash(k(D + 1)),
      card: hash(k(D + 4)),
      card2: hash(k(D + 4.5)),
    };
  });
  expect(frames).not.toBeNull();
  expect(frames!.card).toBe(frames!.card2);
  expect(new Set([frames!.before, frames!.zoom, frames!.card]).size).toBe(3);
});

test('the section’s times read as text, never clipped; a click edits one', async ({ page }) => {
  await posterPiece(page, 3);
  await choose(page, 'export-section', 'Custom');
  const start = page.getByTestId('section-start-text');
  const end = page.getByTestId('section-end-text');
  const fits = (el: typeof start) =>
    el.evaluate((e) => {
      const i = e as HTMLInputElement;
      const cs = getComputedStyle(i);
      return {
        fits: i.scrollWidth <= i.clientWidth + 1,
        dims: `${i.value} ${i.scrollWidth}/${i.clientWidth} ${cs.font} ${cs.width} ${cs.paddingLeft}`,
        border: cs.borderTopColor,
        bg: cs.backgroundColor,
      };
    });
  for (const el of [start, end]) {
    const f = await fits(el);
    expect(f.fits, f.dims).toBe(true);
    // Text, not a box, until it's clicked.
    expect(f.border).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
  // A click edits it: Enter commits, Escape cancels, Tab reaches it.
  await start.click();
  await expect(start).toBeFocused();
  await page.keyboard.type('1:05.5');
  await page.keyboard.press('Enter');
  await expect(start).toHaveValue(/^1:0[45]\.\d$/);
  expect((await fits(start)).fits).toBe(true);
  const span = (await previewOptions(page))!.section!;
  expect(span.start).toBeGreaterThan(60);
  await end.click();
  await page.keyboard.type('9');
  await page.keyboard.press('Escape');
  await expect(end).not.toHaveValue('9');
  expect((await previewOptions(page))!.section).toEqual(span);
  await start.focus();
  await page.keyboard.press('Tab');
  await expect(end).toBeFocused();
});

test('the timeline’s strip moves the preview; Play sits under it on the right; no slider', async ({
  page,
}) => {
  await posterPiece(page, 3);
  const D = await page.evaluate(
    () => (window as unknown as HookWindow).__algorhythms.store.getState().compiled.duration,
  );
  await expect(page.getByTestId('export-preview').locator('input[type="range"]')).toHaveCount(0);
  // Play: under the preview, at its right.
  const canvas = (await page.getByTestId('preview-canvas').boundingBox())!;
  const play = (await page.getByTestId('preview-play').boundingBox())!;
  expect(play.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  expect(play.x + play.width).toBeGreaterThan(canvas.x + canvas.width * 0.75);

  const strip = page.getByTestId('section-range');
  const b = (await strip.boundingBox())!;
  const tNow = async () =>
    Number(await page.getByTestId('timeline-playhead').getAttribute('data-t'));
  const canvasT = async () =>
    Number(await page.getByTestId('preview-canvas').getAttribute('data-t'));
  // A press seeks there; dragging scrubs.
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height / 2);
  await expect.poll(tNow).toBeCloseTo(D * 0.5, 0);
  await expect.poll(canvasT).toBeCloseTo(D * 0.5, 0);
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2, { steps: 5 });
  await expect.poll(tNow).toBeCloseTo(D * 0.7, 0);
  await page.mouse.up();
  // The handles still move the section (Whole → Custom), not the preview.
  const handle = (await page.getByTestId('section-end').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(
    videoWorkspace(page).getByTestId('export-section').getByLabel('Custom', { exact: true }),
  ).toBeChecked();
  // The keyboard: the playhead is a slider (arrows a second, Shift ten, Home / End).
  const ph = page.getByTestId('timeline-playhead');
  await ph.focus();
  await page.keyboard.press('Home');
  await expect.poll(tNow).toBeCloseTo(0, 3);
  await page.keyboard.press('ArrowRight');
  await expect.poll(tNow).toBeCloseTo(1, 3);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(tNow).toBeCloseTo(11, 3);
  await expect(ph).toHaveAttribute('aria-valuetext', /0:11|00:11/);
  await expect.poll(canvasT).toBeCloseTo(11, 3);
});
