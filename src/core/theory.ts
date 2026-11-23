/**
 * Chord theory for Next (PLAN.md §11.3, revision 14 "Theory-aware Next"): each chord a key offers
 * has a job; the progression so far is read from the compiled harmony; candidates are ranked by
 * transition, loop completion, phrase position and shared tones. A port of the owner-approved
 * demo (docs/design/moments-rethought.html: VOCAB, TRANS, GENERIC, LOOPS, rankNext, pickCards,
 * bestBetween, pickerScores).
 *
 * Chords are named by ASCII numerals on the major-scale ruler ('I', 'bVII', 'vii°', 'V/V'), as
 * core/chords.ts parses them; pitch classes and letter names come from there and core/harmony.
 *
 * Pure: string work and integer arithmetic only (§7.11).
 */

import { parseChord } from './chords';
import { harmonyLabel } from './harmony';
import { mod } from './math';
import { keyAt } from './query';
import { SCALES, pitchClassOf, scaleIntervals } from './scales';
import type { CompiledScore, Key, Seconds } from './types';

/** A chord's job (PLAN §11.3). 'soft' reads "Near home", 'colour' reads "Surprise". */
export type Job = 'home' | 'soft' | 'lift' | 'tension' | 'colour';
export type Family = 'major' | 'minor';
export type Quality = 'maj' | 'min' | 'dom' | 'dim';

/** The words a card shows for each job. */
export const JOB_LABEL: Readonly<Record<Job, string>> = {
  home: 'Home',
  soft: 'Near home',
  lift: 'Lift',
  tension: 'Tension',
  colour: 'Surprise',
};

type Entry = readonly [num: string, quality: Quality, job: Job];

/** The family vocabularies, function chords first (the demo's VOCAB). */
const VOCAB: Readonly<Record<Family, readonly Entry[]>> = {
  major: [
    ['I', 'maj', 'home'],
    ['ii', 'min', 'lift'],
    ['iii', 'min', 'soft'],
    ['IV', 'maj', 'lift'],
    ['V', 'dom', 'tension'],
    ['vi', 'min', 'soft'],
    ['vii°', 'dim', 'tension'],
    ['iv', 'min', 'colour'],
    ['bVI', 'maj', 'colour'],
    ['bVII', 'maj', 'colour'],
    ['V/V', 'dom', 'colour'],
    ['V/vi', 'dom', 'colour'],
    ['V/IV', 'dom', 'colour'],
  ],
  minor: [
    ['i', 'min', 'home'],
    ['ii°', 'dim', 'lift'],
    ['bIII', 'maj', 'soft'],
    ['iv', 'min', 'lift'],
    ['v', 'min', 'tension'],
    ['V', 'dom', 'tension'],
    ['bVI', 'maj', 'lift'],
    ['bVII', 'dom', 'tension'],
    ['IV', 'dom', 'colour'],
    ['bII', 'maj', 'colour'],
  ],
};

/**
 * The job a Surprise chord takes when all its tones (as a seventh chord) lie in the key's scale
 * (Dorian IV, Mixolydian ♭VII, Lydian II, Phrygian ♭II, melodic-minor IV7); null drops it
 * (Mixolydian I7 is the tonic itself).
 */
const MODAL_JOB: Readonly<Record<Family, Readonly<Record<string, Job | null>>>> = {
  major: {
    iv: 'lift',
    bVI: 'lift',
    bVII: 'tension',
    'V/V': 'lift',
    'V/vi': 'tension',
    'V/IV': null,
  },
  minor: { IV: 'lift', bII: 'tension' },
};

/** Transition weights a → b (the demo's TRANS). */
const TRANS: Readonly<Record<Family, Readonly<Record<string, Readonly<Record<string, number>>>>>> =
  {
    major: {
      I: {
        IV: 3,
        V: 3,
        vi: 3,
        ii: 1.5,
        iii: 0.7,
        bVII: 0.7,
        'V/vi': 0.45,
        bVI: 0.45,
        'V/IV': 0.5,
        'V/V': 0.4,
      },
      ii: { V: 4, 'vii°': 0.8, IV: 0.8, 'V/V': 0.6, I: 0.4, vi: 0.5 },
      iii: { vi: 3, IV: 2.2, ii: 1, V: 0.5 },
      IV: { V: 3, I: 2.5, ii: 1, vi: 1.2, iv: 1.2, bVII: 0.6, iii: 0.5, 'V/V': 0.5 },
      V: { I: 4, vi: 2.5, IV: 0.9, iii: 0.4, 'V/vi': 0.3 },
      vi: { IV: 3, ii: 2.5, V: 1.5, iii: 1, I: 1, 'V/V': 0.4 },
      'vii°': { I: 4, iii: 0.5, vi: 0.4 },
      iv: { I: 3, V: 1.5, bVII: 0.6 },
      bVI: { bVII: 2.5, V: 1.5, I: 1, iv: 0.8 },
      bVII: { I: 3, IV: 1.2, bVI: 0.6 },
      'V/V': { V: 4.5, I: 0.3 },
      'V/vi': { vi: 4.5, IV: 0.5 },
      'V/IV': { IV: 4.5, ii: 0.5 },
    },
    minor: {
      i: { iv: 3, bVI: 3, bVII: 2.5, bIII: 1.5, v: 1.2, V: 1.2, 'ii°': 0.7, IV: 0.6, bII: 0.3 },
      'ii°': { V: 3.5, v: 1, i: 0.4 },
      bIII: { bVI: 2.5, bVII: 2, iv: 1.5, i: 0.8 },
      iv: { V: 2.5, i: 2, bVII: 1.5, v: 1, bVI: 1, bII: 0.5 },
      v: { i: 2, bVI: 2, iv: 1.2 },
      V: { i: 4, bVI: 2.5 },
      bVI: { bVII: 3, iv: 1.5, bIII: 1.5, i: 1.2, V: 1.5, 'ii°': 0.8 },
      bVII: { bIII: 3, i: 2.5, bVI: 1, V: 0.6 },
      IV: { i: 2, V: 1.5, bVII: 1 },
      bII: { V: 3.5, i: 1 },
    },
  };

/** Job-to-job weights for unlisted moves, scaled by 0.35 (the demo's GENERIC). */
const GENERIC: Readonly<Record<Job, Readonly<Record<Job, number>>>> = {
  home: { home: 0.3, soft: 2.5, lift: 3, tension: 2, colour: 0.6 },
  soft: { home: 1, soft: 0.8, lift: 3, tension: 1.2, colour: 0.5 },
  lift: { home: 1.5, soft: 1, lift: 0.8, tension: 3, colour: 0.8 },
  tension: { home: 4, soft: 2, lift: 0.6, tension: 0.5, colour: 0.4 },
  colour: { home: 2, soft: 0.8, lift: 1, tension: 1.5, colour: 0.4 },
};

/** Weights with no chord before (a sequence just restarted). Not in the demo. */
const START: Readonly<Record<Job, number>> = {
  home: 3,
  soft: 1.2,
  lift: 1.5,
  tension: 1.2,
  colour: 0.5,
};

interface Loop {
  /** Short name for a reason ("Continues the pop loop"). */
  name: string;
  cyclic: boolean;
  family: Family;
  chords: readonly string[];
}

const LOOPS: readonly Loop[] = [
  { name: 'the pop loop', cyclic: true, family: 'major', chords: ['I', 'V', 'vi', 'IV'] },
  { name: 'the 50s loop', cyclic: true, family: 'major', chords: ['I', 'vi', 'IV', 'V'] },
  { name: 'the sensitive loop', cyclic: true, family: 'major', chords: ['vi', 'IV', 'I', 'V'] },
  { name: 'the circle of fifths', cyclic: true, family: 'major', chords: ['vi', 'ii', 'V', 'I'] },
  { name: 'the royal road', cyclic: true, family: 'major', chords: ['IV', 'V', 'iii', 'vi'] },
  {
    name: 'Pachelbel’s canon',
    cyclic: true,
    family: 'major',
    chords: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'],
  },
  { name: 'ii–V–I', cyclic: false, family: 'major', chords: ['ii', 'V', 'I'] },
  {
    name: 'the Andalusian descent',
    cyclic: true,
    family: 'minor',
    chords: ['i', 'bVII', 'bVI', 'V'],
  },
  {
    name: 'the epic minor loop',
    cyclic: true,
    family: 'minor',
    chords: ['i', 'bVI', 'bIII', 'bVII'],
  },
  { name: 'the minor circle', cyclic: true, family: 'minor', chords: ['i', 'iv', 'bVII', 'bIII'] },
  { name: 'the minor cadence', cyclic: false, family: 'minor', chords: ['iv', 'V', 'i'] },
];

/** A chord of a key's family, read in that key. */
export interface TheoryChord {
  /** ASCII numeral, the tables' id: 'I', 'bVII', 'vii°', 'V/V'. */
  num: string;
  quality: Quality;
  job: Job;
  /** A Surprise chord of the family that lies in the key's scale and so took a function job. */
  modal: boolean;
  /** Root pitch class. */
  root: number;
  /** Triad pitch classes, root first. */
  triad: readonly number[];
  /** Seventh-chord pitch classes, root first (the seventh last). */
  seventh: readonly number[];
}

/** A key's chord theory: its family and the chords it offers, function chords first. */
export interface Theory {
  key: Key;
  family: Family;
  chords: readonly TheoryChord[];
}

/**
 * The scale a key is judged against: pentatonic major against major; pentatonic minor and blues
 * against aeolian; whole-tone, chromatic and locrian (and custom scales without a perfect fifth)
 * have none.
 */
function parentScale(key: Key): readonly number[] | null {
  const s = key.scale;
  if (typeof s !== 'string') {
    const iv = scaleIntervals(s);
    return iv.includes(7) ? iv : null;
  }
  if (s === 'whole-tone' || s === 'chromatic' || s === 'locrian') return null;
  if (s === 'pentatonic-major') return SCALES.major;
  if (s === 'pentatonic-minor' || s === 'blues') return SCALES.aeolian;
  return SCALES[s] ?? null;
}

/** The ASCII symbol of a family chord: a seventh chord ('V7', 'IVmaj7', 'V7/V') or a triad. */
export function chordSymbolOf(num: string, quality: Quality, seventh: boolean): string {
  const slash = num.indexOf('/');
  if (slash >= 0) return seventh ? `${num.slice(0, slash)}7${num.slice(slash)}` : num;
  if (!seventh) return num;
  if (quality === 'maj') return `${num}maj7`;
  if (quality === 'dim') return `${num.replace('°', '')}ø7`;
  return `${num}7`;
}

const cache = new Map<string, Theory | null>();

/** The key's chord theory, or null when the key has none (callers fall back). */
export function theoryOf(key: Key): Theory | null {
  const id = `${key.tonic}|${typeof key.scale === 'string' ? key.scale : key.scale.intervals.join(',')}`;
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const out = buildTheory(key);
  if (cache.size > 256) cache.clear();
  cache.set(id, out);
  return out;
}

function buildTheory(key: Key): Theory | null {
  const parent = parentScale(key);
  if (!parent) return null;
  const has3 = parent.includes(3);
  const has4 = parent.includes(4);
  if (has3 === has4) return null;
  const family: Family = has4 ? 'major' : 'minor';
  const tonic = pitchClassOf(key.tonic);
  const inScale = new Set(parent.map((i) => mod(tonic + i, 12)));
  const chords: TheoryChord[] = [];
  for (const [num, quality, job0] of VOCAB[family]) {
    const tri = parseChord(chordSymbolOf(num, quality, false), key);
    const sev = parseChord(chordSymbolOf(num, quality, true), key);
    if (!tri.ok || !sev.ok) continue;
    let job = job0;
    let modal = false;
    if (job0 === 'colour' && sev.pcs.every((pc) => inScale.has(pc))) {
      const j = MODAL_JOB[family][num];
      if (j === null || j === undefined) continue;
      job = j;
      modal = true;
    }
    chords.push({ num, quality, job, modal, root: tri.root, triad: tri.pcs, seventh: sev.pcs });
  }
  return { key, family, chords };
}

/** The chord `num` of the theory, if it offers it. */
export function chordOf(th: Theory, num: string): TheoryChord | undefined {
  return th.chords.find((c) => c.num === num);
}

/** The job of `num` in the theory (the family's own job for a chord the key drops). */
function jobOf(th: Theory, num: string): Job {
  return chordOf(th, num)?.job ?? VOCAB[th.family].find((e) => e[0] === num)?.[2] ?? 'colour';
}

/** The ASCII symbol of `c`: a seventh chord when `lines` ≥ 4, else a triad. */
export function symbolFor(c: TheoryChord, lines: number): string {
  return chordSymbolOf(c.num, c.quality, lines >= 4);
}

/** The letter name of a numeral symbol in `key` ("V7" in C → "G7"). */
export function letterName(symbol: string, key: Key): string {
  const label = harmonyLabel(symbol, [], 0, key);
  const i = label.indexOf(' · ');
  return i >= 0 ? label.slice(i + 3) : label;
}

/** Display form of a numeral ('bVII' → '♭VII'). */
export function displayNumeral(symbol: string): string {
  return symbol.replace(/b(?=[IV])/g, '♭');
}

/**
 * The family chord a harmony entry reads as: the root and at least two triad tones must sound;
 * then 10 per shared triad tone, −6 per tone outside the seventh chord, +8 when the bass is the
 * root (B–D–G still reads V), +3 when its seventh sounds (C7 reads V/IV; Fmaj7/A reads IV, so
 * C6 reads vi: a whole seventh chord wins over an added sixth).
 * Ties keep vocabulary order. Null when nothing fits.
 */
export function matchChord(th: Theory, pcs: readonly number[], bass: number): string | null {
  const set = new Set(pcs.map((p) => mod(p, 12)));
  const b = mod(bass, 12);
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const c of th.chords) {
    if (!set.has(c.root)) continue;
    const shared = c.triad.filter((pc) => set.has(pc)).length;
    if (shared < 2) continue;
    let outside = 0;
    for (const pc of set) if (!c.seventh.includes(pc)) outside++;
    const score =
      10 * shared -
      6 * outside +
      (b === c.root ? 8 : 0) +
      (set.has(c.seventh[c.seventh.length - 1]) ? 3 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c.num;
    }
  }
  return best;
}

/**
 * The progression so far in the key in effect at `t`: the score's harmony entries at or before
 * `t`, each read in the key in effect at its time (`matchChord`), repeats collapsed. An entry that
 * matches nothing, or is read in a key of another family or without theory, restarts the
 * sequence. Entries named from tunes (melody notes) are skipped.
 */
export function progressionAt(score: CompiledScore, t: Seconds): string[] {
  const th = theoryOf(keyAt(score, t));
  if (!th) return [];
  return readProgression(score, th.family, (e) => e.t <= t);
}

function readProgression(
  score: CompiledScore,
  family: Family,
  keep: (e: { t: Seconds; momentId: string }) => boolean,
): string[] {
  let seq: string[] = [];
  for (const e of score.harmony ?? []) {
    if (!keep(e)) continue;
    if (e.from === 'tunes') continue;
    const th = theoryOf(keyAt(score, e.t));
    const num = th && th.family === family ? matchChord(th, e.pcs, e.bass) : null;
    if (num === null) seq = [];
    else if (seq[seq.length - 1] !== num) seq.push(num);
  }
  return seq;
}

/** The family chord of the first harmony entry after `t` (skipping tunes and `exclude`). */
function chordAfter(
  score: CompiledScore,
  family: Family,
  t: Seconds,
  exclude?: string,
): string | null {
  for (const e of score.harmony ?? []) {
    if (e.t <= t || e.from === 'tunes' || e.momentId === exclude) continue;
    const th = theoryOf(keyAt(score, e.t));
    return th && th.family === family ? matchChord(th, e.pcs, e.bass) : null;
  }
  return null;
}

/** Transition weight a → b: the table, else 0.35 × the job-to-job weight. */
export function transition(th: Theory, a: string, b: string): number {
  const w = TRANS[th.family][a]?.[b];
  return w ?? 0.35 * GENERIC[jobOf(th, a)][jobOf(th, b)];
}

/** At most six words on why b follows a (a null `a`: no chord before). */
export function moveReason(th: Theory, a: string | null, b: string): string {
  const jb = jobOf(th, b);
  const home = th.family === 'major' ? 'I' : 'i';
  const borrowed = !chordOf(th, b)?.modal;
  if (b.startsWith('V/')) {
    const target = chordOf(th, b.slice(2));
    const name = target ? letterName(symbolFor(target, 3), th.key) : displayNumeral(b.slice(2));
    return `Points hard at ${name}`;
  }
  if (a !== null) {
    if ((a === 'V' || a === 'vii°') && b === home) return 'Resolves home';
    if (a === 'bVII' && b === home) return 'Rock-style way home';
    if (a === 'V' && (b === 'vi' || b === 'bVI')) return 'Deceptive turn';
    if ((a === 'IV' || a === 'iv') && b === home) return 'Plagal amen home';
    if (a === 'IV' && b === 'iv') return 'Same chord, turned bittersweet';
    if (a === 'ii' && b === 'V') return 'Classic set-up into tension';
    if (a === home && b === 'vi') return 'Relative minor, sadder';
  }
  if (borrowed) {
    if (b === 'bVI')
      return th.family === 'major' ? 'Borrowed: bold and cinematic' : 'Lifts away, warm and wide';
    if (b === 'bVII')
      return th.family === 'major' ? 'Borrowed: bright and open' : 'Steps down, ready to turn';
    if (b === 'bII') return 'Dark half step above home';
    if (th.family === 'minor' && b === 'IV') return 'Borrowed hopeful lift';
    if (th.family === 'major' && b === 'iv') return 'Borrowed from minor';
  }
  if (th.family === 'minor' && b === 'V') return 'Raised V pulls home';
  switch (jb) {
    case 'home':
      return 'Goes home';
    case 'tension':
      return 'Builds tension';
    case 'lift':
      return a === null || jobOf(th, a) === 'home' ? 'Lifts away from home' : 'Keeps moving away';
    case 'soft':
      return 'Stays near home';
    default:
      return 'Colour from outside the key';
  }
}

/** Phrase position (n = chords so far, mod 8): a factor and a reason. */
function phraseFactor(th: Theory, seq: readonly string[], b: string): [number, string | null] {
  const n = seq.length;
  const slot = n % 8;
  const jb = jobOf(th, b);
  const jl = n > 0 ? jobOf(th, seq[n - 1]) : null;
  if (slot === 3 && jb === 'tension') return [1.6, 'Ends the half-phrase open'];
  if (slot === 6 && jb === 'tension') return [1.5, 'Sets up the cadence'];
  if (slot === 7 && jb === 'home' && jl === 'tension') return [2, 'Closes the phrase'];
  if (slot === 7 && jb === 'tension') return [1.3, 'Half cadence, left open'];
  if ((slot === 0 || slot === 4) && jb === 'home') return [1.4, 'New phrase from home'];
  return [1, null];
}

/** The longest known loop whose last k ≥ 2 chords end `seq` and continue with `b`. */
function loopMatch(
  family: Family,
  seq: readonly string[],
  b: string,
): { k: number; loop: Loop } | null {
  let best: { k: number; loop: Loop } | null = null;
  for (const L of LOOPS) {
    if (L.family !== family) continue;
    const arr = L.chords;
    const m = arr.length;
    for (let k = Math.min(seq.length, m - 1); k >= 2; k--) {
      if (best && best.k >= k) break;
      let found = false;
      for (let j = 0; j < m && !found; j++) {
        if (!L.cyclic && (j - k + 1 < 0 || j + 1 >= m)) continue;
        let ok = true;
        for (let q = 0; q < k && ok; q++) ok = seq[seq.length - 1 - q] === arr[mod(j - q, m)];
        if (ok && arr[(j + 1) % m] === b) found = true;
      }
      if (found) {
        best = { k, loop: L };
        break;
      }
    }
  }
  return best;
}

/** A ranked candidate. */
export interface RankedChord {
  num: string;
  job: Job;
  score: number;
  /** At most six words, for a tooltip. */
  reason: string;
}

/**
 * Every chord the key offers after `seq`, best first (the current chord excluded): transition ×
 * loop completion (1 + 0.9k) × phrase position × 1.12 per shared tone × 0.6 for an A–B–A return
 * to a non-Home chord. An empty `seq` ranks by job alone (`START`). Ties keep vocabulary order.
 */
export function rankNext(th: Theory, seq: readonly string[]): RankedChord[] {
  const n = seq.length;
  const last = n > 0 ? seq[n - 1] : null;
  const lastTriad = last === null ? [] : (chordOf(th, last)?.triad ?? lookupTriad(th, last));
  const out: RankedChord[] = [];
  for (const c of th.chords) {
    if (c.num === last) continue;
    if (last === null) {
      out.push({
        num: c.num,
        job: c.job,
        score: START[c.job],
        reason: moveReason(th, null, c.num),
      });
      continue;
    }
    let score = transition(th, last, c.num);
    let reason: string | null = null;
    const lm = loopMatch(th.family, seq, c.num);
    if (lm) {
      score *= 1 + 0.9 * lm.k;
      reason = `Continues ${lm.loop.name}`;
    }
    const [pf, pr] = phraseFactor(th, seq, c.num);
    score *= pf;
    reason ??= pr ?? moveReason(th, last, c.num);
    const shared = c.triad.filter((pc) => lastTriad.includes(pc)).length;
    score *= 1 + 0.12 * shared;
    if (n >= 2 && seq[n - 2] === c.num && c.job !== 'home') score *= 0.6;
    out.push({ num: c.num, job: c.job, score, reason });
  }
  return out
    .map((r, i) => ({ r, i }))
    .sort((x, y) => y.r.score - x.r.score || x.i - y.i)
    .map((x) => x.r);
}

/** The triad of a family numeral the key doesn't offer (e.g. Mixolydian V/IV). */
function lookupTriad(th: Theory, num: string): readonly number[] {
  const e = VOCAB[th.family].find((x) => x[0] === num);
  const p = e ? parseChord(chordSymbolOf(num, e[1], false), th.key) : null;
  return p?.ok ? p.pcs : [];
}

/**
 * The cards (owner: one per job): the best first, then the best of each other job in score
 * order, at most `max`; a Surprise always included when one passes `ok` (it replaces the last
 * card when full). `ok` filters candidates (e.g. no-ops).
 */
export function pickCards(
  ranked: readonly RankedChord[],
  max = 4,
  ok: (r: RankedChord) => boolean = () => true,
): RankedChord[] {
  const out: RankedChord[] = [];
  if (max <= 0) return out;
  for (const r of ranked) {
    if (out.length >= max) break;
    if (out.some((o) => o.job === r.job) || !ok(r)) continue;
    out.push(r);
  }
  if (!out.some((o) => o.job === 'colour')) {
    const c = ranked.find((r) => r.job === 'colour' && ok(r));
    if (c) {
      if (out.length >= max) out[max - 1] = c;
      else out.push(c);
    }
  }
  return out;
}

/** The chord that best links `a` to `b` (transition in × out), neither of them. */
export function bestBetween(th: Theory, a: string | null, b: string | null): TheoryChord {
  let best = th.chords[0];
  let bestW = -Infinity;
  for (const c of th.chords) {
    if (c.num === a || c.num === b) continue;
    const w =
      (a !== null ? transition(th, a, c.num) : 1) * (b !== null ? transition(th, c.num, b) : 1);
    if (w > bestW) {
      bestW = w;
      best = c;
    }
  }
  return best;
}

/** A chord's fit for a spot between two chords (rank 0 = best). */
export interface SpotRank {
  num: string;
  job: Job;
  score: number;
  rank: number;
}

/**
 * How well each chord the key offers fits between `prev` and `next` (either may be null): the
 * transitions in and out, ×0.15 for repeating a neighbour; with neither, Home first.
 */
export function spotRanks(th: Theory, prev: string | null, next: string | null): SpotRank[] {
  const res = th.chords.map((c) => {
    let w = 1;
    if (prev !== null) w *= c.num === prev ? 0.15 : transition(th, prev, c.num);
    if (next !== null) w *= c.num === next ? 0.15 : transition(th, c.num, next);
    if (prev === null && next === null) w = c.job === 'home' ? 2 : 1;
    return { num: c.num, job: c.job, score: w, rank: 0 };
  });
  const order = res.map((_, i) => i).sort((x, y) => res[y].score - res[x].score || x - y);
  order.forEach((i, rank) => (res[i].rank = rank));
  return res;
}

/**
 * The neighbours of a spot in the key at `t`: the chord in effect before `t` (strictly earlier
 * entries) and the first entry after `t`, skipping entries set by `exclude` (the selected moment).
 */
export function neighboursAt(
  score: CompiledScore,
  th: Theory,
  t: Seconds,
  exclude?: string,
  inclusive = false,
): { prev: string | null; next: string | null } {
  const seq = readProgression(
    score,
    th.family,
    (e) => (inclusive ? e.t <= t : e.t < t) && e.momentId !== exclude,
  );
  return {
    prev: seq.length > 0 ? seq[seq.length - 1] : null,
    next: chordAfter(score, th.family, t, exclude),
  };
}
