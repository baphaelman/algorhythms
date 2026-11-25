/**
 * Export dialog e2e helpers with diagnostics: what lies over a control, and why Export did not
 * start a download (CI v61 macOS WebKit failures). On failure they print the element at the
 * control's centre and the boxes of the preview, HUD checklist, Export button and dialog.
 */

import { expect, type Download, type Page } from '@playwright/test';

export interface HitReport {
  ok: boolean;
  testId: string;
  /** The element at the control's centre (tag#id.class[data-testid]). */
  at: string;
  dialogOpen: boolean;
  focused: string;
  scrollTop: number;
  boxes: Record<string, { x: number; y: number; w: number; h: number } | null>;
}

/**
 * Scrolls the control into view as the browser does for focus (`block: 'nearest'`, honouring
 * scroll-padding), then hit-tests its centre.
 */
export function hitTest(page: Page, testId: string): Promise<HitReport> {
  return page.evaluate((id) => {
    const q = (t: string) => document.querySelector<HTMLElement>(`[data-testid="${t}"]`);
    const name = (e: Element | null) =>
      e
        ? `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${
            e.getAttribute('class')
              ? `.${e.getAttribute('class')!.trim().replace(/\s+/g, '.')}`
              : ''
          }${e.getAttribute('data-testid') ? `[${e.getAttribute('data-testid')}]` : ''}`
        : 'null';
    const box = (e: Element | null) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const el = q(id);
    const dlg = (q('export-dialog') as HTMLDialogElement | null) ?? q('video-workspace');
    let at: Element | null = null;
    if (el) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    }
    return {
      ok: !!el && !!at && (at === el || el.contains(at)),
      testId: id,
      at: name(at),
      dialogOpen: dlg !== null && (!(dlg instanceof HTMLDialogElement) || dlg.open),
      focused: name(document.activeElement),
      scrollTop: Math.round(dlg?.scrollTop ?? 0),
      boxes: {
        target: box(el),
        preview: box(q('export-preview')),
        hud: box(q('look-hud')),
        exportRun: box(q('export-run')),
        dialog: box(dlg),
        viewport: { x: 0, y: 0, w: innerWidth, h: innerHeight },
      },
    };
  }, testId);
}

/** Expects nothing to lie over the control; the message carries the hit report. */
export async function expectUncovered(page: Page, testId: string, what = testId): Promise<void> {
  const r = await hitTest(page, testId);
  expect(r.ok, `${what} covered: ${JSON.stringify(r)}`).toBe(true);
}

/**
 * Clicks Export and waits for the download. If none has started after 5 s, logs a hit report
 * of the Export button (once), so a timeout says what was over it or whether the dialog closed.
 */
export async function clickExportForDownload(page: Page, timeout = 60_000): Promise<Download> {
  let done = false;
  const wait = page.waitForEvent('download', { timeout });
  const timer = setTimeout(() => {
    if (done) return;
    hitTest(page, 'export-run').then(
      (r) => console.log(`[export-diag] no download after 5 s: ${JSON.stringify(r)}`),
      () => undefined,
    );
  }, 5_000);
  try {
    const [dl] = await Promise.all([wait, page.getByTestId('export-run').click({ timeout })]);
    return dl;
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Hang guard (CI v62 macOS WebKit: `check()` on a HUD checkbox clicked, then never returned)
// ---------------------------------------------------------------------------------------------

/**
 * What the page says now, or that it does not answer within 2 s: the main thread answers, the
 * preview's draws and its measure / scroll-padding callback counts (debug hook), the focused
 * element, whether the dialog is open and the HUD expanded.
 */
export async function pageState(page: Page): Promise<string> {
  const probe = page
    .evaluate(() => {
      const q = (t: string) => document.querySelector<HTMLElement>(`[data-testid="${t}"]`);
      const a = document.activeElement;
      const h = (window as { __algorhythms?: { exportPreview?: unknown } }).__algorhythms;
      return {
        answered: true,
        draws: q('preview-canvas')?.dataset.draws ?? null,
        stats: h?.exportPreview ?? null,
        focused: a
          ? `${a.tagName.toLowerCase()}${a.getAttribute('data-testid') ? `[${a.getAttribute('data-testid')}]` : ''}`
          : 'null',
        dialogOpen: (q('export-dialog') as HTMLDialogElement | null)?.open === true,
        hudExpanded: q('look-hud-button')?.getAttribute('aria-expanded') ?? null,
        scrollTop: Math.round(q('export-dialog')?.scrollTop ?? 0),
      };
    })
    .catch((e: unknown) => ({ answered: false, error: String(e) }));
  const late = new Promise<{ answered: false; error: string }>((r) =>
    setTimeout(() => r({ answered: false, error: 'no answer in 2 s' }), 2_000),
  );
  return JSON.stringify(await Promise.race([probe, late]));
}

/**
 * Runs a Playwright action; if it has not resolved after `ms`, logs the page's state (once) and
 * keeps waiting, so a hang in CI says whether the main thread is stuck and in what.
 */
export async function guarded<T>(
  page: Page,
  what: string,
  action: () => Promise<T>,
  ms = 5_000,
): Promise<T> {
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    void pageState(page).then((s) => {
      if (!done) console.log(`[export-diag] ${what}: not done after ${ms / 1000} s: ${s}`);
    });
  }, ms);
  try {
    return await action();
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

/** Clicks a control (guarded). */
export function tap(page: Page, testId: string): Promise<void> {
  return guarded(page, `click ${testId}`, () => page.getByTestId(testId).click());
}

/**
 * Sets a switch or checkbox by clicking it (not `check()`, which hung silently on macOS WebKit)
 * and polls its state, each step guarded.
 */
export async function setSwitch(page: Page, testId: string, on: boolean): Promise<void> {
  const el = page.getByTestId(testId);
  const state = () => guarded(page, `isChecked ${testId}`, () => el.isChecked());
  if ((await state()) !== on) await tap(page, testId);
  await expect.poll(state, { message: testId }).toBe(on);
}

/** Sets a slider's value (guarded) and expects it. */
export async function setRange(page: Page, testId: string, value: number): Promise<void> {
  const el = page.getByTestId(testId);
  await guarded(page, `fill ${testId}`, () => el.fill(String(value)));
  await expect(el).toHaveValue(String(value));
}

/** Picks a segment of a Look segmented control by its label (guarded click) and expects it. */
export async function chooseSegment(page: Page, testId: string, label: string): Promise<void> {
  const input = page.getByTestId(testId).getByLabel(label, { exact: true });
  await guarded(page, `segment ${testId} ${label}`, () => input.click());
  await expect(input).toBeChecked();
}

/** Expands (or collapses) the HUD readout list with its row (guarded) and waits for the end state. */
export async function setHudOpen(page: Page, open: boolean): Promise<void> {
  const b = page.getByTestId('look-hud-button');
  if ((await b.getAttribute('aria-expanded')) !== String(open)) await tap(page, 'look-hud-button');
  await expect(b).toHaveAttribute('aria-expanded', String(open));
  const list = page.getByTestId('look-hud');
  if (open) await expect(list).toBeVisible();
  else await expect(list).toBeHidden();
  // The height animation has ended (positions are final).
  await expect
    .poll(() =>
      guarded(page, 'HUD animations', () => list.evaluate((el) => el.getAnimations().length)),
    )
    .toBe(0);
}
