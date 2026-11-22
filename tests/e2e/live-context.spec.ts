/**
 * §9 "Latency" / §15 M7 item: live mode uses an 'interactive' context (§8.3). Every AudioContext
 * the page creates is logged with its latencyHint (a wrapper installed before the app loads).
 * Opening the Live drawer and arming Record each create an 'interactive' context; closing the
 * drawer and pressing Play returns to a 'playback' one.
 */

import { expect, test, type Page } from '@playwright/test';
import { openEditor } from './live-hook';

test.skip(({ browserName }) => browserName === 'webkit', 'Chromium and Firefox are enough here');

type Log = { __contexts: string[] };
type RecordHook = {
  __algorhythms: { live: { record: { state: { getState(): { status: string } } } } };
};

const hints = (page: Page) => page.evaluate(() => (window as unknown as Log).__contexts.slice());

test('the Live drawer and Record run on an interactive context; closing returns to playback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as Log).__contexts = log;
    const Base = window.AudioContext;
    class Logged extends Base {
      constructor(opts?: AudioContextOptions) {
        super(opts);
        log.push(String(opts?.latencyHint ?? 'default'));
      }
    }
    window.AudioContext = Logged;
  });
  await openEditor(page);

  await page.getByTestId('live-toggle').click();
  await expect(page.getByTestId('live-drawer')).toHaveAttribute('data-running', 'true');
  expect((await hints(page)).at(-1)).toBe('interactive');

  const before = (await hints(page)).length;
  await page.getByTestId('live-record').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as RecordHook).__algorhythms.live.record.state.getState().status,
      ),
    )
    .toBe('recording');
  const armed = await hints(page);
  expect(armed.length).toBeGreaterThan(before);
  expect(armed.at(-1)).toBe('interactive');
  await page.getByTestId('live-record').click();

  await page.getByLabel('Close live drawer').click();
  await expect(page.getByTestId('live-drawer')).toHaveCount(0);
  await page.getByTestId('play').click();
  await expect.poll(async () => (await hints(page)).at(-1)).toBe('playback');
});
