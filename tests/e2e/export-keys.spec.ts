/**
 * The Export dialog's interactions pass (PLAN.md §12 "UI and interactions", §15 M11): the whole
 * dialog by keyboard alone (focus order, visible focus, Escape, focus kept when the focused
 * control goes away), the preview redrawing after every control, and the layout at 1280, 1440,
 * 1920 px and a narrow window, light and dark.
 */

import { expect, test, type Page } from '@playwright/test';

const dialog = (page: Page) => page.getByTestId('export-dialog');

async function load(page: Page): Promise<void> {
  await page.goto('./?example=kite-day');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
}

async function openDialog(page: Page, format: 'Video (MP4)' | 'Poster'): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('open-export').click();
  await expect(dialog(page)).toBeVisible();
  const input = dialog(page).getByTestId('export-format').getByLabel(format, { exact: true });
  await input.click();
  await expect(input).toBeChecked();
  if (format === 'Video (MP4)') {
    await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  }
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

test('the whole dialog by keyboard alone: order, visible focus, Escape', async ({
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
  await expect(dialog(page)).toBeVisible();
  await expect.poll(async () => (await focused(page)).id).toBe('export-format');
  for (let i = 0; i < 6; i++) {
    if (await dialog(page).getByTestId('export-format').getByLabel('Video (MP4)').isChecked())
      break;
    await page.keyboard.press('ArrowRight');
  }
  await expect(dialog(page).getByTestId('export-format').getByLabel('Video (MP4)')).toBeChecked();
  await expect(page.getByTestId('export-codec')).not.toHaveText(/Checking/, { timeout: 20_000 });
  // Open the collapsible groups by keys, so every control is a stop.
  for (const id of ['look-hud-button', 'bookends-button']) {
    await page.getByTestId(id).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(id)).toHaveAttribute('aria-expanded', 'true');
  }
  await dialog(page).getByTestId('export-format').getByLabel('Video (MP4)').focus();

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
      const d = document.querySelector<HTMLElement>('[data-testid=export-dialog]')!;
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
      return {
        id:
          a.getAttribute('data-testid') ??
          a.closest('[data-testid]')?.getAttribute('data-testid') ??
          a.tagName,
        x: r.left,
        y: r.top + d.scrollTop,
        ring: shows(a) || (seg !== null && shows(seg)),
      };
    });
    if (!s) break;
    stops.push(s);
    await page.keyboard.press(TAB);
  }
  const ids = stops.map((s) => s.id);
  // Every group in order: format, the preview (HUD boxes, play, time, thumbnail, description),
  // then the options column top to bottom, ending on Close and Export.
  const order = [
    'export-format',
    'hud-box-formula',
    'preview-play',
    'preview-time',
    'export-thumbnail',
    'export-description',
    'export-preset',
    'export-section',
    'export-aspect',
    'export-vsize',
    'export-quality',
    'export-camera',
    'export-loudness',
    'export-vtheme',
    'look-guides',
    'look-glow',
    'look-pitch-input',
    'look-hud-button',
    'hud-formula',
    'scheme-theme',
    'look-bg',
    'swatch-hud-hex',
    'look-reset',
    'bookends-button',
    'vb-fade-in',
    'vb-title-card',
    'vb-end-card',
    'export-close',
    'export-run',
  ];
  const at = order.map((id) => ids.indexOf(id));
  expect(
    at.every((i) => i >= 0),
    `missing: ${order.filter((_, k) => at[k] < 0)}`,
  ).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(stops.length).toBeGreaterThan(60);
  // Each stop shows a ring.
  expect(stops.filter((s) => !s.ring).map((s) => s.id)).toEqual([]);
  // The options column reads top to bottom.
  const opts = stops.slice(ids.indexOf('export-preset'));
  for (let k = 1; k < opts.length; k++) {
    expect(opts[k].y, `${opts[k - 1].id} → ${opts[k].id}`).toBeGreaterThanOrEqual(
      opts[k - 1].y - 40,
    );
  }
  // Escape closes; focus returns to the menu button.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('menu-button')).toBeFocused();
});

test('every control by keyboard redraws the preview and keeps focus in the dialog', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page);
  await openDialog(page, 'Video (MP4)');
  const key = (k: string) => page.keyboard.press(k);
  const radio = (id: string, label: string) =>
    dialog(page).getByTestId(id).getByLabel(label, { exact: true }).focus();
  const at = (id: string) => page.getByTestId(id).focus();
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
  await step(
    'camera Whole',
    async () => {
      await radio('export-camera', 'Follow');
      await key('ArrowRight');
    },
    'export-camera',
  );
  await step('camera Follow', () => key('ArrowLeft'), 'export-camera');
  await step(
    'window',
    async () => {
      await at('export-window');
      await key('ArrowLeft');
    },
    'export-window',
  );
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
    'gradient direction',
    async () => {
      await page.getByTestId('look-bg-dir').locator('input:checked').focus();
      await key('ArrowRight');
    },
    'look-bg-dir',
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

test('poster controls by keyboard redraw the preview', async ({ page }) => {
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
    'title block',
    async () => {
      await page.getByTestId('export-ptitle').focus();
      await page.keyboard.press('Space');
    },
    'export-ptitle',
  );
  await step(
    'section Custom',
    async () => {
      await dialog(page).getByTestId('export-section').getByLabel('Whole piece').focus();
      await page.keyboard.press('ArrowRight');
    },
    'export-section',
  );
  await step(
    'piece range',
    async () => {
      await page.getByTestId('export-prange').focus();
      await page.keyboard.press('Space');
    },
    'export-prange',
  );
  await step(
    'background Transparent',
    async () => {
      // Transparent is last (WebKit's arrows don't wrap from the first).
      await dialog(page).getByTestId('look-bg').getByLabel('Gradient').focus();
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
      for (const format of ['Video (MP4)', 'Poster'] as const) {
        if (format === 'Poster') await page.getByTestId('export-close').click();
        await openDialog(page, format);
        await page.getByTestId('look-hud-button').click();
        if (format === 'Video (MP4)') await page.getByTestId('bookends-button').click();
        const m = await page.evaluate(() => {
          const d = document.querySelector<HTMLElement>('[data-testid=export-dialog]')!;
          const pv = d.querySelector('[data-testid=export-preview]')!.getBoundingClientRect();
          const opts = d.querySelector('.export-options')!.getBoundingClientRect();
          const over = [...d.querySelectorAll<HTMLElement>('.export-options *')]
            .filter((el) => el.getClientRects().length > 0 && !el.closest('.visually-hidden'))
            .filter((el) => el.getBoundingClientRect().right > opts.right + 1)
            .map((el) => el.getAttribute('data-testid') ?? el.className ?? el.tagName);
          const bg = getComputedStyle(d).backgroundColor;
          const ink = getComputedStyle(d.querySelector('h2')!).color;
          return {
            sideways:
              d.scrollWidth > d.clientWidth + 1 ||
              document.documentElement.scrollWidth > innerWidth,
            overlap:
              innerWidth >= 900 &&
              pv.right > opts.left &&
              pv.left < opts.right &&
              pv.bottom > opts.top &&
              pv.top < opts.bottom,
            over: over.slice(0, 5),
            bg,
            ink,
          };
        });
        expect(m.sideways, format).toBe(false);
        expect(m.overlap, format).toBe(false);
        expect(m.over, format).toEqual([]);
        expect(m.bg).not.toBe(m.ink);
        // Scrolled to the end of the options, the preview is still fully on screen.
        await dialog(page).evaluate((d) => (d.scrollTop = d.scrollHeight));
        await page.getByTestId('export-run').scrollIntoViewIfNeeded();
        const c = (await page.getByTestId('preview-canvas').boundingBox())!;
        expect(c.y, format).toBeGreaterThanOrEqual(0);
        expect(c.y + c.height, format).toBeLessThanOrEqual(h);
        expect(c.x + c.width, format).toBeLessThanOrEqual(w);
        // The Export button is reachable without covering by the preview.
        const run = (await page.getByTestId('export-run').boundingBox())!;
        expect(run.y + run.height).toBeLessThanOrEqual(h);
        if (w < 900) expect(run.y).toBeGreaterThanOrEqual(c.y + c.height);
      }
    });
  }
}
