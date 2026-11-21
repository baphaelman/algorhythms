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
 */

import { hash32 } from '../rng';
import { IntentKind, type Intent, type MomentPlan } from '../moments/types';
import type { Pitch } from '../types';
import { foldIntoRange } from './range';
import type { VoiceRun } from './voice';

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
 * `dormant`: pool voices free to stand in as phantoms, in pool order.
 */
export function expand(
  voices: readonly VoiceRun[],
  lines: readonly number[],
  dormant: readonly number[],
  dest: (v: number) => Pitch,
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
    if (voices[b].count > 1) stacked = true;
  }
  if (!stacked)
    return { pool, base, copies, reserved, synthId, synthHash, active: lines.slice(), stacked };
  // Former members first, then any dormant voice, then synthetic.
  const add = (b: number, u: number): void => {
    base.set(u, b);
    copies.get(b)!.push(u);
  };
  for (const b of lines) {
    const run = voices[b];
    for (const u of run.members) {
      if (copies.get(b)!.length >= run.count) break;
      if (free.has(u)) {
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
      const u = rest.shift();
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
  /** Some fork found no free pool voice and stayed on its line. */
  exhausted: number;
}

const key = (p: Pitch): number => Math.round(p * 1e6);

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
    if (it.voice < 0) {
      const u = free.length > 0 ? takeFor(free, it.to, voices) : undefined;
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
  });
  // A dying line merges into whatever now carries its absorber.
  for (const d of deaths) {
    const c = d.into >= 0 ? carrierOf.get(d.into) : undefined;
    if (c) d.it.into = c.kind === IntentKind.Death ? -1 : c.voice;
    else d.it.into = d.into >= 0 ? (x.base.get(d.into) ?? -1) : -1;
    if (d.it.into === d.it.voice) d.it.into = -1;
  }
  // Births from the moment itself fork from the line their parent belongs to.
  for (const it of births) {
    const p = it.parent ?? -1;
    intents.push({ ...it, parent: p >= 0 ? (x.base.get(p) ?? p) : p });
  }
  const out: MomentPlan = { ordered: plan.ordered, intents };
  if (plan.note) {
    const c = carrierOf.get(plan.intents[plan.note.intent].voice);
    const j = c ? intents.indexOf(c) : -1;
    if (j >= 0) out.note = { intent: j, from: plan.note.from };
  }
  return { plan: out, forks, lose, keep, exhausted };
}
