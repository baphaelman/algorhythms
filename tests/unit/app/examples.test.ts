/**
 * The examples menu (PLAN.md §11.1): the originals by title, then the compositions with the pinned
 * ones first (owner, 2026-11-23: Crease, then Night Sleeper, at the top) and the rest by title.
 */
import { describe, expect, it } from 'vitest';
import { COMPOSITIONS, EXAMPLES, ORIGINALS, PINNED } from '../../../src/app/examples';

describe('examples', () => {
  it('pinned compositions come first, in order', () => {
    expect(COMPOSITIONS.slice(0, PINNED.length).map((e) => e.id)).toEqual([...PINNED]);
    expect(COMPOSITIONS[0].title).toBe('Crease');
    expect(COMPOSITIONS[1].title).toBe('Night Sleeper');
  });

  it('the rest of each group is sorted by title', () => {
    const titles = (xs: readonly { title: string }[]) => xs.map((e) => e.title);
    const rest = COMPOSITIONS.slice(PINNED.length);
    expect(titles(rest)).toEqual([...titles(rest)].sort((a, b) => a.localeCompare(b)));
    expect(titles(ORIGINALS)).toEqual([...titles(ORIGINALS)].sort((a, b) => a.localeCompare(b)));
  });

  it('originals come before compositions', () => {
    expect(EXAMPLES).toEqual([...ORIGINALS, ...COMPOSITIONS]);
  });
});
