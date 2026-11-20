/**
 * Voice leading: which voice goes to which target (PLAN.md §7.2).
 *
 * Callers pass the voices' pitches `p` sorted ascending (by committed destination, ties broken by
 * pool index) and the targets `q` sorted ascending. Every function returns `f`, where f[i] is the
 * index into `q` of voice i's target.
 *
 * - `ordered` (lines never cross at their endpoints):
 *   - k = a: identity;
 *   - k > a: injective, order-preserving, minimising Σ|p_i − q_f(i)|; a DP in O(a·k);
 *   - k < a: surjective (every target gets a voice), non-decreasing, same cost; a DP in O(a·k).
 * - `free`: the Hungarian algorithm on |p − q|, which may cross. k < a pads with "nearest target"
 *   columns, so every target still gets at least one voice; k > a leaves targets unmatched.
 *
 * Only + − and comparisons on the inputs, so results are identical on every engine (§7.11).
 * Ties are broken by a fixed rule (documented per function), never by input order of equal keys.
 */

/** f[i] = index of voice i's target in q. */
export type Assignment = number[];

/** Order-preserving assignment for any a ≥ 0 and k ≥ 1 (identity, injective or surjective). */
export function assignOrdered(p: readonly number[], q: readonly number[]): Assignment {
  const a = p.length;
  const k = q.length;
  if (a === 0) return [];
  if (k === 0) throw new RangeError('assignOrdered: no targets');
  if (k === a) return p.map((_, i) => i);
  return k > a ? assignInjective(p, q) : assignSurjective(p, q);
}

/**
 * Injective, order-preserving map of a sorted voices to k ≥ a sorted targets minimising total
 * movement (the prototype's `assign`). Ties prefer matching voice i to the earlier target.
 */
export function assignInjective(p: readonly number[], q: readonly number[]): Assignment {
  const a = p.length;
  const k = q.length;
  if (k < a) throw new RangeError('assignInjective: fewer targets than voices');
  const w = k + 1;
  // dp[i·w + j]: least cost of matching voices 0..i−1 into targets 0..j−1. take[·] = 1 when voice
  // i−1 is matched to target j−1 on the optimal path.
  const dp = new Float64Array((a + 1) * w);
  const take = new Uint8Array((a + 1) * w);
  for (let i = 1; i <= a; i++) {
    for (let j = 0; j < i; j++) dp[i * w + j] = Infinity;
    for (let j = i; j <= k; j++) {
      const skip = dp[i * w + j - 1];
      const t = dp[(i - 1) * w + j - 1] + Math.abs(p[i - 1] - q[j - 1]);
      if (t <= skip) {
        dp[i * w + j] = t;
        take[i * w + j] = 1;
      } else {
        dp[i * w + j] = skip;
      }
    }
  }
  const f = new Array<number>(a);
  let i = a;
  let j = k;
  while (i > 0) {
    if (take[i * w + j]) {
      f[i - 1] = j - 1;
      i--;
    }
    j--;
  }
  return f;
}

/**
 * Surjective, non-decreasing map of a sorted voices onto k ≤ a sorted targets (every target gets
 * at least one voice) minimising total movement. New in M1 (§7.2). Ties prefer moving on to the
 * next target as early as possible when walking back from the top, i.e. doubling goes to the
 * lower voices.
 */
export function assignSurjective(p: readonly number[], q: readonly number[]): Assignment {
  const a = p.length;
  const k = q.length;
  if (k > a) throw new RangeError('assignSurjective: more targets than voices');
  if (k === 0) throw new RangeError('assignSurjective: no targets');
  // dp[i·k + j]: least cost with voice i on target j and targets 0..j all covered by voices 0..i.
  const dp = new Float64Array(a * k).fill(Infinity);
  dp[0] = Math.abs(p[0] - q[0]);
  for (let i = 1; i < a; i++) {
    const jMax = i < k - 1 ? i : k - 1;
    for (let j = 0; j <= jMax; j++) {
      const stay = dp[(i - 1) * k + j];
      const adv = j > 0 ? dp[(i - 1) * k + j - 1] : Infinity;
      dp[i * k + j] = Math.abs(p[i] - q[j]) + (adv <= stay ? adv : stay);
    }
  }
  const f = new Array<number>(a);
  let j = k - 1;
  for (let i = a - 1; i >= 0; i--) {
    f[i] = j;
    if (i === 0) break;
    const stay = dp[(i - 1) * k + j];
    const adv = j > 0 ? dp[(i - 1) * k + j - 1] : Infinity;
    if (adv <= stay) j--;
  }
  return f;
}

/**
 * Free assignment (§7.2 `free`): minimum Σ|p − q| with crossings allowed, by the Hungarian
 * algorithm. For k < a, a − k extra columns let a voice take its nearest target (ties: the lower
 * target), so every real target is still covered. For k > a, some targets stay unmatched.
 */
export function assignFree(p: readonly number[], q: readonly number[]): Assignment {
  const a = p.length;
  const k = q.length;
  if (a === 0) return [];
  if (k === 0) throw new RangeError('assignFree: no targets');
  const m = k >= a ? k : a;
  const cost = new Float64Array(a * m);
  const nearest = new Array<number>(a);
  for (let i = 0; i < a; i++) {
    let best = 0;
    for (let j = 0; j < k; j++) {
      const c = Math.abs(p[i] - q[j]);
      cost[i * m + j] = c;
      if (c < cost[i * m + best]) best = j;
    }
    nearest[i] = best;
    for (let j = k; j < m; j++) cost[i * m + j] = cost[i * m + best];
  }
  const cols = hungarian(cost, a, m);
  return cols.map((c, i) => (c < k ? c : nearest[i]));
}

/**
 * Minimum-cost assignment of n rows to distinct columns of an n × m cost matrix (n ≤ m), stored
 * row-major. Returns the column of each row. The classic O(n²·m) potentials method; deterministic
 * (scans columns in index order and keeps the first minimum).
 */
export function hungarian(cost: Float64Array, n: number, m: number): number[] {
  if (n > m) throw new RangeError('hungarian: more rows than columns');
  // 1-based arrays as in the textbook formulation; column 0 is a virtual start.
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const rowOf = new Int32Array(m + 1); // rowOf[j]: row matched to column j (0 = none)
  const way = new Int32Array(m + 1);
  const minv = new Float64Array(m + 1);
  const used = new Uint8Array(m + 1);
  for (let i = 1; i <= n; i++) {
    rowOf[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = rowOf[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[(i0 - 1) * m + (j - 1)] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      if (j1 === 0) {
        // Only non-finite reduced costs are left (NaN or ±∞ in `cost`): take the first unused
        // column at no cost, so the search always ends (it would otherwise never terminate).
        for (let j = 1; j <= m && j1 === 0; j++) if (!used[j]) j1 = j;
        delta = 0;
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[rowOf[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (rowOf[j0] !== 0);
    do {
      const j1 = way[j0];
      rowOf[j0] = rowOf[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const out = new Array<number>(n);
  for (let j = 1; j <= m; j++) if (rowOf[j] !== 0) out[rowOf[j] - 1] = j - 1;
  return out;
}

/** Total movement Σ|p_i − q_f(i)| of an assignment. */
export function assignmentCost(p: readonly number[], q: readonly number[], f: Assignment): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[f[i]]);
  return s;
}
