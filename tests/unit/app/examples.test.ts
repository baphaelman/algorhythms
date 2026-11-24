/**
 * The examples menu (PLAN.md §11.1): songs, then experiments (Crease, then Night Sleeper, pinned at
 * the top, owner 2026-11-23), then the originals; the rest of each group by title.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES, EXPERIMENTS, ORIGINALS, PINNED, SONGS } from '../../../src/app/examples';

describe('examples', () => {
  it('pinned experiments come first, in order', () => {
    expect(EXPERIMENTS.slice(0, PINNED.length).map((e) => e.id)).toEqual([...PINNED]);
    expect(EXPERIMENTS[0].title).toBe('Crease');
    expect(EXPERIMENTS[1].title).toBe('Night Sleeper');
  });

  it('the rest of each group is sorted by title', () => {
    const titles = (xs: readonly { title: string }[]) => xs.map((e) => e.title);
    const sorted = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b));
    const rest = EXPERIMENTS.slice(PINNED.length);
    expect(titles(rest)).toEqual(sorted(titles(rest)));
    expect(titles(SONGS)).toEqual(sorted(titles(SONGS)));
    expect(titles(ORIGINALS)).toEqual(sorted(titles(ORIGINALS)));
  });

  it('holds eight songs, four experiments, five originals', () => {
    expect([SONGS.length, EXPERIMENTS.length, ORIGINALS.length]).toEqual([8, 4, 5]);
    expect(SONGS.map((e) => e.group)).toEqual(SONGS.map(() => 'songs'));
  });

  it('menu order is songs, experiments, originals', () => {
    expect(EXAMPLES).toEqual([...SONGS, ...EXPERIMENTS, ...ORIGINALS]);
  });
});
