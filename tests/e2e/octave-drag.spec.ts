/**
 * Shift-drag moves by octaves (PLAN.md §11.3, owner 2026-11-21; M4.5-33): Shift-dragging a chord
 * dot moves it by exactly 12 semitones with guides and a "+1 oct" label, Shift switches live
 * mid-drag, one undo restores; Alt-drag is chromatic; Shift+▲ steps a selected dot an octave.
 * Chromium only.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough here');

interface M {
  id: string;
  type: string;
  frozenFrom?: unknown;
  notes?: { kind: string; pitches?: number[] };
}

interface EditorHook {
  editor: {
    undo(): boolean;
    select(ids: string[]): void;
    state: { getState(): { undoLabel: string } };
  };
  store: { getState(): { piece: { moments: M[] } } };
}

const chord = (page: Page): Promise<M> =>
  page.evaluate(() =>
    (window.__algorhythms as unknown as EditorHook).store
      .getState()
      .piece.moments.find((m) => m.id === 'chord1')!,
  );
const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().undoLabel,
  );
const select = (page: Page, ids: string[]) =>
  page.evaluate((i) => (window.__algorhythms as unknown as EditorHook).editor.select(i), ids);
const undo = (page: Page) =>
  page.evaluate(() => (window.__algorhythms as unknown as EditorHook).editor.undo());

/** Four voices (C3 G3 C4 E4) in C major; an Am chord at 4. */
async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
  await page.evaluate(() => {
    const h = window.__algorhythms!;
    const p = structuredClone(h.store.getState().piece) as unknown as {
      voices: { id: string }[];
      start: { voice: string; pitch: number }[];
      moments: unknown[];
      key: unknown;
      end: unknown;
      defaults: { glide: Record<string, unknown> };
    };
    p.start = [48, 55, 60, 64].map((pitch, i) => ({ voice: p.voices[i].id, pitch }));
    p.defaults.glide = { ...p.defaults.glide, length: 2, stagger: 0, jitter: 0 };
    p.moments = [
      {
        id: 'chord1',
        type: 'chord',
        at: 4,
        notes: { kind: 'chord', symbol: 'Am' },
        voicing: 'even',
        assign: 'ordered',
      },
    ];
    p.key = { tonic: 'C', scale: 'major' };
    p.end = { at: 16, fade: 2 };
    h.actions.loadPiece(p);
  });
  await seek(page, 0);
  await page.getByTestId('zoom-fit').click();
  await select(page, ['chord1']);
  await expect(page.getByTestId('chord-dot').first()).toBeVisible();
}

async function center(dot: Locator): Promise<{ x: number; y: number }> {
  const b = (await dot.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The chord's dots (pitch, centre), low to high, and the screen px per semitone. */
async function chordDots(page: Page) {
  const loc = page.getByTestId('chord-dot');
  const n = await loc.count();
  const out: { pitch: number; x: number; y: number; loc: Locator }[] = [];
  for (let i = 0; i < n; i++) {
    const d = loc.nth(i);
    out.push({ pitch: Number(await d.getAttribute('data-pitch')), ...(await center(d)), loc: d });
  }
  out.sort((a, b) => a.pitch - b.pitch);
  const lo = out[0];
  const hi = out[out.length - 1];
  return { dots: out, semi: (lo.y - hi.y) / (hi.pitch - lo.pitch) };
}

const sorted = (ps: number[]) => [...ps].sort((a, b) => a - b);

test.beforeEach(async ({ page }) => {
  await open(page);
});

test('Shift-drag moves a chord dot by exactly an octave, with guides and a label; one undo', async ({
  page,
}) => {
  const { dots, semi } = await chordDots(page);
  const before = dots.map((d) => d.pitch);
  const d = dots[0];
  const label = page.getByTestId('octave-label');
  const guides = page.locator('[data-testid=octave-guide]:not([hidden])');

  await page.mouse.move(d.x, d.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  // About an octave up, a little past it.
  await page.mouse.move(d.x, d.y - 6 * semi, { steps: 4 });
  await page.mouse.move(d.x, d.y - 13 * semi, { steps: 4 });
  await expect(label).toBeVisible();
  await expect(label).toHaveText('+1 oct');
  expect(await guides.count()).toBeGreaterThanOrEqual(2);
  // The guides sit on the start pitch's octaves.
  const gp = await guides.evaluateAll((els) => els.map((e) => Number(e.dataset.pitch)));
  expect(gp).toContain(d.pitch);
  expect(gp).toContain(d.pitch + 12);
  expect(gp.every((p) => (p - d.pitch) % 12 === 0)).toBe(true);

  // Releasing Shift mid-drag switches to the key at once; pressing it again back to octaves.
  await page.keyboard.up('Shift');
  await expect(label).toBeHidden();
  await expect(guides).toHaveCount(0);
  await page.keyboard.down('Shift');
  await expect(label).toHaveText('+1 oct');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(label).toBeHidden();

  const c = await chord(page);
  expect(c.frozenFrom).toBeDefined();
  expect(sorted(c.notes!.pitches!)).toEqual(sorted([d.pitch + 12, ...before.slice(1)]));
  expect(await undoLabel(page)).toBe('Freeze chord and move note');
  await undo(page);
  const back = await chord(page);
  expect(back.frozenFrom).toBeUndefined();
  expect(back.notes).toEqual({ kind: 'chord', symbol: 'Am' });
});

test('Alt-drag is chromatic', async ({ page }) => {
  const { dots, semi } = await chordDots(page);
  // A dot whose semitone up is off the C major scale (A → A♯, C → C♯).
  const off = new Set([1, 3, 6, 8, 10]);
  const d = dots.find((x) => off.has((x.pitch + 1) % 12))!;
  expect(d).toBeDefined();
  await page.mouse.move(d.x, d.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(d.x, d.y - 0.5 * semi, { steps: 3 });
  await page.mouse.move(d.x, d.y - semi, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const c = await chord(page);
  expect(c.notes!.pitches).toContain(d.pitch + 1);
  expect(c.notes!.pitches).not.toContain(d.pitch);
});

test('Shift+▲ steps a selected dot an octave; Shift-click still toggles it', async ({ page }) => {
  const { dots } = await chordDots(page);
  const d = dots[0];
  const picked = page.locator('[data-testid=chord-dot][data-picked=true]');
  await page.mouse.click(d.x, d.y);
  await expect(picked).toHaveCount(1);
  await page.keyboard.press('Shift+ArrowUp');
  await expect(picked).toHaveCount(1);
  await expect(picked).toHaveAttribute('data-pitch', String(d.pitch + 12));
  expect((await chord(page)).notes!.pitches).toContain(d.pitch + 12);
  // Shift-click without moving removes it from the selection.
  const p = await center(picked);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await expect(picked).toHaveCount(0);
});
