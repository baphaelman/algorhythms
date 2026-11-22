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
    const dlg = q('export-dialog') as HTMLDialogElement | null;
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
      dialogOpen: dlg?.open === true,
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
