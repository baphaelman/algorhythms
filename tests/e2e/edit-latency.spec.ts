/**
 * M4.5 acceptance (PLAN.md §15): a chord pick or a walk control is heard within 50 ms while
 * playing. On a generated 24-voice piece, playing, this times each edit from the click (the
 * event's timestamp) or the `setPiece` call to the engine's `swap` post to the worklet. The
 * worklet applies a swap at its next 128-frame quantum (≤ 3 ms); device output latency is not
 * counted. Chromium only.
 *
 * The 50 ms gate applies to the production build (what ships). The dev build (React dev mode)
 * only asserts a loose 150 ms ceiling. `E2E_CPU_THROTTLE=4` emulates a slow (CI-class) machine.
 */

import { expect, test, type Page } from '@playwright/test';
import { seek } from './app-hook';
import { installLatencyHooks, median, summary, timeClicks, type LatencyHook } from './latency-hook';
import { generate } from '../../src/core/generate';
import { serializePiece } from '../../src/core/schema';

test.skip(({ browserName }) => browserName !== 'chromium', 'timing is asserted on Chromium only');

const BUDGET_MS = 50;
const DEV_CEILING_MS = 150;
const THROTTLE = Number(process.env.E2E_CPU_THROTTLE ?? 1);

async function openPlaying(page: Page): Promise<void> {
  const piece = generate(7, { mode: 'dorian', voices: 24 });
  expect(piece.voices).toHaveLength(24);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('./?example=tidewater-hymn');
  await expect(page.getByTestId('play')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles({
    name: 'dense.algorhythms.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializePiece(piece)),
  });
  await expect(page.getByTestId('keyvoices')).toContainText('/ 24 notes');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await seek(page, 60);
  await page.waitForFunction(() => window.__algorhythms!.engine()?.isPlaying === true);
  if (THROTTLE > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  }
  await page.waitForTimeout(1500); // warm up the JIT and the audio
  await installLatencyHooks(page);
}

test('chord picks and walk controls reach the worklet within 50 ms (prod) while playing (24 notes)', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await openPlaying(page);

  // setPiece → swap, for chord and walk edits made in the page (no input latency).
  const direct = await page.evaluate(async () => {
    const h = window.__algorhythms!;
    const l = (window as unknown as LatencyHook).__lat;
    type Mo = { id: string; type: string; notes?: unknown; density?: number };
    const chord = (): Mo =>
      (h.store.getState().piece.moments as unknown as Mo[]).find(
        (m) => m.type === 'chord' && (m.notes as { kind: string }).kind === 'degrees',
      )!;
    const walkId = (h.store.getState().piece.moments as unknown as Mo[]).find(
      (m) => m.type === 'walk',
    )!.id;
    const chordId = chord().id;
    const symbols = ['Dm7', 'G7', 'Cmaj7', 'Am', 'F', 'Em7'];
    const out: { chord: number[]; walk: number[] } = { chord: [], walk: [] };
    for (let i = 0; i < 24; i++) {
      const isChord = i % 2 === 0;
      const p = structuredClone(h.store.getState().piece) as unknown as { moments: Mo[] };
      p.moments = p.moments.map((m) =>
        isChord && m.id === chordId
          ? { ...m, notes: { kind: 'chord', symbol: symbols[(i / 2) % symbols.length] } }
          : !isChord && m.id === walkId
            ? { ...m, density: i % 4 === 1 ? 0.8 : 0.3 }
            : m,
      );
      const n = l.swaps.length;
      const t0 = performance.now();
      h.actions.setPiece(p);
      while (l.swaps.length === n) await new Promise((r) => setTimeout(r, 1));
      (isChord ? out.chord : out.walk).push(l.swaps[n] - t0);
      await new Promise((r) => setTimeout(r, 200));
    }
    return out;
  });

  // Clicks in the inspector: a chord pick and a walk step chip.
  const insp = page.getByTestId('inspector');
  const ids = await page.evaluate(() => {
    const ms = window.__algorhythms!.store.getState().piece.moments as unknown as {
      id: string;
      type: string;
    }[];
    return {
      chord: ms.filter((m) => m.type === 'chord').at(-1)!.id,
      walk: ms.find((m) => m.type === 'walk')!.id,
    };
  });
  await page.evaluate((id) => window.__algorhythms!.actions.select([id]), ids.chord);
  const keyChords = insp
    .getByTestId('insp-chord-picker')
    .getByRole('group', { name: 'From the key' })
    .getByRole('button');
  await expect(keyChords.first()).toBeVisible();
  const uiChord = await timeClicks(page, 8, (i) => keyChords.nth(i % 2 === 0 ? 1 : 3).click());
  await page.evaluate((id) => window.__algorhythms!.actions.select([id]), ids.walk);
  const chip = insp.getByTestId('insp-walk-steps').getByRole('button', { name: '+3' });
  await expect(chip).toBeEnabled();
  const uiWalk = await timeClicks(page, 8, () => chip.click());

  expect(await page.evaluate(() => window.__algorhythms!.engine()!.isPlaying)).toBe(true);
  const result = {
    setPieceChord: summary(direct.chord),
    setPieceWalk: summary(direct.walk),
    clickChord: summary(uiChord),
    clickWalk: summary(uiWalk),
  };
  console.log(`[${info.project.name}] edit → swap latency, 24 notes: ${JSON.stringify(result)}`);
  info.annotations.push({ type: 'edit-latency', description: JSON.stringify(result) });

  const budget = info.project.name.endsWith('-dev') ? DEV_CEILING_MS : BUDGET_MS;
  for (const [name, xs] of Object.entries({
    setPieceChord: direct.chord,
    setPieceWalk: direct.walk,
    clickChord: uiChord,
    clickWalk: uiWalk,
  })) {
    expect(median(xs), `${name}: median edit → swap (ms)`).toBeLessThanOrEqual(budget);
  }
});
