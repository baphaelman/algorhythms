/**
 * The Roman numeral hint (docs/composing.md §3 #10): a numeral outside a minor-type key's scale
 * suggests its flat, and one click rewrites it as one undo entry. Chromium only.
 */

import { expect, test, type Page } from '@playwright/test';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough for the inspector');

interface Hook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { undoLabel: string } };
  };
  store: {
    getState(): { piece: { key: unknown; moments: { id: string; notes?: { symbol?: string } }[] } };
  };
  actions: { loadPiece(p: unknown): void };
}

/** "Drift", a chord at 40.7 s in Tidewater Hymn (A dorian there). */
const CHORD = 'Zd0uQh';

const symbol = (page: Page): Promise<string | undefined> =>
  page.evaluate(
    (id) =>
      (window.__algorhythms as unknown as Hook).store
        .getState()
        .piece.moments.find((m) => m.id === id)?.notes?.symbol,
    CHORD,
  );

/** Reloads the piece in `key` (null: as it is) with the chord set to `sym`, and selects it. */
async function open(page: Page, sym: string, key: unknown = null): Promise<void> {
  await page.evaluate(
    ([id, s, k]) => {
      const h = window.__algorhythms as unknown as Hook;
      const p = structuredClone(h.store.getState().piece) as {
        key: unknown;
        moments: { id: string; type?: string; notes?: unknown }[];
      };
      if (k) {
        p.key = k;
        p.moments = p.moments.filter((m) => m.type !== 'key');
      }
      for (const m of p.moments) if (m.id === id) m.notes = { kind: 'chord', symbol: s };
      h.actions.loadPiece(p);
      h.editor.select([id]);
    },
    [CHORD, sym, key] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('VII in A dorian suggests ♭VII = G; one click fixes it, one undo restores', async ({
  page,
}) => {
  const insp = page.getByTestId('inspector');
  await open(page, 'VII7');
  const hint = insp.getByTestId('insp-numeral-hint');
  await expect(hint).toHaveText(/VII here is G♯; did you mean ♭VII = G\?/);
  await insp.getByTestId('insp-numeral-fix').click();
  await expect.poll(() => symbol(page)).toBe('bVII7');
  await expect(hint).toHaveCount(0);
  await expect(insp.getByTestId('insp-chord')).toHaveValue('bVII7');
  expect(
    await page.evaluate(
      () => (window.__algorhythms as unknown as Hook).editor.state.getState().undoLabel,
    ),
  ).toBe('Flatten numeral');
  await page.evaluate(() => (window.__algorhythms as unknown as Hook).editor.undo());
  await expect.poll(() => symbol(page)).toBe('VII7');
  await expect(hint).toBeVisible();
});

test('typing a numeral shows the hint once committed; in-scale numerals show none', async ({
  page,
}) => {
  const insp = page.getByTestId('inspector');
  await open(page, 'I', { tonic: 'C', scale: 'minor' });
  const hint = insp.getByTestId('insp-numeral-hint');
  await expect(hint).toHaveCount(0);
  const field = insp.getByTestId('insp-chord');
  await field.fill('VI');
  await field.press('Enter');
  await expect(hint).toHaveText(/VI here is A; did you mean ♭VI = A♭\?/);
  // Dorian's VI is in the scale.
  await open(page, 'VI', { tonic: 'A', scale: 'dorian' });
  await expect(insp.getByTestId('insp-chord')).toHaveValue('VI');
  await expect(hint).toHaveCount(0);
});

test('no hint in a major key', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await open(page, 'VII', { tonic: 'C', scale: 'major' });
  await expect(insp.getByTestId('insp-chord')).toHaveValue('VII');
  await expect(insp.getByTestId('insp-numeral-hint')).toHaveCount(0);
});
