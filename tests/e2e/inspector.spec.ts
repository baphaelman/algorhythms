/**
 * The inspector (PLAN.md §11.3, M4e). The lane isn't built yet, so moments are selected through
 * the debug hook. Chromium only.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { seek } from './app-hook';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium is enough for the inspector');

interface M {
  id: string;
  type: string;
  seed?: number;
  muted?: boolean;
  notes?: { kind: string; symbol?: string };
  glide?: { length?: number };
}

interface EditorHook {
  editor: {
    select(ids: string[]): void;
    undo(): boolean;
    state: { getState(): { canUndo: boolean; undoLabel: string } };
  };
  store: { getState(): { piece: { moments: M[] } } };
}

const hook = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => {
      const h = window.__algorhythms as unknown as EditorHook;
      if (f === 'select') h.editor.select(a[0] as string[]);
      if (f === 'undo') return h.editor.undo();
      return null;
    },
    [fn, args] as const,
  );

const moment = (page: Page, id: string): Promise<M | undefined> =>
  page.evaluate((i) => {
    const h = window.__algorhythms as unknown as EditorHook;
    return h.store.getState().piece.moments.find((m) => m.id === i);
  }, id);

const undoLabel = (page: Page): Promise<string> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().undoLabel,
  );

/** "Drift", a degrees chord in the featured example (Tidewater Hymn). */
const CHORD = 'Zd0uQh';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('time')).toHaveText(/\d\d:\d\d\.\d/);
});

test('shows a hint with nothing selected and shared actions for several', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await expect(insp).toContainText('No moment selected');
  await hook(page, 'select', ['tuOzVd', '77O2kG']);
  await expect(insp).toContainText('2 moments selected');
  await insp.getByRole('button', { name: 'Mute all' }).click();
  expect((await moment(page, 'tuOzVd'))?.muted).toBe(true);
  expect((await moment(page, '77O2kG'))?.muted).toBe(true);
  await hook(page, 'undo');
  expect((await moment(page, 'tuOzVd'))?.muted).toBeUndefined();
});

test('edits a chord symbol, glide length and seed; undo restores', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  await expect(insp.locator('[data-moment-id]')).toHaveAttribute('data-moment-id', CHORD);
  await expect(insp.getByRole('heading')).toContainText('Chord');
  await expect(insp.getByTestId('insp-degrees')).toBeVisible();

  // Switch to a chord symbol.
  await insp.getByTestId('insp-notes-kind').selectOption('chord');
  expect((await moment(page, CHORD))?.notes).toEqual({ kind: 'chord', symbol: 'I' });

  // An invalid symbol shows an error and is not committed.
  const chord = insp.getByTestId('insp-chord');
  await chord.fill('Xq7');
  await expect(insp.getByTestId('insp-chord-feedback')).toHaveClass(/field-error/);
  await chord.press('Enter');
  await expect(chord).toHaveAttribute('aria-invalid', 'true');
  expect((await moment(page, CHORD))?.notes?.symbol).toBe('I');

  // A valid one shows its notes as you type and changes the piece on Enter.
  await chord.fill('Dm9');
  await expect(insp.getByTestId('insp-chord-feedback')).toHaveText('D F A C E');
  await chord.press('Enter');
  await expect.poll(async () => (await moment(page, CHORD))?.notes?.symbol).toBe('Dm9');

  // Glide length.
  const length = insp.getByTestId('insp-glide-length');
  await expect(length).toHaveValue('3.1');
  await length.fill('5.5');
  await length.press('Enter');
  expect((await moment(page, CHORD))?.glide?.length).toBe(5.5);

  // Reroll sets an explicit seed and shows it.
  const seedText = await insp.getByTestId('insp-seed').innerText();
  expect((await moment(page, CHORD))?.seed).toBeUndefined();
  await insp.getByTestId('insp-reroll').click();
  const seed = (await moment(page, CHORD))?.seed;
  expect(typeof seed).toBe('number');
  await expect(insp.getByTestId('insp-seed')).toHaveText(String(seed));
  expect(seedText).toContain('derived');

  // Undo walks back each edit, and the form follows.
  expect(await undoLabel(page)).toBe('Reroll');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.seed).toBeUndefined();
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.glide?.length).toBe(3.1);
  await expect(length).toHaveValue('3.1');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.notes?.symbol).toBe('I');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.notes?.kind).toBe('degrees');
});

test('dragging a number label is one undo entry', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const label = insp.locator('label.scrub-label', { hasText: 'Length' });
  await label.scrollIntoViewIfNeeded();
  const box = (await label.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 10, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 10 + i * 4, y);
  await page.mouse.up();
  const after = (await moment(page, CHORD))?.glide?.length ?? 0;
  expect(after).toBeGreaterThan(3.1);
  expect(await undoLabel(page)).toBe('Edit glide length');
  await hook(page, 'undo');
  expect((await moment(page, CHORD))?.glide?.length).toBe(3.1);
  expect(
    await page.evaluate(
      () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().canUndo,
    ),
  ).toBe(false);
});

test('keyboard: degree picker toggles with Enter; Space plays instead', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const deg2 = insp.getByRole('button', { name: /^Degree 2 / });
  await expect(deg2).toHaveAttribute('aria-pressed', 'false');
  await deg2.focus();
  await page.keyboard.press('Space');
  await expect
    .poll(() => page.evaluate(() => window.__algorhythms!.store.getState().transport.status))
    .toBe('playing');
  await expect(deg2).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(deg2).toHaveAttribute('aria-pressed', 'true');
  expect(
    await page.evaluate((id) => {
      const h = window.__algorhythms as unknown as {
        store: {
          getState(): { piece: { moments: { id: string; notes?: { degrees?: number[] } }[] } };
        };
      };
      return h.store.getState().piece.moments.find((m) => m.id === id)?.notes?.degrees;
    }, CHORD),
  ).toEqual([0, 1, 2, 4, 6]);
});

test('chord picker: diatonic chord, quality, bass and voicing; each pick undoes', async ({
  page,
}) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const picker = insp.getByTestId('insp-chord-picker');
  const group = (name: string) => picker.getByRole('group', { name });
  const notes = async () => (await moment(page, CHORD))?.notes;

  // A degrees chord: "Other notes" is open, the header shows the compiled chord and live notes.
  await expect(insp.getByTestId('insp-degrees')).toBeVisible();
  await expect(insp.getByTestId('insp-chord-live')).toHaveText(/^[A-G]/);

  // The key at 0:40.7 is A dorian: IV is D.
  await group('From the key').getByRole('button', { name: 'IV D', exact: true }).click();
  expect(await notes()).toEqual({ kind: 'chord', symbol: 'D' });
  await expect(insp.getByTestId('insp-chord-name')).toHaveText('D');
  await expect(insp.getByTestId('insp-chord-numeral')).toHaveText('IV');
  await expect(insp.locator('details.insp-other')).not.toHaveAttribute('open', '');
  expect(await undoLabel(page)).toBe('Pick chord');

  await group('Quality').getByRole('button', { name: 'm7', exact: true }).click();
  expect((await notes())?.symbol).toBe('Dm7');
  await expect(insp.getByTestId('insp-chord-numeral')).toHaveText('iv7');

  await group('Bass').getByRole('button', { name: '3rd' }).click();
  expect((await notes())?.symbol).toBe('Dm7/F');
  await expect(insp.getByTestId('insp-chord-name')).toHaveText('Dm7/F');

  await group('Bass').getByRole('button', { name: 'Root' }).click();
  expect((await notes())?.symbol).toBe('Dm7/D');
  await expect(group('Bass').getByRole('button', { name: 'Root' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await group('Voicing').getByRole('button', { name: 'Close' }).click();
  expect(
    await page.evaluate((i) => {
      const h = window.__algorhythms as unknown as {
        store: { getState(): { piece: { moments: { id: string; voicing?: string }[] } } };
      };
      return h.store.getState().piece.moments.find((m) => m.id === i)?.voicing;
    }, CHORD),
  ).toBe('close');
  await expect(insp.getByTestId('insp-chord-live')).toHaveText(/^[A-G]/);

  // Undo walks back one pick at a time.
  await hook(page, 'undo');
  await hook(page, 'undo');
  expect((await notes())?.symbol).toBe('Dm7/F');
  await hook(page, 'undo');
  expect((await notes())?.symbol).toBe('Dm7');
  await hook(page, 'undo');
  expect((await notes())?.symbol).toBe('D');
  await hook(page, 'undo');
  expect((await notes())?.kind).toBe('degrees');
  await expect(insp.getByTestId('insp-degrees')).toBeVisible();
});

// --- Transition, level, walk and voices controls (M4.5-6) ------------------------------------

/** The walk in the featured example. */
const WALK = '6nVoFa';

interface WalkM {
  density: number;
  grid: number;
  stepGlide: number;
  bass?: { leap: [number, number] };
  steps: number[];
  fixed?: { tick: number; voice: string; pitch: number }[];
  target?: unknown;
  glide?: { ease?: unknown; order?: string };
}

const walk = (page: Page) => moment(page, WALK) as Promise<(M & WalkM) | undefined>;

/** A fingerprint of the compiled walk steps, to see the score change. */
const walkSteps = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      store: {
        getState(): { compiled: { walkSteps: { t: number; voice: string; to: number }[] } };
      };
    };
    return JSON.stringify(h.store.getState().compiled.walkSteps.map((s) => [s.t, s.voice, s.to]));
  });

const canUndo = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => (window.__algorhythms as unknown as EditorHook).editor.state.getState().canUndo,
  );

test('walk: density and allowed steps change the score; each undoes', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [WALK]);
  await expect(insp.getByRole('heading')).toContainText('Walk');
  const steps = insp.getByTestId('insp-walk-steps');
  await expect(steps.getByRole('button')).toHaveText(['−3', '−2', '−1', '+1', '+2', '+3']);
  await expect(steps.getByRole('button', { name: '+3' })).toHaveAttribute('aria-pressed', 'false');

  const before = await walkSteps(page);
  await steps.getByRole('button', { name: '+3' }).click();
  expect((await walk(page))?.steps).toEqual([-2, -1, 1, 2, 3]);
  await expect(steps.getByRole('button', { name: '+3' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => walkSteps(page)).not.toBe(before);
  const withThree = await walkSteps(page);

  const density = insp.getByTestId('insp-walk-density');
  await expect(density).toHaveValue('45');
  await density.fill('90');
  await density.press('Enter');
  expect((await walk(page))?.density).toBe(0.9);
  await expect.poll(() => walkSteps(page)).not.toBe(withThree);

  expect(await undoLabel(page)).toBe('Edit density');
  await hook(page, 'undo');
  expect((await walk(page))?.density).toBe(0.45);
  await hook(page, 'undo');
  expect((await walk(page))?.steps).toEqual([-2, -1, 1, 2]);
  await expect.poll(() => walkSteps(page)).toBe(before);
});

/** A fingerprint of the compiled segments inside the walk's region (step glides change these). */
const walkSegments = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      store: {
        getState(): {
          compiled: { voices: { segments: { t0: number; t1: number; p1: number }[] }[] };
        };
      };
    };
    const segs = h.store
      .getState()
      .compiled.voices.flatMap((v) => v.segments)
      .filter((g) => g.t0 >= 98.8 && g.t0 < 122.9);
    return JSON.stringify(segs.map((g) => [g.t0, g.t1, g.p1]));
  });

test('walk: grid, step glide and bass leap change the score; each undoes', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [WALK]);
  await expect(insp.getByRole('heading')).toContainText('Walk');
  const steps0 = await walkSteps(page);
  const segs0 = await walkSegments(page);
  const set = async (field: Locator, v: string) => {
    await field.fill(v);
    await field.press('Enter');
    // Leave the field, as a click on Undo would: a focused field keeps its typed text.
    await field.blur();
  };

  // Grid 1 s -> 0.5 s: twice the ticks, so the steps move.
  await set(insp.getByTestId('insp-walk-grid'), '0.5');
  expect((await walk(page))?.grid).toBe(0.5);
  await expect.poll(() => walkSteps(page)).not.toBe(steps0);
  expect(await undoLabel(page)).toBe('Edit grid');
  await hook(page, 'undo');
  expect((await walk(page))?.grid).toBe(1);
  await expect.poll(() => walkSteps(page)).toBe(steps0);

  // Step glide 0.27 s -> 0.8 s: longer glides.
  await set(insp.getByTestId('insp-walk-step-glide'), '0.8');
  expect((await walk(page))?.stepGlide).toBe(0.8);
  await expect.poll(() => walkSegments(page)).not.toBe(segs0);
  expect(await undoLabel(page)).toBe('Edit step glide');
  await hook(page, 'undo');
  expect((await walk(page))?.stepGlide).toBe(0.27);
  await expect.poll(() => walkSegments(page)).toBe(segs0);

  // Bass leap [5, 12] -> [12, 12]: the bass always leaps an octave.
  await set(insp.getByRole('textbox', { name: 'Leap min' }), '12');
  expect((await walk(page))?.bass?.leap).toEqual([12, 12]);
  await expect.poll(() => walkSteps(page)).not.toBe(steps0);
  expect(await undoLabel(page)).toBe('Edit bass leap');
  await hook(page, 'undo');
  expect((await walk(page))?.bass?.leap).toEqual([5, 12]);
  await expect.poll(() => walkSteps(page)).toBe(steps0);
  await expect.poll(() => walkSegments(page)).toBe(segs0);
});

test('a slider drag is one undo entry', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [WALK]);
  const slider = insp.getByTestId('insp-walk-density-slider');
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.45, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.45 + i * 0.05), y);
  await page.mouse.up();
  const after = (await walk(page))?.density ?? 0;
  expect(after).toBeGreaterThan(0.7);
  await expect(insp.getByTestId('insp-walk-density')).toHaveValue(String(Math.round(after * 100)));
  expect(await undoLabel(page)).toBe('Edit density');
  await hook(page, 'undo');
  expect((await walk(page))?.density).toBe(0.45);
  expect(await canUndo(page)).toBe(false);
});

test('a frozen walk shows its badge, locks the generator and unfreezes', async ({ page }) => {
  // The generated steps, before freezing.
  const generated = await walkSteps(page);
  // Load the featured piece with its walk frozen to two notes.
  await page.evaluate((id) => {
    const h = window.__algorhythms as unknown as {
      store: { getState(): { piece: { voices: { id: string }[]; moments: { id: string }[] } } };
      actions: { loadPiece(p: unknown): void };
    };
    const p = structuredClone(h.store.getState().piece);
    const v = p.voices[0].id;
    p.moments = p.moments.map((m) =>
      m.id === id
        ? {
            ...m,
            fixed: [
              { tick: 0, voice: v, pitch: 50 },
              { tick: 2, voice: v, pitch: 52 },
            ],
          }
        : m,
    );
    h.actions.loadPiece(p);
  }, WALK);
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [WALK]);
  await expect(insp.getByTestId('insp-walk-frozen')).toContainText('Frozen');
  await expect(insp.getByText('Unfreeze to change')).toBeVisible();
  await expect(insp.getByTestId('insp-walk-density')).toBeDisabled();
  await expect(
    insp.getByTestId('insp-walk-steps').getByRole('button', { name: '+3' }),
  ).toBeDisabled();
  await expect(insp.getByTestId('insp-reroll')).toBeDisabled();
  // Grid still applies to a frozen walk.
  await expect(insp.getByTestId('insp-walk-grid')).toBeEnabled();
  const frozen = await walkSteps(page);

  await insp.getByTestId('insp-unfreeze').click();
  expect((await walk(page))?.fixed).toBeUndefined();
  await expect(insp.getByTestId('insp-walk-frozen')).toHaveCount(0);
  await expect(insp.getByTestId('insp-walk-density')).toBeEnabled();
  // Unfreeze restores exactly the generated walk.
  await expect.poll(() => walkSteps(page)).toBe(generated);
  expect(generated).not.toBe(frozen);
  expect(await undoLabel(page)).toBe('Unfreeze walk');
  await hook(page, 'undo');
  expect((await walk(page))?.fixed).toHaveLength(2);
  await expect(insp.getByTestId('insp-walk-frozen')).toBeVisible();
});

test('voices, transition and level controls', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [WALK]);
  // Voice targeting sits in a collapsed Advanced fold; no Top n / Bottom n (revision 6).
  const adv = insp.getByTestId('insp-advanced');
  const modes = insp.getByTestId('insp-target');
  await expect(adv).not.toHaveAttribute('open');
  await expect(modes).toBeHidden();
  await adv.locator('summary').click();
  await expect(modes.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await expect(modes.getByRole('button', { name: /Top n|Bottom n/ })).toHaveCount(0);

  await modes.getByRole('button', { name: 'By rank' }).click();
  const rank = (await walk(page))?.target as { rank: [number, number] };
  expect(rank.rank[0]).toBe(0);
  await expect(insp.getByLabel('Lowest rank')).toBeVisible();

  await modes.getByRole('button', { name: 'Pick…' }).click();
  await expect(insp.locator('.insp-voices input[type=checkbox]')).toHaveCount(12);

  // A moment that already targets something opens with the fold open.
  await hook(page, 'select', ['TwLvl1']);
  await hook(page, 'select', [WALK]);
  await expect(adv).toHaveAttribute('open');
  await modes.getByRole('button', { name: 'All' }).click();
  expect((await walk(page))?.target).toBeUndefined();

  // Transition chips.
  const tr = insp.getByTestId('insp-transition');
  await tr.getByRole('group', { name: 'Curve' }).getByRole('button', { name: 'Expo' }).click();
  expect((await walk(page))?.glide?.ease).toBe('expo');
  await tr.getByRole('group', { name: 'Curve' }).getByRole('button', { name: 'Custom' }).click();
  expect((await walk(page))?.glide?.ease).toMatchObject({ kind: 'bezier' });
  await expect(tr.getByRole('img', { name: 'bézier easing curve' })).toBeVisible();
  await tr
    .getByRole('group', { name: 'Order' })
    .getByRole('button', { name: 'Centre out' })
    .click();
  expect((await walk(page))?.glide?.order).toBe('center-out');

  // Level: Ramp.
  await hook(page, 'select', ['TwLvl1']);
  const ramp = insp.getByTestId('insp-level-ramp');
  await expect(ramp).toHaveValue('4');
  await ramp.fill('7.5');
  await ramp.press('Enter');
  expect(
    await page.evaluate(() => {
      const h = window.__algorhythms as unknown as {
        store: { getState(): { piece: { moments: { id: string; over?: number }[] } } };
      };
      return h.store.getState().piece.moments.find((m) => m.id === 'TwLvl1')?.over;
    }),
  ).toBe(7.5);
});

interface ChordM {
  count?: number;
  notes: { kind: string };
  frozenFrom?: { notes: { kind: string } };
  glide?: { arrive?: string };
}
const chordM = (page: Page) => moment(page, CHORD) as Promise<(M & ChordM) | undefined>;
const notePitches = (page: Page): Promise<number[]> =>
  page
    .getByTestId('chord-note')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-pitch'))));

/** Every chord but CHORD: its notes in the piece and its compiled harmony entries. */
const otherChords = (page: Page) =>
  page.evaluate((id) => {
    const h = window.__algorhythms as unknown as {
      store: {
        getState(): {
          piece: {
            moments: { id: string; type: string; notes?: unknown; frozenFrom?: unknown }[];
          };
          compiled: { harmony?: { momentId: string; pcs: number[] }[] };
        };
      };
    };
    const s = h.store.getState();
    const chords = s.piece.moments.filter((m) => m.type === 'chord' && m.id !== id);
    const ids = new Set(chords.map((m) => m.id));
    const harmony = (s.compiled.harmony ?? [])
      .filter((x) => ids.has(x.momentId))
      .map((x) => [x.momentId, x.pcs]);
    return {
      n: chords.length,
      notes: chords.map((m) => [m.id, m.notes, m.frozenFrom ?? null]),
      harmony,
    };
  }, CHORD);

test('chord Notes: n changes how many notes sound', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const rows = insp.getByTestId('chord-note');
  await expect(rows.first()).toBeVisible();
  const n0 = await rows.count();
  const count = insp.getByTestId('insp-chord-count');
  await expect(count).toHaveValue(String(n0));

  // The featured chord already sounds the whole pool: go down, then up.
  expect(n0).toBeGreaterThan(4);
  await count.fill(String(n0 - 3));
  await count.press('Enter');
  expect((await chordM(page))?.count).toBe(n0 - 3);
  await expect(rows).toHaveCount(n0 - 3);

  await count.focus();
  await count.press('ArrowUp');
  expect((await chordM(page))?.count).toBe(n0 - 2);
  await expect(rows).toHaveCount(n0 - 2);
  await hook(page, 'undo');
  await expect(rows).toHaveCount(n0 - 3);
});

test('a per-note ▲ freezes the chord and changes one note; undo; Unfreeze', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const rows = insp.getByTestId('chord-note');
  await expect(rows.first()).toBeVisible();
  const before = await notePitches(page);

  const others0 = await otherChords(page);
  expect(others0.n).toBeGreaterThan(0);
  await rows.nth(1).getByTestId('chord-note-up').click();
  const m = await chordM(page);
  expect(m?.notes.kind).toBe('pitches');
  expect(m?.frozenFrom?.notes.kind).toBe('degrees');
  expect(await undoLabel(page)).toBe('Freeze chord and move note');
  await expect(insp.getByTestId('insp-chord-frozen')).toBeVisible();
  await expect(insp.getByTestId('insp-chord-count')).toBeDisabled();
  await expect.poll(() => notePitches(page)).not.toEqual(before);
  const after = await notePitches(page);
  expect(after).toHaveLength(before.length);
  expect(before.filter((p) => !after.includes(p))).toHaveLength(1);
  // Only this chord froze: every other chord's notes and compiled harmony are unchanged.
  expect(await otherChords(page)).toEqual(others0);

  // One undo entry restores the unfrozen chord.
  await hook(page, 'undo');
  expect((await chordM(page))?.notes.kind).toBe('degrees');
  expect((await chordM(page))?.frozenFrom).toBeUndefined();
  await expect(insp.getByTestId('insp-chord-frozen')).toHaveCount(0);
  await expect.poll(() => notePitches(page)).toEqual(before);

  // ▼ twice, then Unfreeze restores the original notes.
  await rows.nth(0).getByTestId('chord-note-down').click();
  await rows.nth(0).getByTestId('chord-note-down').click();
  expect(await undoLabel(page)).toBe('Move chord note');
  await insp.getByTestId('insp-chord-unfreeze').click();
  expect(await undoLabel(page)).toBe('Unfreeze chord');
  const back = await chordM(page);
  expect(back?.notes).toEqual({ kind: 'degrees', degrees: [0, 2, 4, 6] });
  expect(back?.frozenFrom).toBeUndefined();
  await expect.poll(() => notePitches(page)).toEqual(before);
});

test('dragging a chord dot on the score freezes and moves that note', async ({ page }) => {
  await hook(page, 'select', [CHORD]);
  await seek(page, 44);
  const dots = page.getByTestId('chord-dot');
  await expect(dots.first()).toBeVisible();
  const before = await notePitches(page);
  expect(await dots.count()).toBe(before.length);
  const box = (await dots.nth(0).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 15, { steps: 4 });
  await page.mouse.move(x, y - 30, { steps: 4 });
  await page.mouse.up();
  expect((await chordM(page))?.frozenFrom).toBeDefined();
  expect(await undoLabel(page)).toBe('Freeze chord and move note');
  await expect.poll(() => notePitches(page)).not.toEqual(before);
  await hook(page, 'undo');
  expect((await chordM(page))?.frozenFrom).toBeUndefined();
});

test('Arrive together toggle writes glide.arrive', async ({ page }) => {
  const insp = page.getByTestId('inspector');
  await hook(page, 'select', [CHORD]);
  const arrive = insp.getByTestId('insp-arrive');
  await expect(arrive).toBeChecked();
  await arrive.uncheck();
  expect((await chordM(page))?.glide?.arrive).toBe('spread');
  await arrive.check();
  expect((await chordM(page))?.glide?.arrive).toBeUndefined();
  await hook(page, 'undo');
  await expect(arrive).not.toBeChecked();
});

test('shift: the By slider snaps to +1 octave (7 scale steps); one undo restores', async ({
  page,
}) => {
  await seek(page, 10);
  await page.keyboard.press('t');
  const insp = page.getByTestId('inspector');
  const slider = insp.getByTestId('insp-shift-by');
  await slider.scrollIntoViewIfNeeded();
  const id = await page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      editor: { state: { getState(): { selection: string[] } } };
    };
    return h.editor.state.getState().selection[0]!;
  });
  const by = async (): Promise<number | undefined> =>
    ((await moment(page, id)) as (M & { by?: number }) | undefined)?.by;
  expect((await moment(page, id))?.type).toBe('shift');
  expect(await by()).toBe(2);
  const value = insp.getByTestId('insp-shift-by-value');
  await expect(value).toHaveText('+2');

  // Drag from the thumb (+2 of ±14) to the drawn +1 octave mark (−14, −7, 0, 7, 14): it snaps
  // to 7 (native thumb insets differ a little between engines).
  const box = (await slider.boundingBox())!;
  const mark = (await insp.locator('.shift-mark').nth(3).boundingBox())!;
  const y = box.y + box.height / 2;
  const from = box.x + box.width * (16 / 28);
  const to = mark.x + mark.width / 2;
  await page.mouse.move(from, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from + (i / 6) * (to - from), y);
  await page.mouse.up();
  expect(await by()).toBe(7);
  await expect(value).toHaveText('+7');
  await expect(value).toHaveAttribute('title', '+7 (+1 oct)');
  expect(await undoLabel(page)).toBe('Edit shift');
  await hook(page, 'undo');
  expect(await by()).toBe(2);

  // Keys: arrows step by 1, Page Up/Down by an octave.
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  expect(await by()).toBe(3);
  await page.keyboard.press('PageDown');
  expect(await by()).toBe(-4);
});

test('a pulse moment is labelled "Pulse" in the inspector', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      store: { getState(): { piece: { moments: unknown[] } } };
      actions: { setPiece(p: unknown, o?: { now: boolean }): void };
    };
    const p = h.store.getState().piece;
    const pulse = {
      id: 'pulse1',
      type: 'pulse',
      at: 4,
      until: 8,
      step: 0.5,
      pattern: [1],
      decay: 0.3,
      floor: 0,
      mode: 'together',
    };
    h.actions.setPiece({ ...p, moments: [...p.moments, pulse] }, { now: true });
  });
  await hook(page, 'select', ['pulse1']);
  await expect(page.getByTestId('inspector').getByRole('heading')).toContainText('Pulse');
});

test('a tune moment is labelled "Tune" in the inspector', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.__algorhythms as unknown as {
      store: { getState(): { piece: { moments: unknown[] } } };
      actions: { setPiece(p: unknown, o?: { now: boolean }): void };
    };
    const p = h.store.getState().piece;
    const tune = {
      id: 'tune1',
      type: 'tune',
      at: 4,
      notes: [
        { pitch: 62, len: 0.5 },
        { pitch: 64, len: 0.5 },
      ],
    };
    h.actions.setPiece({ ...p, moments: [...p.moments, tune] }, { now: true });
  });
  await hook(page, 'select', ['tune1']);
  await expect(page.getByTestId('inspector').getByRole('heading')).toContainText('Tune');
});
