/**
 * Distinct notes (PLAN.md §11.3 revision 8): moments see lines as stacked logical voices.
 *
 * Sounding lines never share a resting pitch, so a line can stand for several voices (`count`,
 * after merges) and carries a weight (its loudness). A point moment's function runs on the
 * *logical* voices: each line of count k appears k times (the line itself plus k − 1 phantoms),
 * exactly as stacked voices did before revision 8, so a unison followed by a 12-note chord still
 * voices 12 notes. `collapse` then maps the logical intents back onto pool voices:
 * - a line's copies going to one pitch stay one line; copies going elsewhere split off as births
 *   from the line (forks), taking their share of its count and weight;
 * - copies that die (a merge, a chord `count`) take their share of the weight with them;
 * - lines sent to the same pitch glide there and merge on arrival (compile.ts `onJoin`).
 * Phantoms use dormant pool voices (the line's former members first), so their keyed draws and
 * ranges are those of the voices they were; with none left, a synthetic index ≥ the pool size.
 *
 * Moments that set how many notes sound (`split`, `merge`, a chord with `count`) count lines, not
 * stacked voices (owner, 2026-11-21): they see each line once (`countsLines`), and a newborn whose
 * parent stands for several voices forks off with a share of them (`collapse`).
 */

import { hash32 } from '../rng';
import { IntentKind, type Intent, type MomentPlan } from '../moments/types';
import type { Moment, Pitch } from '../types';
import { foldIntoRange } from './range';
import type { VoiceRun } from './voice';

/**
 * True for moments whose count is a number of lines heard after them (owner, 2026-11-21), and for
 * tunes, which see each line once.
 */
export function countsLines(m: Moment): boolean {
  return (
    m.type === 'split' ||
    m.type === 'merge' ||
    m.type === 'tune' || // a tune moves its whole line (revision 9)
    (m.type === 'chord' && m.count !== undefined)
  );
}

/** Logical voices of the active lines at one moment. */
export interface Expansion {
  /** Pool size; logical indices ≥ this are synthetic phantoms. */
  readonly pool: number;
  /** Logical voice → the line (pool index) it belongs to. */
  readonly base: Map<number, number>;
  /** Line → its logical voices, the line itself first. */
  readonly copies: Map<number, number[]>;
  /** Dormant pool voices standing in as phantoms. */
  readonly reserved: Set<number>;
  /** Synthetic phantoms: id and hash by (index − pool). */
  readonly synthId: string[];
  readonly synthHash: number[];
  /** Every logical voice, sorted by its line's committed destination, ties by index. */
  active: number[];
  /** Some line stands for more than one voice. */
  readonly stacked: boolean;
}

/**
 * Builds the logical voices of the active lines `lines` (sorted by committed destination).
 * `dormant`: pool voices free to stand in as phantoms, in pool order. `flat`: one per line
 * (`countsLines`).
 */
export function expand(
  voices: readonly VoiceRun[],
  lines: readonly number[],
  dormant: readonly number[],
  dest: (v: number) => Pitch,
  flat = false,
): Expansion {
  const pool = voices.length;
  const base = new Map<number, number>();
  const copies = new Map<number, number[]>();
  const reserved = new Set<number>();
  const synthId: string[] = [];
  const synthHash: number[] = [];
  let stacked = false;
  const free = new Set(dormant);
  for (const b of lines) {
    base.set(b, b);
    copies.set(b, [b]);
    if (voices[b].count > 1 && !flat) stacked = true;
  }
  if (!stacked)
    return { pool, base, copies, reserved, synthId, synthHash, active: lines.slice(), stacked };
  // Former members first, then any dormant voice, then synthetic; only voices of the line's part
  // (revision 9), since a phantom may split off as that voice.
  const add = (b: number, u: number): void => {
    base.set(u, b);
    copies.get(b)!.push(u);
  };
  for (const b of lines) {
    const run = voices[b];
    for (const u of run.members) {
      if (copies.get(b)!.length >= run.count) break;
      if (free.has(u) && voices[u].part === run.part) {
        free.delete(u);
        reserved.add(u);
        add(b, u);
      }
    }
  }
  const rest = [...free].sort((a, b) => a - b);
  for (const b of lines) {
    const run = voices[b];
    let j = 0;
    while (copies.get(b)!.length < run.count) {
      const j0 = rest.findIndex((v) => voices[v].part === run.part);
      const u = j0 < 0 ? undefined : rest.splice(j0, 1)[0];
      if (u !== undefined) {
        reserved.add(u);
        add(b, u);
      } else {
        const id = `${run.id}~${++j}`;
        add(b, pool + synthId.length);
        synthId.push(id);
        synthHash.push(hash32(id));
      }
    }
  }
  const active: number[] = [];
  for (const b of lines) for (const u of copies.get(b)!) active.push(u);
  active.sort((a, b) => dest(base.get(a)!) - dest(base.get(b)!) || a - b);
  return { pool, base, copies, reserved, synthId, synthHash, active, stacked };
}

/** A fork: a newborn that takes part of a line (revision 8). */
export interface Fork {
  parent: number;
  count: number;
  weight: number;
  members: number[];
}

export interface Collapsed {
  /** Intents on pool voices. */
  plan: MomentPlan;
  /** Births that fork a weighted line, by newborn. */
  forks: Map<number, Fork>;
  /** Per surviving line: logical voices and weight lost to dying copies. */
  lose: Map<number, { count: number; weight: number }>;
  /** Per surviving line that split: its count and members after the moment. */
  keep: Map<number, { count: number; members: number[] }>;
  /**
   * Per line (or newborn): voices and weight it takes from newborns that were not born, their
   * note being its own (weight may be negative: a parent's share passed on).
   */
  absorb: Map<number, { count: number; weight: number }>;
  /** Newborns and forks not born (their note already sounds). */
  absorbed: number;
  /** Some fork found no free pool voice and stayed on its line. */
  exhausted: number;
}

const key = (p: Pitch): number => Math.round(p * 1e6);

/** Weight tolerance (weights are sums of shares). */
const EPS = 1e-9;

/** k split into n near-even whole parts, larger first. */
const shares = (k: number, n: number): number[] =>
  Array.from({ length: n }, (_, j) => Math.floor(k / n) + (j < k % n ? 1 : 0));

/** Removes and returns the first voice of `list` whose range holds `p` (else the first; −1). */
function takeFor(list: number[], p: Pitch, voices: readonly VoiceRun[]): number {
  if (list.length === 0) return -1;
  let j = list.findIndex((u) => voices[u].range[0] <= p && p <= voices[u].range[1]);
  if (j < 0) j = 0;
  return list.splice(j, 1)[0];
}

/**
 * Maps a logical plan back onto pool voices (see the module comment). `targeted`: the targeted
 * logical voices; `freeDormant`: pool voices the moment function could have birthed (unreserved).
 * Does not change `plan`.
 */
export function collapse(
  x: Expansion,
  plan: MomentPlan,
  targeted: readonly number[],
  voices: readonly VoiceRun[],
  dest: (u: number) => Pitch,
  freeDormant: readonly number[],
): Collapsed {
  const forks = new Map<number, Fork>();
  const lose = new Map<number, { count: number; weight: number }>();
  const keep = new Map<number, { count: number; members: number[] }>();
  const intents: Intent[] = [];
  const intentOf = new Map<number, Intent>();
  const births: Intent[] = [];
  for (const it of plan.intents) {
    if (it.kind === IntentKind.Birth) births.push(it);
    else intentOf.set(it.voice, it);
  }
  const touched = new Set<number>();
  for (const u of targeted) touched.add(x.base.get(u) ?? u);
  for (const u of intentOf.keys()) touched.add(x.base.get(u) ?? u);
  const used = new Set<number>(births.map((b) => b.voice));
  /** Logical voice → the pool intent that now carries it. */
  const carrierOf = new Map<number, Intent>();
  const deaths: { it: Intent; into: number }[] = [];
  const pendingForks: { b: number; to: Pitch; members: number[] }[] = [];
  const pendingIntents: Intent[] = [];
  for (const b of x.active) {
    if (!touched.has(b) || x.base.get(b) !== b) continue;
    const cs = x.copies.get(b)!;
    const k = cs.length;
    const W = voices[b].weight;
    const groups: { key: number; to: Pitch; us: number[] }[] = [];
    const dying: number[] = [];
    for (const u of cs) {
      const it = intentOf.get(u);
      if (it?.kind === IntentKind.Death) {
        dying.push(u);
        continue;
      }
      const to = it ? it.to : dest(u);
      // The copies of a line are one note: grouped in the line's own range.
      const r = voices[b].range;
      const kk = key(Number.isFinite(to) ? foldIntoRange(to, r[0], r[1]).p : to);
      let g = groups.find((x) => x.key === kk);
      if (!g) groups.push((g = { key: kk, to, us: [] }));
      g.us.push(u);
    }
    if (groups.length === 0) {
      const lead = intentOf.get(b) ?? intentOf.get(dying[0])!;
      const d: Intent = { voice: b, to: lead.to, kind: IntentKind.Death, fade: lead.fade };
      intents.push(d);
      deaths.push({ it: d, into: lead.into ?? -1 });
      for (const u of cs) carrierOf.set(u, d);
      continue;
    }
    // Canonical, whatever copy went where (stacked copies are interchangeable): the line keeps
    // the group nearest where it was heading (ties: lower); the other groups, low to high, take
    // the line's phantom pool voices, low to high.
    groups.sort((g, h) => g.to - h.to);
    const d0 = dest(b);
    const primary = groups.reduce((a, g) => {
      const da = Math.abs(a.to - d0);
      const dg = Math.abs(g.to - d0);
      return dg < da || (dg === da && g.to < a.to) ? g : a;
    });
    const mv: Intent = { voice: b, to: primary.to, kind: IntentKind.Move };
    if (cs.some((u) => intentOf.has(u))) intents.push(mv);
    for (const u of primary.us) carrierOf.set(u, mv);
    if (dying.length > 0) lose.set(b, { count: dying.length, weight: (W * dying.length) / k });
    const spare = cs
      .filter((u) => u !== b && u < x.pool && x.reserved.has(u))
      .sort((p, q) => p - q);
    const forkGroups = groups.filter((g) => g !== primary);
    const carriers = forkGroups.map((g) => takeFor(spare, g.to, voices));
    const membersOf = (n: number): number[] => spare.splice(0, Math.max(0, n));
    if (x.stacked)
      keep.set(b, {
        count: primary.us.length,
        members: [
          ...voices[b].members.filter((u) => !x.reserved.has(u)),
          ...membersOf(primary.us.length - 1),
        ],
      });
    forkGroups.forEach((g, j) => {
      const it: Intent = { voice: carriers[j], to: g.to, kind: IntentKind.Birth, parent: b };
      for (const u of g.us) carrierOf.set(u, it);
      if (it.voice >= 0) used.add(it.voice);
      pendingIntents.push(it);
      pendingForks.push({ b, to: g.to, members: membersOf(g.us.length - 1) });
    });
  }
  // Notes already taken after the moment: line moves and the lines it leaves alone. A fork or
  // newborn bound for a note taken by its own parent, or by a sibling from the same parent (it
  // would move with it as one line), is not born: its voices and weight join that line instead.
  // Bound for another line's note, it glides there and merges on arrival (compile.ts onJoin).
  const absorb = new Map<number, { count: number; weight: number }>();
  const add = (v: number, count: number, weight: number): void => {
    const a = absorb.get(v);
    if (a) {
      a.count += count;
      a.weight += weight;
    } else absorb.set(v, { count, weight });
  };
  // A note is taken per part (revision 9): lines of another part may sound it too.
  const fold = (v: number, p: Pitch): string => {
    const run = voices[v < x.pool ? v : x.base.get(v)!];
    const r = run.range;
    return `${run.part}\u0000${key(Number.isFinite(p) ? foldIntoRange(p, r[0], r[1]).p : p)}`;
  };
  let absorbed = 0;
  /** Folded note → the voice that takes it; voice → the line it starts from (−1: nowhere). */
  const held = new Map<string, number>();
  const origin = new Map<number, number>();
  const hold = (k: string, v: number, from: number): void => {
    if (held.has(k)) return;
    held.set(k, v);
    origin.set(v, from);
  };
  /** The voice taking `k` if it starts where `from` does (they would move as one line). */
  const sameLine = (k: string, from: number): number | undefined => {
    const r = held.get(k);
    return r !== undefined && origin.get(r) === from ? r : undefined;
  };
  const moved = new Set<number>();
  for (const it of intents) {
    moved.add(it.voice);
    if (it.kind !== IntentKind.Death) hold(fold(it.voice, it.to), it.voice, it.voice);
  }
  for (const b of x.active) {
    if (x.base.get(b) !== b || moved.has(b)) continue;
    hold(fold(b, dest(b)), b, b);
  }
  // Forks without a phantom of their own take any other free pool voice.
  const free = [
    ...[...x.reserved].filter((u) => !used.has(u)),
    ...freeDormant.filter((u) => !used.has(u)),
  ].sort((a, b) => a - b);
  let exhausted = 0;
  pendingIntents.forEach((it, j) => {
    const pf = pendingForks[j];
    let n = 0;
    for (const c of carrierOf.values()) if (c === it) n++;
    const r = sameLine(fold(pf.b, it.to), pf.b);
    if (r !== undefined) {
      absorbed++;
      const w = (voices[pf.b].weight * n) / x.copies.get(pf.b)!.length;
      add(r, n, w);
      add(pf.b, 0, -w);
      const to = intents.find((m) => m.voice === r && m.kind !== IntentKind.Death);
      for (const [u2, c] of carrierOf) {
        if (c !== it) continue;
        if (to) carrierOf.set(u2, to);
        else carrierOf.delete(u2);
      }
      return;
    }
    if (it.voice < 0) {
      const own = free.filter((v) => voices[v].part === voices[pf.b].part);
      const u = own.length > 0 ? takeFor(own, it.to, voices) : undefined;
      if (u !== undefined) free.splice(free.indexOf(u), 1);
      if (u === undefined) {
        // No pool voice left: these copies stay on their line.
        exhausted++;
        keep.get(pf.b)!.count += n;
        const line = intents.find((m) => m.voice === pf.b && m.kind === IntentKind.Move);
        if (line) for (const [u2, c] of carrierOf) if (c === it) carrierOf.set(u2, line);
        return;
      }
      it.voice = u;
      used.add(u);
    }
    forks.set(it.voice, {
      parent: pf.b,
      count: n,
      weight: (voices[pf.b].weight * n) / x.copies.get(pf.b)!.length,
      members: pf.members.filter((u) => u !== it.voice),
    });
    intents.push(it);
    hold(fold(it.voice, it.to), it.voice, pf.b);
  });
  /** Weight line b keeps after its copies above forked, died or joined other lines. */
  const kept = new Map<number, number>();
  for (const b of x.active) {
    if (x.base.get(b) !== b) continue;
    let w = voices[b].weight - (lose.get(b)?.weight ?? 0) + (absorb.get(b)?.weight ?? 0);
    for (const f of forks.values()) if (f.parent === b) w -= f.weight;
    kept.set(b, w);
  }
  // A dying line merges into whatever now carries its absorber.
  for (const d of deaths) {
    const c = d.into >= 0 ? carrierOf.get(d.into) : undefined;
    if (c) d.it.into = c.kind === IntentKind.Death ? -1 : c.voice;
    else d.it.into = d.into >= 0 ? (x.base.get(d.into) ?? -1) : -1;
    if (d.it.into === d.it.voice) d.it.into = -1;
  }
  // Births from the moment itself fork from the line their parent belongs to. A parent line that
  // still stands for several voices shares them out evenly with its newborns (the parent first,
  // then the newborns low to high); newborns past its count are fresh voices (count 1). A
  // newborn bound for a note that another line already sounds or heads to (more notes asked for
  // than there are, owner 2026-11-21) is not born: its share, or its fresh voice, joins that line.
  //
  // Weight (2026-11-22): a merge or `count` death hands on weight but not count, so a line can
  // weigh more than its count while the voices merged into it are dormant again. A split that
  // brings voices back takes their weight rather than adding fresh voices': a heavy parent
  // (weight above its count) shares its weight evenly over the voices of its lines (count shares,
  // one per fresh newborn), at least one per voice; the weight left above one per voice, and the
  // weight above their count of the other lines the moment touches, goes to the part's fresh
  // voices, each line giving in proportion. So a line never weighs more than the voices that fed
  // it, and a merge then a split back restores every line's weight.
  const mapped = births
    .map((it) => {
      const p = it.parent ?? -1;
      return { ...it, parent: p >= 0 ? (x.base.get(p) ?? p) : p };
    })
    .sort((p, q) => p.to - q.to || p.voice - q.voice);
  const into = new Map<number, number>();
  for (const it of mapped) {
    const k = fold(it.voice, it.to);
    const r = sameLine(k, it.parent!);
    if (r !== undefined) {
      absorbed++;
      into.set(it.voice, r);
      if (it.parent! < 0) add(r, 1, 1);
    } else {
      hold(k, it.voice, it.parent!);
      intents.push(it);
    }
  }
  const byParent = new Map<number, Intent[]>();
  for (const it of mapped) {
    const b = it.parent ?? -1;
    if (b < 0) continue;
    let list = byParent.get(b);
    if (!list) byParent.set(b, (list = []));
    list.push(it);
  }
  const partOf = (v: number): string => voices[v < x.pool ? v : x.base.get(v)!].part;
  /** Per part: weight fresh voices add. Per line: weight above one per voice it can give. */
  const demand = new Map<string, number>();
  const supply = new Map<number, number>();
  const need = (p: string, w: number): void => {
    if (w > EPS) demand.set(p, (demand.get(p) ?? 0) + w);
  };
  for (const it of mapped) if (it.parent! < 0) need(partOf(it.voice), 1);
  const groups = [...byParent].map(([b, list]) => {
    const k = keep.get(b)?.count ?? voices[b].count;
    const W = kept.get(b) ?? voices[b].weight;
    const L = list.length + 1;
    const parts = shares(k, Math.min(L, Math.max(1, k)));
    // Voices of its lines after the moment: count shares, then one per fresh newborn.
    const C = Math.max(k, L);
    const heavy = W > k + EPS;
    if (heavy) {
      need(voices[b].part, C - W);
      if (W > C + EPS) supply.set(b, W - C);
    } else need(voices[b].part, L - parts.length);
    return { b, list, k, W, parts, C, heavy };
  });
  for (const b of x.active) {
    if (x.base.get(b) !== b || !touched.has(b) || byParent.has(b)) continue;
    const k = keep.get(b)?.count ?? voices[b].count;
    const W = kept.get(b) ?? voices[b].weight;
    if (W > k + EPS) supply.set(b, W - k);
  }
  /** Weight each line gives the part's fresh voices. */
  const give = new Map<number, number>();
  for (const [p, d] of demand) {
    let s = 0;
    for (const [b, w] of supply) if (voices[b].part === p) s += w;
    if (s <= EPS) continue;
    const f = Math.min(1, d / s);
    for (const [b, w] of supply) if (voices[b].part === p) give.set(b, w * f);
  }
  for (const [b, g] of give) if (!byParent.has(b)) add(b, 0, -g);
  for (const { b, list, k, W, parts, C, heavy } of groups) {
    // Weight per voice slot: a light parent keeps the old shares (fresh newborns weigh 1).
    const u = heavy ? (Math.max(W, C) - (give.get(b) ?? 0)) / C : W / k;
    let mine = parts[0];
    list.forEach((it, j) => {
      const share = parts[j + 1] ?? 0;
      const c = share > 0 ? share : 1;
      // 0: a fresh voice.
      const w = share > 0 || heavy ? c * u : 0;
      const r = into.get(it.voice);
      if (r === undefined) {
        if (w > 0) forks.set(it.voice, { parent: b, count: c, weight: w, members: [] });
      } else if (w === 0) add(r, 1, 1);
      else if (r === b) mine += c;
      else {
        add(r, c, w);
        add(b, 0, -w);
      }
    });
    // A heavy parent ends at its own share: the forks take theirs from it; this adds what came
    // in for its fresh voices, or takes what went to the part's other fresh voices.
    if (heavy && Math.abs(u * C - W) > EPS) add(b, 0, u * C - W);
    if (k > 1 || into.size > 0) {
      const born = new Set(list.map((it) => it.voice));
      keep.set(b, {
        count: mine,
        members: (keep.get(b)?.members ?? voices[b].members).filter((u) => !born.has(u)),
      });
    }
  }
  const out: MomentPlan = { ordered: plan.ordered, intents };
  if (plan.notes) {
    const notes: { intent: number; from: Pitch }[] = [];
    for (const n of plan.notes) {
      const c = carrierOf.get(plan.intents[n.intent].voice);
      const j = c ? intents.indexOf(c) : -1;
      if (j >= 0 && !notes.some((q) => q.intent === j)) notes.push({ intent: j, from: n.from });
    }
    if (notes.length > 0) out.notes = notes;
  }
  return { plan: out, forks, lose, keep, absorb, absorbed, exhausted };
}
