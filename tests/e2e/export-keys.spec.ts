/**
 * The export surfaces' interactions pass (PLAN.md §12 "UI and interactions", §15 M11, M14): the
 * video dialog and the poster workspace by keyboard alone (focus order, visible focus, Escape,
 * focus kept when the focused control goes away), the preview redrawing after every control, and
 * the layout at 1280, 1440, 1920 px and a narrow window, light and dark.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  backToMusic,
  escapeOut,
  openPoster,
  openVideoExport,
  surface,
  switchMode,
  workspace,
} from './export-open';

/** The workspace's Video mode (M15: the old Export dialog's place). */
const dialog = (page: Page) => page.getByTestId('video-workspace');

async function load(page: Page): Promise<void> {
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

/** The video dialog (Menu → Export → Video) or the poster workspace (→ Poster). */
async function openDialog(page: Page, format: 'Video (MP4)' | 'Poster'): Promise<void> {
  if (format === 'Poster') {
    await openPoster(page);
    return;
  }
  await openVideoExport(page);
  await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
}

/** The focused element: its test id (or the nearest one's), tag and type. */
async function focused(page: Page): Promise<{ id: string; tag: string; type: string }> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return {
      id:
        a?.getAttribute('data-testid') ??
        a?.closest('[data-testid]')?.getAttribute('data-testid') ??
        '',
      tag: a?.tagName ?? '',
      type: (a as HTMLInputElement | null)?.type ?? '',
    };
  });
}

const draws = (page: Page) =>
  page.evaluate(() =>
    Number(document.querySelector('[data-testid=preview-canvas]')?.getAttribute('data-draws')),
  );

test('the whole video dialog by keyboard alone: order, visible focus, Escape', async ({
  page,
  browserName,
}) => {
  test.setTimeout(60_000);
  // macOS WebKit's Tab skips buttons (the system's "Keyboard navigation" off); Option-Tab doesn't.
  const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page);
  // Menu → Export, by keys.
  await page.getByTestId('menu-button').focus();
  await page.keyboard.press('Enter');
  for (let i = 0; i < 30 && (await focused(page)).id !== 'open-export'; i++) {
    await page.keyboard.press(TAB);
  }
  await page.keyboard.press('Enter');
  // The poster workspace opens on Poster | Video; the arrow picks Video (the dialog, until M15).
  await expect(workspace(page)).toBeVisible();
  await expect.poll(async () => (await focused(page)).id).toBe('export-mode');
  await page.keyboard.press('ArrowRight');
  await expect(dialog(page)).toBeVisible();
  await expect.poll(async () => (await focused(page)).id).toBe('export-mode');
  await expect(page.getByTestId('export-mode').getByLabel('Video')).toBeChecked();
  await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  // Open the collapsible groups by keys, so every control is a stop.
  for (const id of ['look-hud-button', 'bookends-button']) {
    await page.getByTestId(id).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(id)).toHaveAttribute('aria-expanded', 'true');
  }
  // From Poster | Video (in the top bar), Tab enters the workspace.
  await page.getByTestId('export-mode').getByLabel('Video').focus();
  const inside = () =>
    page.evaluate(() => {
      const d = document.querySelector('[data-testid=video-workspace]')!;
      return d.contains(document.activeElement) && document.activeElement !== d;
    });
  for (let i = 0; i < 10 && !(await inside()); i++) await page.keyboard.press(TAB);

  interface Stop {
    id: string;
    x: number;
    y: number;
    ring: boolean;
  }
  const stops: Stop[] = [];
  for (let i = 0; i < 200; i++) {
    const s = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      const d = document.querySelector<HTMLElement>('[data-testid=video-workspace]')!;
      if (!d.contains(a) || a === d) return null;
      // The ring is on the control, or on the segment label of a visually hidden radio/checkbox.
      const shows = (el: Element) => {
        const st = getComputedStyle(el);
        return (
          (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 1) ||
          /\d+px/.test(st.boxShadow)
        );
      };
      const seg = a.closest('.seg label');
      const r = a.getBoundingClientRect();
      // Each panel scrolls on its own: positions in its content.
      const panel = a.closest<HTMLElement>('.ws-side, .ws-bottom');
      return {
        id:
          a.getAttribute('data-testid') ??
          a.closest('[data-testid]')?.getAttribute('data-testid') ??
          a.tagName,
        x: r.left,
        y: r.top + d.scrollTop + (panel?.scrollTop ?? 0),
        ring: shows(a) || (seg !== null && shows(seg)),
      };
    });
    if (!s) break;
    stops.push(s);
    await page.keyboard.press(TAB);
  }
  const ids = stops.map((s) => s.id);
  // Every group in order (M15): the stage (HUD boxes, play, time), the options panel top to
  // bottom (the look is Poster's), then the timeline, ending on Export MP4.
  const order = [
    'hud-box-formula',
    'preview-play',
    'preview-time',
    'export-preset',
    'export-aspect',
    'export-vsize',
    'export-quality',
    'video-frame',
    'export-camera',
    'look-future',
    'look-hud-button',
    'hud-formula',
    'export-loudness',
    'bookends-button',
    'vb-fade-in',
    'vb-title-card',
    'vb-end-card',
    'export-thumbnail',
    'export-description',
    'export-section',
    'card-music',
    'export-run',
  ];
  const at = order.map((id) => ids.indexOf(id));
  expect(
    at.every((i) => i >= 0),
    `missing: ${order.filter((_, k) => at[k] < 0)}`,
  ).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(stops.length).toBeGreaterThan(30);
  // Each stop shows a ring.
  expect(stops.filter((s) => !s.ring).map((s) => s.id)).toEqual([]);
  // The options panel reads top to bottom.
  const opts = stops.slice(ids.indexOf('export-preset'), ids.indexOf('export-section'));
  for (let k = 1; k < opts.length; k++) {
    expect(opts[k].y, `${opts[k - 1].id} → ${opts[k].id}`).toBeGreaterThanOrEqual(
      opts[k - 1].y - 40,
    );
  }
  // Escape leaves the focused control, then the workspace; focus returns to the menu button.
  await escapeOut(page);
  await expect(page.getByTestId('menu-button')).toBeFocused();
});

test('every control by keyboard redraws the preview and keeps focus in the workspace', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page);
  await openDialog(page, 'Video (MP4)');
  const key = (k: string) => page.keyboard.press(k);
  const radio = (id: string, label: string) =>
    surface(page).getByTestId(id).getByLabel(label, { exact: true }).focus();
  const at = (id: string) => page.getByTestId(id).focus();
  /**
   * M15: the look's controls are Poster's, the moving ones Video's; each mode's preview redraws.
   * Back in Video, One row (a poster edit would make Over the poster the frame).
   */
  const mode = async (m: 'Poster' | 'Video') => {
    await switchMode(page, m);
    await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
    if (m === 'Video') {
      const row = dialog(page).getByTestId('video-frame').getByLabel('One row', { exact: true });
      if (!(await row.isChecked())) await row.click();
      await expect(row).toBeChecked();
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  };
  /** Runs `act`, then expects a redraw and focus on `on` (default: the control acted on). */
  const step = async (name: string, act: () => Promise<void>, on?: string, redraw = true) => {
    const before = await draws(page);
    const was = (await focused(page)).id;
    await act();
    const want = on ?? (await focused(page)).id;
    await expect.poll(async () => (await focused(page)).id, name).toBe(want);
    expect((await focused(page)).tag, name).not.toBe('BODY');
    if (redraw) await expect.poll(() => draws(page), name).toBeGreaterThan(before);
    void was;
  };

  // Enter chooses a focused segment (Space plays the preview here).
  await step(
    'preset YouTube (Enter)',
    async () => {
      await radio('export-preset', 'YouTube');
      await key('Enter');
    },
    'export-preset',
  );
  await expect(dialog(page).getByTestId('export-preset').getByLabel('YouTube')).toBeChecked();
  await step(
    'section Custom',
    async () => {
      await radio('export-section', 'Whole piece');
      await key('ArrowRight');
    },
    'export-section',
  );
  await step(
    'section start handle',
    async () => {
      await at('section-start');
      await key('ArrowRight');
    },
    'section-start',
  );
  await step(
    'section end typed',
    async () => {
      await at('section-end-text');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('0:40');
      await key('Enter');
    },
    'section-end-text',
  );
  await step(
    'aspect 9:16',
    async () => {
      await radio('export-aspect', '16:9');
      await key('ArrowRight');
    },
    'export-aspect',
  );
  await step('aspect 16:9', () => key('ArrowLeft'), 'export-aspect');
  await step(
    'size',
    async () => {
      await radio('export-vsize', '1080p');
      await key('ArrowLeft');
    },
    'export-vsize',
    false,
  );
  // Auto (a piece without a camera) to Follow: the piece's camera mode changes.
  await step(
    'camera Follow',
    async () => {
      await radio('export-camera', 'Auto');
      await key('ArrowLeft');
    },
    'export-camera',
  );
  await step('camera Auto', () => key('ArrowRight'), 'export-camera');
  await step('camera Follow again', () => key('ArrowLeft'), 'export-camera');
  await step(
    'window',
    async () => {
      await at('export-window');
      await key('ArrowLeft');
    },
    'export-window',
  );
  await mode('Poster');
  await step(
    'theme Dark',
    async () => {
      await radio('export-vtheme', 'Light');
      await key('ArrowRight');
    },
    'export-vtheme',
  );
  await step(
    'guides',
    async () => {
      await radio('look-guides', 'Off');
      await key('ArrowRight');
    },
    'look-guides',
  );
  await step(
    'beats',
    async () => {
      await radio('look-beats', 'Off');
      await key('ArrowRight');
    },
    'look-beats',
  );
  await mode('Video');
  await step(
    'ahead',
    async () => {
      await at('look-future');
      await key('ArrowRight');
    },
    'look-future',
  );
  await step(
    'playhead switch (Enter)',
    async () => {
      await at('look-playhead');
      await key('Enter');
    },
    'look-playhead',
  );
  await step(
    'rings (Enter)',
    async () => {
      await at('look-heads-rings');
      await key('Enter');
    },
    'look-heads-rings',
  );
  await mode('Poster');
  await step(
    'width',
    async () => {
      await at('look-width');
      await key('ArrowRight');
    },
    'look-width',
  );
  await step(
    'glow',
    async () => {
      await at('look-glow');
      await key('End');
    },
    'look-glow',
  );
  await step(
    'vignette',
    async () => {
      await at('look-vignette');
      await key('End');
    },
    'look-vignette',
  );
  // A pick turns into a chip: focus stays in the guide row.
  await step('guide pick', async () => {
    await page.locator('[data-testid^=look-pitch-pick-]').first().focus();
    await key('Enter');
  });
  expect((await focused(page)).id).toMatch(/^look-pitch-/);
  await step(
    'guide typed',
    async () => {
      await at('look-pitch-input');
      await page.keyboard.type('E4');
      await key('Enter');
    },
    'look-pitch-input',
  );
  // Removing a chip moves focus to its neighbour.
  await step('guide chip ×', async () => {
    await at('look-pitch-64');
    await key('Enter');
  });
  expect((await focused(page)).id).toMatch(/^look-pitch-/);
  await mode('Video');
  await step(
    'HUD open',
    async () => {
      await at('look-hud-button');
      await key('Enter');
    },
    'look-hud-button',
    false,
  );
  await step(
    'HUD readout off',
    async () => {
      await at('hud-chord');
      await key('Enter');
    },
    'hud-chord',
  );
  await step(
    'HUD box by arrows',
    async () => {
      await at('hud-box-time');
      await key('Shift+ArrowUp');
    },
    'hud-box-time',
  );
  // Reset layout disables itself: focus moves to Default beside it.
  await step(
    'Reset layout',
    async () => {
      await at('hud-reset-layout');
      await key('Enter');
    },
    'hud-default',
  );
  await mode('Poster');
  await step(
    'scheme Night',
    async () => {
      await at('scheme-night');
      await key('Enter');
    },
    'scheme-night',
  );
  await step(
    'save scheme',
    async () => {
      await at('colours-scheme-name');
      await page.keyboard.type('Mine');
      await key('Enter');
    },
    'colours-scheme-name',
    false,
  );
  // Deleting a saved scheme: focus goes to the scheme before it, not the page.
  await step(
    'delete scheme',
    async () => {
      await at('scheme-delete-Mine');
      await key('Enter');
    },
    'scheme-mono',
    false,
  );
  await expect(page.getByTestId('scheme-saved-Mine')).toHaveCount(0);
  await step(
    'background Solid',
    async () => {
      await radio('look-bg', 'Theme');
      await key('ArrowRight');
    },
    'look-bg',
  );
  await step('background Gradient', () => key('ArrowRight'), 'look-bg');
  await step(
    'gradient shape',
    async () => {
      await page.getByTestId('bg-shape').locator('input:checked').focus();
      await key('ArrowRight');
    },
    'bg-shape',
  );
  await step(
    'lines One',
    async () => {
      await radio('look-colors', 'One');
      await key('Enter');
    },
    'look-colors',
  );
  await step(
    'HUD hex',
    async () => {
      await at('swatch-hud-hex');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('#ff0000');
      await key('Enter');
    },
    'swatch-hud-hex',
  );
  // Default hides itself: focus moves to the swatch's hex field.
  await step(
    'HUD colour Default',
    async () => {
      await at('swatch-hud-reset');
      await key('Enter');
    },
    'swatch-hud-hex',
  );
  await mode('Video');
  // The YouTube preset opened Opening & ending; Enter closes and reopens it.
  for (const want of ['false', 'true']) {
    await at('bookends-button');
    await key('Enter');
    await expect(page.getByTestId('bookends-button')).toHaveAttribute('aria-expanded', want);
  }
  await step(
    'fade in',
    async () => {
      await at('vb-fade-in');
      await key('ArrowRight');
    },
    'vb-fade-in',
  );
  await step(
    'lead-in',
    async () => {
      await at('vb-lead-in');
      await key('ArrowRight');
    },
    'vb-lead-in',
  );
  await step(
    'fade out',
    async () => {
      await at('vb-fade-out');
      await key('ArrowRight');
    },
    'vb-fade-out',
  );
  await step(
    'title typed',
    async () => {
      await at('vb-title');
      await page.keyboard.type('!');
      await key('Enter');
    },
    'vb-title',
  );
  await step(
    'end card',
    async () => {
      await page.getByTestId('vb-end-card').locator('input:checked').focus();
      // WebKit's arrows stop at the ends of a radio group: move away from the end we're at.
      const last = await page
        .getByTestId('vb-end-card')
        .locator('input')
        .last()
        .evaluate((el) => (el as HTMLInputElement).checked);
      await key(last ? 'ArrowLeft' : 'ArrowRight');
    },
    'vb-end-card',
  );
  await step(
    'preview time',
    async () => {
      await at('preview-time');
      await key('ArrowLeft');
    },
    'preview-time',
  );
  await mode('Poster');
  await step(
    'look reset',
    async () => {
      await at('look-reset');
      await key('Enter');
    },
    'look-reset',
  );
  // Nothing above started an export (Enter never submits from a control).
  await expect(page.getByTestId('export-progress')).toHaveCount(0);
  await expect(page.getByTestId('export-message')).toHaveCount(0);
});

test('the poster workspace by keyboard alone: order, visible focus, Escape back to music', async ({
  page,
  browserName,
}) => {
  test.setTimeout(60_000);
  const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page);
  await page.getByTestId('menu-button').focus();
  await page.keyboard.press('Enter');
  for (let i = 0; i < 30 && (await focused(page)).id !== 'open-export'; i++) {
    await page.keyboard.press(TAB);
  }
  await page.keyboard.press('Enter');
  await expect(workspace(page)).toBeVisible();
  await expect.poll(async () => (await focused(page)).id).toBe('export-mode');
  await expect(page.getByTestId('preview-canvas')).toHaveAttribute('data-draws', /\d+/);
  // Shift+Tab reaches Back to music, before the mode.
  await page.keyboard.press(`Shift+${TAB}`);
  await expect.poll(async () => (await focused(page)).id).toBe('back-to-music');
  await page.keyboard.press(TAB);
  await page.getByTestId('look-hud-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('look-hud-button')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('export-psize').locator('input:checked').focus();

  const stops: { id: string; ring: boolean }[] = [];
  for (let i = 0; i < 200; i++) {
    const s = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      const ws = document.querySelector<HTMLElement>('[data-testid=poster-workspace]')!;
      if (!ws.contains(a) || a === ws) return null;
      const shows = (el: Element) => {
        const st = getComputedStyle(el);
        return (
          (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 1) ||
          /\d+px/.test(st.boxShadow)
        );
      };
      const seg = a.closest('.seg label');
      return {
        id:
          a.getAttribute('data-testid') ??
          a.closest('[data-testid]')?.getAttribute('data-testid') ??
          a.tagName,
        ring: shows(a) || (seg !== null && shows(seg)),
      };
    });
    if (!s) break;
    stops.push(s);
    await page.keyboard.press(TAB);
  }
  const ids = stops.map((s) => s.id);
  // The options top to bottom, Export, then the tools and the layers.
  const order = [
    'export-psize',
    'export-pwidth',
    'export-pheight',
    'export-pformat',
    'export-section',
    'export-prows',
    'export-vtheme',
    'margin-all',
    'show-sectionLabels',
    'look-guides',
    'look-glow',
    'look-hud-button',
    'hud-formula',
    'look-bg',
    'look-reset',
    'export-run',
    'tool-select',
    'layer-text-row',
    'layer-part-row',
  ];
  const at = order.map((id) => ids.indexOf(id));
  expect(
    at.every((i) => i >= 0),
    `missing: ${order.filter((_, k) => at[k] < 0)}`,
  ).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(stops.filter((s) => !s.ring).map((s) => s.id)).toEqual([]);
  // Escape lets go of the focused control, then returns to the music; focus on the menu.
  await page.getByTestId('export-prows').focus();
  await page.keyboard.press('Escape');
  await expect(workspace(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(workspace(page)).toBeHidden();
  await expect(page.getByTestId('menu-button')).toBeFocused();
});

test('poster controls by keyboard redraw the preview', async ({ page }) => {
  // Space plays and pauses in the workspace (M14), so switches take Enter.
  await load(page);
  await openDialog(page, 'Poster');
  const step = async (name: string, act: () => Promise<void>, on: string) => {
    const before = await draws(page);
    await act();
    await expect.poll(() => draws(page), name).toBeGreaterThan(before);
    await expect.poll(async () => (await focused(page)).id, name).toBe(on);
  };
  await step(
    'rows',
    async () => {
      await page.getByTestId('export-prows').focus();
      await page.keyboard.press('ArrowRight');
    },
    'export-prows',
  );
  await step(
    'size quick pick',
    async () => {
      await page.getByTestId('export-psize').locator('input:checked').focus();
      await page.keyboard.press('ArrowRight');
    },
    'export-psize',
  );
  await step(
    'width',
    async () => {
      await page.getByTestId('export-pwidth').focus();
      await page.keyboard.press('PageDown');
    },
    'export-pwidth',
  );
  await step(
    'margins',
    async () => {
      await page.getByTestId('margin-all').focus();
      await page.keyboard.press('ArrowRight');
    },
    'margin-all',
  );
  await step(
    'section lines',
    async () => {
      await page.getByTestId('show-sectionLines').focus();
      await page.keyboard.press('Enter');
    },
    'show-sectionLines',
  );
  await step(
    'section Custom',
    async () => {
      await page.getByTestId('export-section').getByLabel('Whole piece').focus();
      await page.keyboard.press('ArrowRight');
    },
    'export-section',
  );
  await step(
    'piece range',
    async () => {
      await page.getByTestId('export-prange').focus();
      await page.keyboard.press('Enter');
    },
    'export-prange',
  );
  await step(
    'background Transparent',
    async () => {
      // Transparent is last (WebKit's arrows don't wrap from the first).
      await page.getByTestId('look-bg').getByLabel('Gradient').focus();
      await page.keyboard.press('ArrowRight');
    },
    'look-bg',
  );
});

test('HUD boxes follow the frame when the size changes', async ({ page }) => {
  await load(page);
  await openDialog(page, 'Video (MP4)');
  const boxes = () =>
    page.evaluate(() => {
      const o = document.querySelector<HTMLElement>('[data-testid=hud-overlay]')!;
      const or = o.getBoundingClientRect();
      return [...o.querySelectorAll<HTMLElement>('.hud-box')].map((b) => {
        const r = b.getBoundingClientRect();
        const f = (v: number) => Math.round(v * 1000) / 1000;
        return `${b.dataset.testid} ${f((r.left - or.left) / or.width)} ${f((r.top - or.top) / or.height)}`;
      });
    });
  const at1080 = await boxes();
  for (const size of ['720p', '1080p']) {
    const before = await draws(page);
    await dialog(page).getByTestId('export-vsize').getByLabel(size, { exact: true }).click();
    await expect.poll(() => draws(page)).toBeGreaterThan(before);
    expect(await boxes()).toEqual(at1080);
  }
});

const SIZES: [number, number][] = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [600, 800],
];
for (const [w, h] of SIZES) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`layout at ${w}×${h}, ${scheme}: no overlap, no sideways scroll, preview stays`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await load(page);
      {
        const format = 'Video (MP4)';
        await openDialog(page, format);
        await page.getByTestId('look-hud-button').click();
        await page.getByTestId('bookends-button').click();
        // M15: the stage, the options panel and the timeline never overlap; nothing sticks out.
        const m = await page.evaluate(() => {
          const d = document.querySelector<HTMLElement>('[data-testid=video-workspace]')!;
          d.scrollTop = 0;
          const box = (sel: string) => d.querySelector(sel)!.getBoundingClientRect();
          const stage = box('.video-stage');
          const side = box('.ws-side');
          const bottom = box('.ws-bottom');
          const meets = (a: DOMRect, b: DOMRect) =>
            a.right > b.left + 0.5 &&
            a.left < b.right - 0.5 &&
            a.bottom > b.top + 0.5 &&
            a.top < b.bottom - 0.5;
          const over = ['.ws-side', '.ws-bottom'].flatMap((sel) => {
            const r = box(sel);
            return [...d.querySelector(sel)!.querySelectorAll<HTMLElement>('*')]
              .filter((el) => el.getClientRects().length > 0 && !el.closest('.visually-hidden'))
              .filter((el) => el.getBoundingClientRect().right > r.right + 1)
              .map((el) => el.getAttribute('data-testid') ?? el.className ?? el.tagName);
          });
          const panel = d.querySelector('.ws-side')!;
          return {
            sideways:
              d.scrollWidth > d.clientWidth + 1 ||
              document.documentElement.scrollWidth > innerWidth,
            overlap: meets(stage, side) || meets(stage, bottom) || meets(side, bottom),
            over: over.slice(0, 5),
            bg: getComputedStyle(panel).backgroundColor,
            ink: getComputedStyle(panel.querySelector('legend')!).color,
          };
        });
        expect(m.sideways, format).toBe(false);
        expect(m.overlap, format).toBe(false);
        expect(m.over, format).toEqual([]);
        expect(m.bg).not.toBe(m.ink);
        // Scrolled to Export MP4, the preview is still fully on screen.
        await page.getByTestId('export-run').scrollIntoViewIfNeeded();
        const c = (await page.getByTestId('preview-canvas').boundingBox())!;
        expect(c.y, format).toBeGreaterThanOrEqual(0);
        expect(c.y + c.height, format).toBeLessThanOrEqual(h);
        expect(c.x + c.width, format).toBeLessThanOrEqual(w);
        // The Export button is reachable without covering by the preview.
        const run = (await page.getByTestId('export-run').boundingBox())!;
        expect(run.y + run.height).toBeLessThanOrEqual(h);
        if (w < 1100) expect(run.y).toBeGreaterThanOrEqual(c.y + c.height);
      }
      // The poster workspace: the artboard and the options never overlap; the poster stays fully
      // on screen with the options scrolled to Export (narrow: stacked, the artboard on top).
      await backToMusic(page);
      await openDialog(page, 'Poster');
      await page.getByTestId('look-hud-button').click();
      const p = await page.evaluate(() => {
        const ws = document.querySelector<HTMLElement>('[data-testid=poster-workspace]')!;
        // Narrow: the options scroll under the sticky artboard; compare them unscrolled.
        ws.scrollTop = 0;
        const art = ws.querySelector('[data-testid=poster-artboard]')!.getBoundingClientRect();
        const side = ws.querySelector('.ws-side')!;
        const sr = side.getBoundingClientRect();
        const over = [...side.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getClientRects().length > 0 && !el.closest('.visually-hidden'))
          .filter((el) => el.getBoundingClientRect().right > sr.right + 1)
          .map((el) => el.getAttribute('data-testid') ?? el.className ?? el.tagName);
        return {
          sideways:
            ws.scrollWidth > ws.clientWidth + 1 ||
            document.documentElement.scrollWidth > innerWidth,
          overlap:
            art.right > sr.left + 0.5 &&
            art.left < sr.right &&
            art.bottom > sr.top + 0.5 &&
            art.top < sr.bottom,
          over: over.slice(0, 5),
          bg: getComputedStyle(side).backgroundColor,
          ink: getComputedStyle(side.querySelector('legend')!).color,
        };
      });
      expect(p.sideways, 'poster').toBe(false);
      expect(p.overlap, 'poster').toBe(false);
      expect(p.over, 'poster').toEqual([]);
      expect(p.bg).not.toBe(p.ink);
      await page.getByTestId('export-run').scrollIntoViewIfNeeded();
      const c = (await page.getByTestId('preview-canvas').boundingBox())!;
      expect(c.y, 'poster').toBeGreaterThanOrEqual(0);
      expect(c.y + c.height, 'poster').toBeLessThanOrEqual(h);
      expect(c.x + c.width, 'poster').toBeLessThanOrEqual(w);
      const run = (await page.getByTestId('export-run').boundingBox())!;
      expect(run.y + run.height).toBeLessThanOrEqual(h);
      expect(run.y + 1).toBeGreaterThanOrEqual(w < 1100 ? c.y + c.height : 0);
    });
  }
}
