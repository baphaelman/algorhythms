/**
 * The Live drawer (PLAN.md §9, §11.2; M7-b): opening it enters live mode, its settings reach the
 * live engine, the piano ruler plays, a (fake) MIDI device plays, the live lines are drawn, and
 * closing it leaves live mode so playback works again.
 */

import { expect, test, type Page } from '@playwright/test';
import { openEditor, type LiveWindow } from './live-hook';

test.skip(({ browserName }) => browserName === 'webkit', 'Chromium and Firefox are enough here');

const settings = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as LiveWindow).__algorhythms.live.engine().settings as Record<
        string,
        unknown
      >,
  );
const engineHeld = (page: Page) =>
  page.evaluate(() => (window as unknown as LiveWindow).__algorhythms.live.engine().held);

test('open → live; settings reach the engine; ruler, MIDI and lines; close → playback', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openEditor(page);
  await page.getByTestId('live-toggle').click();
  const drawer = page.getByTestId('live-drawer');
  await expect(drawer).toHaveAttribute('data-running', 'true');
  expect(
    await page.evaluate(() => {
      const h = (window as unknown as LiveWindow).__algorhythms;
      return { active: h.live.engine().active, playback: h.engine() !== null };
    }),
  ).toEqual({ active: true, playback: false });

  // Defaults (M7-a): unison, exact, hold, glide 0.25 s, no stagger.
  expect(await settings(page)).toMatchObject({
    single: 'unison',
    chord: 'exact',
    release: 'hold',
    glide: 0.25,
    stagger: 0,
  });
  await expect(page.getByTestId('live-single-unison')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('live-help')).toContainText('site-permission add-on');
  await expect(page.getByTestId('live-help')).toContainText('Safari has no Web MIDI');

  // Settings change → engine.
  await page.getByTestId('live-single-octaves').click();
  await page.getByTestId('live-chord-range').click();
  await page.getByTestId('live-release-fade').click();
  await page.getByTestId('live-glide').fill('127');
  await page.getByTestId('live-stagger').fill('0.5');
  await page.getByTestId('live-order').selectOption('low-first');
  expect(await settings(page)).toMatchObject({
    single: 'octaves',
    chord: 'range',
    release: 'fade',
    stagger: 0.5,
    order: 'low-first',
  });
  expect((await settings(page)).glide as number).toBeCloseTo(4, 6);
  await expect(page.getByTestId('live-release-fade')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('live-release-hold').click();
  await page.getByTestId('live-glide').fill('40');

  // The piano ruler plays: press, drag across keys (glide), release.
  const key = (p: number) => page.locator(`.piano-key[data-pitch="${p}"]`);
  const k1 = await key(60).boundingBox();
  const k2 = await key(64).boundingBox();
  expect(k1 && k2).toBeTruthy();
  await page.mouse.move(k1!.x + k1!.width / 2, k1!.y + k1!.height / 2);
  await page.mouse.down();
  await expect.poll(() => engineHeld(page)).toEqual([60]);
  await expect(key(60)).toHaveAttribute('data-held', '');
  await page.mouse.move(k2!.x + k2!.width / 2, k2!.y + k2!.height / 2, { steps: 4 });
  await expect.poll(() => engineHeld(page)).toEqual([64]);
  // The live lines are drawn while live.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as LiveWindow).__algorhythms.frameStats.liveSamples),
    )
    .toBeGreaterThan(5);
  await page.mouse.up();
  await expect.poll(() => engineHeld(page)).toEqual([]);
  await expect(key(64)).not.toHaveAttribute('data-held', '');

  // A fake MIDI device: notes with velocity, sustain, mod wheel → glide, bend, disconnect.
  await page.evaluate(async () => {
    const h = (window as unknown as LiveWindow).__algorhythms;
    type Input = {
      id: string;
      name: string;
      state: string;
      onmidimessage: ((e: { data: Uint8Array }) => void) | null;
    };
    const map = new Map<string, Input>();
    const access = {
      inputs: { forEach: (fn: (i: Input, k: string) => void) => map.forEach(fn) },
      onstatechange: null as ((e: unknown) => void) | null,
    };
    map.set('k', { id: 'k', name: 'Test keys', state: 'connected', onmidimessage: null });
    (window as unknown as { __midi: unknown }).__midi = {
      send: (bytes: number[]) => map.get('k')?.onmidimessage?.({ data: Uint8Array.from(bytes) }),
      unplug: () => {
        const i = map.get('k');
        if (!i) return;
        i.state = 'disconnected';
        map.delete('k');
        access.onstatechange?.({});
      },
    };
    await h.live.midi.connect(() => Promise.resolve(access));
  });
  await expect(page.getByTestId('live-midi-status')).toHaveText('Listening to Test keys.');
  const midi = (bytes: number[]) =>
    page.evaluate(
      (b) => (window as unknown as { __midi: { send(b: number[]): void } }).__midi.send(b),
      bytes,
    );
  await midi([0x90, 67, 64]);
  await expect.poll(() => engineHeld(page)).toEqual([67]);
  const vel = await page.evaluate(() =>
    (window as unknown as LiveWindow).__algorhythms.live.engine().events.at(-1),
  );
  expect(vel).toMatchObject({ kind: 'on', pitch: 67 });
  expect(vel!.velocity).toBeCloseTo(64 / 127, 6);
  await midi([0x90, 67, 0]); // note on, velocity 0: off
  await expect.poll(() => engineHeld(page)).toEqual([]);
  await midi([0xb0, 64, 127, 0x90, 62, 90, 0x80, 62, 0]); // pedal down holds the note
  await expect.poll(() => engineHeld(page)).toEqual([62]);
  await midi([0xb0, 64, 0]);
  await expect.poll(() => engineHeld(page)).toEqual([]);
  await midi([0xb0, 1, 127]); // mod wheel: glide 4 s, and the panel follows
  expect((await settings(page)).glide as number).toBeCloseTo(4, 6);
  await expect(page.getByTestId('live-glide')).toHaveValue('127');
  await midi([0xe0, 127, 127]); // bend +2
  expect(
    await page.evaluate(
      () => (window as unknown as LiveWindow).__algorhythms.live.engine().bendSemitones,
    ),
  ).toBeCloseTo(2, 6);
  await midi([0xe0, 0, 64]);
  await midi([0x90, 70, 100]);
  await expect.poll(() => engineHeld(page)).toEqual([70]);
  await page.evaluate(() => (window as unknown as { __midi: { unplug(): void } }).__midi.unplug());
  await expect.poll(() => engineHeld(page)).toEqual([]);
  await expect(page.getByTestId('live-midi-status')).toHaveText('No MIDI devices connected.');
  await page.evaluate(() => (window as unknown as LiveWindow).__algorhythms.live.midi.disconnect());

  // Live stays open with the Sound drawer (mix edits while live are heard; tests/dsp/live.test.ts).
  await page.getByTestId('sound-toggle').click();
  await expect(page.getByTestId('sound-drawer')).toBeVisible();
  await expect(drawer).toBeVisible();

  // Close → live mode ends; playback works again.
  await page.getByLabel('Close live drawer').click();
  await expect(drawer).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as LiveWindow).__algorhythms.live.engine().active),
    )
    .toBe(false);
  await page.getByTestId('play').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as LiveWindow).__algorhythms.store.getState().transport;
        return `${s.status}/${s.audio}`;
      }),
    )
    .toBe('playing/ready');
  expect(
    await page.evaluate(
      () => (window as unknown as LiveWindow).__algorhythms.frameStats.liveSamples,
    ),
  ).toBe(0);
});
