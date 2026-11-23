/** A chip's fit mark from its rank (§11.3 rev 14): the best fit, then the next two. */
export function fitOf(rank: number | undefined): 'best' | 'good' | undefined {
  return rank === undefined ? undefined : rank === 0 ? 'best' : rank <= 2 ? 'good' : undefined;
}
