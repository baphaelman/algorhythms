/**
 * Next-move suggestions (PLAN.md §11.3). In a key with chord theory (revision 14, core/theory.ts):
 * up to four chord cards, one per job, each a key-relative numeral chord (`theoryNext`); also the
 * Add → Chord default (`chordDefaultAt`) and the chord picker's spot ranks (`chordPickerRanks`).
 *
 * Keys without theory (whole-tone, chromatic, locrian) keep revision 6: 3–4 musically sensible
 * moments drawn from the Generate composer's grammar (core/generate.ts):
 *
 *   silence       → start on the tonic triad, or the tonic alone  (Seed; M4.5-27)
 *   one voice     → split into the next stage on a chord          (Split)
 *   a unison      → open into a diatonic chord, or a related one  (Burst)
 *   a chord       → move to a related chord (composer's moves:    (Drift)
 *                   fourth/fifth up, relative, neighbour), walk, collapse to a chord tone
 *                   (or home to the tonic late in the piece), thin to three notes, split
 *   any           → a level swell (or a dip when already full)
 *
 * Chords are the composer's stacks of thirds on a scale degree, voiced `even` in a register around
 * the voices' centre. Chords and targets are key-relative (degrees, 'tonic') so they follow later
 * key changes. Thin and Collapse (to a note other than the tonic) still write fixed pitches: no
 * key-relative form says them yet (schema v2, M4.5-27). Every suggestion is checked with `momentEffectAt`, so none is a no-op.
 *
 * Pure and deterministic: draws are keyed by hash32(piece.seed, round(t·1000)) (§7.7, §7.11).
 * Each moment carries an explicit `seed`, so the added moment sounds like its preview.
 */

import { diatonicChords } from './chord-spec';
import { momentEffectAt, readState, type StateAt } from './effect';
import { splitStages } from './generate';
import { nameChord, spellPc } from './harmony';
import { mod } from './math';
import { Purpose, hash32, rand } from './rng';
import { degreesToPcs, pitchClassOf, scaleIntervals } from './scales';
import { sanitizeRange } from './compiler/range';
import { keyAt } from './query';
import {
  JOB_LABEL,
  bestBetween,
  chordOf,
  displayNumeral,
  letterName,
  neighboursAt,
  pickCards,
  progressionAt,
  rankNext,
  spotRanks,
  symbolFor,
  theoryOf,
  type Job,
  type RankedChord,
  type Theory,
  type TheoryChord,
} from './theory';
import { roundTiesDown } from './voicing';
import type {
  ChordMoment,
  CompiledScore,
  Glide,
  Moment,
  MomentId,
  Piece,
  Pitch,
  Seconds,
} from './types';

/** A moment without id, at and seed (distributes over the union). */
type Draft = Moment extends infer M
  ? M extends Moment
    ? Omit<M, 'id' | 'at' | 'seed'>
    : never
  : never;

/** Id of a suggested moment; the caller gives it a fresh id before adding it. */
export const SUGGEST_ID = '__suggest';

export type SuggestionKind = 'open' | 'chord' | 'split' | 'walk' | 'thin' | 'collapse' | 'level';

export interface Suggestion {
  kind: SuggestionKind;
  /**
   * Short human label: "<Chord> · <Job> (<numeral>)" for a theory card ("G7 · Tension (V)",
   * "C · Home (I)", "C · One note"); else the composer's ("Open to Dm9", "Walk 8 s").
   */
  label: string;
  /** The chord's job (theory cards and theory openings only). */
  job?: Job;
  /** The best fit (the first suggestion). */
  best: boolean;
  /** Tooltip: a short reason, at most six words ("Resolves home"); else the label. */
  tooltip: string;
  /** The moment (id `SUGGEST_ID`, explicit seed, `at` = t rounded to ms). */
  moment: Moment;
}

/** The composer's glides (generate.ts glideOf: stagger, then the duration range [a, b]). */
function glideOf(stagger: Seconds, a: Seconds, b: Seconds): Partial<Glide> {
  return { length: round3((a + b) / 2), jitter: round3((b - a) / (a + b)), stagger };
}
const GLIDE_SPLIT = glideOf(0.5, 2.6, 3.8);
const GLIDE_DRIFT = glideOf(1.4, 2.2, 4);
const GLIDE_OPEN = glideOf(0.6, 1.8, 3);
const GLIDE_GATHER = glideOf(0.9, 3.6, 5);
const GLIDE_HOME = glideOf(1, 4, 6.5);
const GLIDE_THIN = glideOf(1.3, 3, 5);

const WALK_LENGTHS = [8, 12, 16];
/** Late in the piece (fraction of its length), collapsing goes home to the tonic. */
const HOME_AFTER = 0.6;

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * From silence (M4.5-27): what can start the sound, the tonic triad or the tonic alone. Both are
 * key-relative (degrees, 'tonic').
 */
function openings(
  piece: Piece,
  score: CompiledScore,
  at: Seconds,
  key: Piece['key'],
  count: number,
): Plain[] {
  const pcs = degreesToPcs([0, 2, 4], key);
  const triad = `Start on ${nameChord(pcs, pcs[0], key)}`;
  // A major triad is named by its root ("C"), so the tonic alone then says "(unison)".
  const alone = `Start on ${key.tonic}`;
  const drafts: [SuggestionKind, string, Draft][] = [
    [
      'open',
      triad,
      {
        type: 'chord',
        notes: { kind: 'degrees', degrees: [0, 2, 4] },
        voicing: 'even',
        assign: 'ordered',
      },
    ],
    [
      'open',
      alone === triad ? `${alone} (unison)` : alone,
      { type: 'unison', pitch: 'tonic', octaves: false },
    ],
  ];
  const out: Plain[] = [];
  for (const [kind, label, m] of drafts) {
    const moment = { ...m, id: SUGGEST_ID, at, seed: hash32(piece.seed >>> 0, label) } as Moment;
    if (out.length < count && momentEffectAt(piece, score, moment).effect)
      out.push({ kind, label, moment });
  }
  return out;
}

/** A composer suggestion before `best` and `tooltip` are filled in. */
type Plain = Omit<Suggestion, 'best' | 'tooltip' | 'job'>;

/**
 * Up to `count` suggested next moments at `t` for `piece` (compiled as `score`), most fitting
 * first. In a key with chord theory (core/theory.ts), chord cards, one per job (`theoryNext`);
 * else the composer's grammar (`composerNext`). When nothing sounds at t, the openings that can
 * start the sound.
 */
export function suggestNext(
  piece: Piece,
  score: CompiledScore,
  t: Seconds,
  count = 4,
): Suggestion[] {
  const at = round3(Math.max(0, t));
  if (count <= 0) return [];
  // Stacked voices (revision 8): a merged unison still opens into a chord.
  const st0 = readState(piece, score, at);
  const st = st0.stacked ?? st0;
  const th = theoryOf(st.key);
  if (th) return theoryNext(piece, score, at, st0, th, count);
  return composerNext(piece, score, at, st, count).map((s, i) => ({
    ...s,
    best: i === 0,
    tooltip: s.label,
  }));
}

/** The Generate composer's grammar (keys without chord theory). */
function composerNext(
  piece: Piece,
  score: CompiledScore,
  at: Seconds,
  st: StateAt,
  count: number,
): Plain[] {
  const n = st.active.length;
  if (n === 0) return openings(piece, score, at, st.key, count);
  const key = st.key;
  const dests = st.active.map((v) => st.dest[v]); // ascending
  const lowest = dests[0];
  const highest = dests[n - 1];
  const unison = highest - lowest < 1e-6;
  const pool = piece.voices.length;

  const seed = hash32(piece.seed >>> 0, 'suggest', Math.round(at * 1000));
  let drawN = 0;
  const draw = (): number => rand(seed, '', drawN++, Purpose.Suggest);

  // Harmony, as in the composer: chords are stacks of thirds on scale degree c.
  const iv = scaleIntervals(key.scale);
  const S = iv.length;
  const tonic = pitchClassOf(key.tonic);
  const thirds = (c: number, k: number): number[] => Array.from({ length: k }, (_, i) => c + 2 * i);
  const pcsOf = (c: number, k: number): number[] =>
    thirds(c, k).map((d) => mod(tonic + iv[mod(d, S)], 12));
  const nameOf = (c: number, k: number): string => {
    const pcs = pcsOf(c, k);
    return nameChord(pcs, pcs[0], key);
  };
  const degreeOfPc = (pc: number): number => iv.indexOf(mod(pc - tonic, 12));

  // Where we are: the degree whose seventh chord best matches the sounding pitch classes.
  const soundingPcs = [...new Set(dests.map((p) => mod(Math.round(p), 12)))];
  const bassPc = mod(Math.round(lowest), 12);
  let cur = 0;
  const isDim = (c: number): boolean => S === 7 && mod(pcsOf(c, 3)[2] - pcsOf(c, 3)[0], 12) === 6;
  if (soundingPcs.length === 1) {
    // The chord with that note as root, else as fifth, else as third (not a diminished one).
    const d = Math.max(0, degreeOfPc(soundingPcs[0]));
    cur = [d, mod(d - 4, S), mod(d - 2, S)].find((c) => !isDim(c)) ?? d;
  } else {
    let best = -1;
    for (let d = 0; d < S; d++) {
      const chord = pcsOf(d, Math.min(4, S));
      const root = chord[0];
      const score =
        soundingPcs.filter((pc) => chord.includes(pc)).length * 4 +
        (soundingPcs.includes(root) ? 2 : 0) +
        (bassPc === root ? 1 : 0);
      if (score > best) {
        best = score;
        cur = d;
      }
    }
  }

  // Related chords, drawn from the composer's moves (weighted by repetition), distinct:
  // fourth/fifth up (ii–V motion), relative (±2 degrees), neighbours.
  const MOVES = S === 7 ? [3, 4, 3, 4, 5, 2, -2, 1] : [1, 2, 3, -1, -2];
  const related: number[] = [];
  {
    const bag = MOVES.slice();
    while (bag.length > 0 && related.length < 3) {
      const [mv] = bag.splice(Math.floor(draw() * bag.length), 1);
      const c = mod(cur + mv, S);
      if (c !== cur && !related.includes(c)) related.push(c);
    }
    // Diminished chords (a flat fifth) come last.
    related.sort((a, b) => Number(isDim(a)) - Number(isDim(b)));
  }

  // Register: the composer's span for k voices around the voices' centre, inside their ranges.
  const [rLo, rHi] = voiceSpan(piece, st);
  const centre = Math.round((lowest + highest) / 2);
  const registerFor = (c: number, k: number, ctr: Pitch): [Pitch, Pitch] | undefined =>
    registerAround(pcsOf(c, Math.min(4, S)), k, ctr, rLo, rHi);
  const chordTonesNear = (c: number, x: Pitch): Pitch => {
    const pcs = pcsOf(c, 3);
    let best = NaN;
    for (let p = rLo; p <= rHi; p++) {
      if (pcs.includes(mod(p, 12)) && !(Math.abs(p - x) >= Math.abs(best - x))) best = p;
    }
    return best === best ? best : Math.round(x);
  };

  const out: Plain[] = [];
  const add = (kind: SuggestionKind, label: string, m: Draft): void => {
    if (out.length >= count || out.some((s) => s.label === label)) return;
    const moment = {
      ...m,
      id: SUGGEST_ID,
      at,
      seed: hash32(seed, kind, label),
    } as Moment;
    if (momentEffectAt(piece, score, moment).effect) out.push({ kind, label, moment });
  };

  /** A chord on degree c for the voices; k notes stacked in thirds (5 makes it a ninth). */
  const chordMoment = (c: number, k: number, ctr: Pitch, glide: Partial<Glide>) => {
    const register = registerFor(c, n, ctr);
    return {
      type: 'chord' as const,
      notes: { kind: 'degrees' as const, degrees: thirds(c, k) },
      voicing: 'even' as const,
      ...(register ? { register } : {}),
      assign: 'ordered' as const,
      glide,
    };
  };
  /**
   * Notes in the chord on degree c for `voices` voices: a ninth (5) for five or more voices when
   * its ninth is major, else a seventh (4), else a triad; the first whose name is a plain symbol.
   */
  const chordSize = (c: number, voices: number): number => {
    const sizes = voices >= 5 ? [5, 4, 3] : [4, 3];
    for (const k of sizes) {
      if (k >= S) continue;
      const pcs = pcsOf(c, k);
      if (k === 5 && mod(pcs[4] - pcs[0], 12) !== 2) continue;
      if (!/[ ♭]/.test(nameOf(c, k).replace(/^[A-G]♭/, 'X'))) return k;
    }
    return Math.max(1, Math.min(3, S - 1));
  };
  const nextStage = (): number => splitStages(pool).find((k) => k > n) ?? pool;

  const split = (c: number): void => {
    if (st.dormant.length === 0 || n >= pool) return;
    const k = Math.min(pool, nextStage());
    add('split', `Split to ${k} · ${nameOf(c, chordSize(c, k))}`, {
      type: 'split',
      count: k,
      notes: { kind: 'degrees', degrees: thirds(c, chordSize(c, k)) },
      voicing: 'even',
      glide: GLIDE_SPLIT,
    });
  };
  const open = (c: number): void => {
    const k = chordSize(c, n);
    add('open', `Open to ${nameOf(c, k)}`, chordMoment(c, k, centre, GLIDE_OPEN));
  };
  const move = (c: number): void => {
    const k = chordSize(c, n);
    const ctr = centre + Math.round((draw() - 0.5) * 6);
    add('chord', `Move to ${nameOf(c, k)}`, chordMoment(c, k, ctr, GLIDE_DRIFT));
  };
  const walk = (): void => {
    if (unison) return;
    const len = WALK_LENGTHS[Math.floor(draw() * WALK_LENGTHS.length)];
    add('walk', `Walk ${len} s`, {
      type: 'walk',
      until: round3(at + len),
      grid: 1,
      density: 0.45,
      steps: [-2, -1, 1, 2],
      stepGlide: 0.27,
      ...(n >= 4 ? { bass: { leap: [5, 12] as [number, number] } } : {}),
      glide: { stagger: 0.1, jitter: round3(0.05 / 0.27) },
    });
  };
  /**
   * Every voice to `pitch`: the unison's 'tonic' when that resolves to `pitch`, so it follows a
   * later key change (PLAN rev 8, "Key changes carry forward"); else a numeric unison. A degree
   * chord can't stand in for other notes: it spreads into free octaves instead of a unison.
   */
  const gather = (pitch: Pitch, glide: Partial<Glide>): Draft => {
    const tonicHere = tonic + 12 * roundTiesDown(((lowest + highest) / 2 - tonic) / 12);
    return { type: 'unison', pitch: pitch === tonicHere ? 'tonic' : pitch, octaves: false, glide };
  };
  const collapse = (): void => {
    if (unison) return;
    const home = at >= HOME_AFTER * score.duration;
    const pitch = home ? nearestPc(tonic, centre, rLo, rHi) : chordTonesNear(cur, centre);
    const name = spellPc(mod(pitch, 12), key);
    add(
      'collapse',
      home ? `Home to ${name}` : `Collapse to ${name}`,
      gather(pitch, home ? GLIDE_HOME : GLIDE_GATHER),
    );
  };
  const thin = (): void => {
    if (n < 5 || related.length === 0) return;
    const c = related.filter((x) => !isDim(x)).pop() ?? related[related.length - 1];
    const tri = [centre - 11, centre, centre + 10].map((x) => chordTonesNear(c, x));
    if (new Set(tri).size < 3) return;
    // Fixed pitches: no key-relative NoteSet can say "these three notes in these octaves" for
    // five or more voices (needs schema v2, M4.5-27); a key change offers to move them.
    add('thin', `Thin to ${nameOf(c, 3)}`, {
      type: 'chord',
      notes: { kind: 'pitches', pitches: tri },
      voicing: 'even',
      assign: 'ordered',
      glide: GLIDE_THIN,
    });
  };
  const level = (): void => {
    let sum = 0;
    for (const v of st.active) sum += st.level[v];
    const mean = sum / n;
    if (mean < 0.8) {
      add('level', 'Swell to 100%', { type: 'level', gain: 1, over: 4 });
    } else {
      add('level', 'Dip to 60%', { type: 'level', gain: 0.6, over: 4 });
    }
  };

  if (n === 1) {
    split(cur);
    for (const c of related) split(c);
    level();
  } else if (unison || soundingPcs.length === 1) {
    open(cur);
    if (related[0] !== undefined) open(related[0]);
    split(cur);
    walk();
    if (related[1] !== undefined) open(related[1]);
    level();
    for (const c of related) open(c);
  } else {
    for (const c of related.slice(0, 1)) move(c);
    walk();
    if (n >= 6 && draw() < 0.5) thin();
    collapse();
    for (const c of related.slice(1)) move(c);
    thin();
    split(cur);
    level();
  }
  return out;
}

/** The pitch of class `pc` nearest `x` within [lo, hi] (ties low). */
function nearestPc(pc: number, x: Pitch, lo: Pitch, hi: Pitch): Pitch {
  let best = NaN;
  for (let p = lo; p <= hi; p++) {
    if (mod(p, 12) === pc && !(Math.abs(p - x) >= Math.abs(best - x))) best = p;
  }
  return best === best ? best : Math.round(x);
}

/** The lowest and highest pitch the active voices' ranges allow. */
function voiceSpan(piece: Piece, st: StateAt): [Pitch, Pitch] {
  let lo = 127;
  let hi = 0;
  for (const v of st.active) {
    const r = sanitizeRange(piece.voices[v]?.range);
    lo = Math.min(lo, r[0]);
    hi = Math.max(hi, r[1]);
  }
  return [lo, hi];
}

/**
 * The composer's register for k voices around `ctr`, inside [rLo, rHi]; undefined when it holds
 * fewer than min(k, 2) pitches of `pcs`.
 */
function registerAround(
  pcs: readonly number[],
  k: number,
  ctr: Pitch,
  rLo: Pitch,
  rHi: Pitch,
): [Pitch, Pitch] | undefined {
  const span = Math.min(rHi - rLo, 6 + k * 3.3);
  let lo = ctr - span / 2;
  let hi = ctr + span / 2;
  if (lo < rLo) {
    hi += rLo - lo;
    lo = rLo;
  }
  if (hi > rHi) {
    lo -= hi - rHi;
    hi = rHi;
  }
  const a = Math.max(rLo, Math.ceil(lo));
  const b = Math.min(rHi, Math.floor(hi));
  let inside = 0;
  for (let p = a; p <= b; p++) if (pcs.includes(mod(p, 12))) inside++;
  return inside < Math.min(k, 2) || a > b ? undefined : [a, b];
}

/**
 * A register of whole octaves less a semitone ([a, a + 12m − 1], m = ⌈k / chord size⌉), so it
 * holds each pitch class exactly m times in any key: an Even voicing of k ≥ chord-size lines then
 * sounds every chord tone, and still does after a later key change. It starts on the root when
 * that fits, its centre nearest `ctr`. Undefined when the voices' range is narrower.
 */
function octaveRegister(
  pcs: readonly number[],
  root: number,
  k: number,
  ctr: Pitch,
  rLo: Pitch,
  rHi: Pitch,
): [Pitch, Pitch] | undefined {
  const w = 12 * Math.max(1, Math.ceil(k / Math.max(1, pcs.length))) - 1;
  let best = NaN;
  for (let pass = 0; pass < 2 && best !== best; pass++) {
    for (let a = Math.ceil(rLo); a + w <= rHi; a++) {
      if (pass === 0 && mod(a, 12) !== root) continue;
      if (!(Math.abs(a + w / 2 - ctr) >= Math.abs(best + w / 2 - ctr))) best = a;
    }
  }
  return best === best ? [best, best + w] : undefined;
}

/** Cost of a register that sounds the whole chord in its key but not in every key. */
const SPREAD_KEYED = 4;

/**
 * Spread (owner 2026-11-23, PLAN §11.3): the register in [rLo, rHi] whose Even voicing of k lines
 * on `pcs` (core/voicing.ts) spans nearest `span` (the lines' spread before), centred nearest
 * `ctr`, with distinct notes that sound the whole chord (k ≥ chord size): it widens only as far as
 * the lines need. A register that still sounds the whole chord in every key (a later key change)
 * is preferred by `SPREAD_KEYED`. Undefined when none holds k such notes.
 */
function spreadRegister(
  pcs: readonly number[],
  k: number,
  span: number,
  ctr: Pitch,
  rLo: Pitch,
  rHi: Pitch,
): [Pitch, Pitch] | undefined {
  const lo = Math.ceil(rLo);
  const hi = Math.floor(rHi);
  if (hi < lo || k < 1) return undefined;
  // Per key shift s: the pitches of pcs + s in [lo, hi], and how many lie below each pitch.
  const tones: number[][] = [];
  const below: Int32Array[] = [];
  for (let s = 0; s < 12; s++) {
    const t: number[] = [];
    const n = new Int32Array(hi - lo + 2);
    for (let p = lo; p <= hi; p++) {
      n[p - lo] = t.length;
      if (pcs.includes(mod(p - s, 12))) t.push(p);
    }
    n[hi - lo + 1] = t.length;
    tones.push(t);
    below.push(n);
  }
  const want = Math.min(k, pcs.length);
  /** Whether the Even voicing in [a, b], key shifted by s, sounds k distinct notes and the chord. */
  const whole = (s: number, a: Pitch, b: Pitch): boolean => {
    const i0 = below[s][a - lo];
    const c = below[s][b - lo + 1] - i0;
    if (c < k) return false;
    let mask = 0;
    for (let i = 0; i < k; i++) {
      const j = k === 1 ? Math.floor((c - 1) / 2) : Math.round((i * (c - 1)) / (k - 1));
      mask |= 1 << mod(tones[s][i0 + j] - s, 12);
    }
    let bits = 0;
    for (; mask; mask &= mask - 1) bits++;
    return bits >= want;
  };
  // Registers that give the same candidates in the key voice alike: walk the candidate runs
  // t[i..j]; the register may reach down to above t[i − 1] and up to below t[j + 1].
  const t = tones[0];
  let best: [Pitch, Pitch] | undefined;
  let bestCost = Infinity;
  for (let i = 0; i < t.length; i++) {
    for (let j = i + k - 1; j < t.length; j++) {
      const first = k === 1 ? t[i + Math.floor((j - i) / 2)] : t[i];
      const last = k === 1 ? first : t[j];
      const base = Math.abs(last - first - span) + 0.5 * Math.abs((first + last) / 2 - ctr);
      if (base >= bestCost || !whole(0, t[i], t[j])) continue;
      let reg: [Pitch, Pitch] | undefined;
      const aMin = i > 0 ? t[i - 1] + 1 : lo;
      const bMax = j + 1 < t.length ? t[j + 1] - 1 : hi;
      for (let a = t[i]; a >= aMin && !reg; a--) {
        for (let b = t[j]; b <= bMax && !reg; b++) {
          let all = true;
          for (let s = 1; s < 12 && all; s++) all = whole(s, a, b);
          if (all) reg = [a, b];
        }
      }
      const cost = reg ? base : base + SPREAD_KEYED;
      if (cost < bestCost) {
        bestCost = cost;
        best = reg ?? [t[i], t[j]];
      }
    }
  }
  return best;
}

/**
 * The register for a chord card or the Add → Chord default on `lines` lines: the lines' spread
 * before (`spreadRegister`, centre moved ±3 by `draw`), else whole octaves, else the composer's.
 */
function chordRegister(
  c: TheoryChord,
  pcs: readonly number[],
  lines: number,
  st: StateAt,
  piece: Piece,
  draw: number,
): [Pitch, Pitch] | undefined {
  const dests = st.active.map((v) => st.dest[v]);
  const lowest = dests[0];
  const highest = dests[dests.length - 1];
  const [rLo, rHi] = voiceSpan(piece, st);
  const ctr = Math.round((lowest + highest) / 2) + Math.round((draw - 0.5) * 6);
  return (
    spreadRegister(pcs, lines, highest - lowest, ctr, rLo, rHi) ??
    octaveRegister(pcs, c.root, lines, ctr, rLo, rHi) ??
    registerAround(pcs, lines, ctr, rLo, rHi)
  );
}

/** Chord moment fields without id, at and seed. */
export type ChordDraft = Omit<ChordMoment, 'id' | 'at' | 'seed'>;

/** A family chord as a key-relative chord moment for `lines` sounding lines (voicing Even). */
function chordDraft(c: TheoryChord, lines: number): ChordDraft {
  return {
    type: 'chord',
    notes: { kind: 'chord', symbol: symbolFor(c, lines) },
    voicing: 'even',
    assign: 'ordered',
  };
}

/** The tonic chord of a theory (its first chord). */
function tonicOf(th: Theory): TheoryChord {
  return th.chords[0];
}

/**
 * Theory-aware Next (PLAN §11.3 revision 14): one chord card per job, best fit first, ranked
 * after the progression so far (core/theory.ts). From silence: Home (the tonic triad) and One
 * note (the tonic). `st` is the state by lines (not stacked voices).
 */
function theoryNext(
  piece: Piece,
  score: CompiledScore,
  at: Seconds,
  st: StateAt,
  th: Theory,
  count: number,
): Suggestion[] {
  const key = st.key;
  const n = st.active.length;
  const seed = hash32(piece.seed >>> 0, 'suggest', Math.round(at * 1000));
  const out: Suggestion[] = [];
  /** `seedKey`: the card's label before revision 14's relabel, so it keeps its seed. */
  const push = (label: string, seedKey: string, tooltip: string, m: Draft): void => {
    const moment = { ...m, id: SUGGEST_ID, at, seed: hash32(seed, 'open', seedKey) } as Moment;
    if (!momentEffectAt(piece, score, moment).effect) return;
    out.push({ kind: 'open', label, job: 'home', best: out.length === 0, tooltip, moment });
  };

  if (n === 0) {
    const home = chordDraft(tonicOf(th), 3);
    const sym = home.notes.kind === 'chord' ? home.notes.symbol : '';
    const name = letterName(sym, key);
    push(`${name} · Home (${displayNumeral(sym)})`, `Home · ${name}`, 'Starts at home', home);
    if (out.length < count) {
      const tonic = spellPc(pitchClassOf(key.tonic), key);
      push(`${tonic} · One note`, `One note · ${tonic}`, 'The tonic alone', {
        type: 'unison',
        pitch: 'tonic',
        octaves: false,
      });
    }
    return out.slice(0, count);
  }

  const dests = st.active.map((v) => st.dest[v]);
  const pcsSounding = new Set(dests.map((p) => mod(Math.round(p), 12)));
  const glide = pcsSounding.size === 1 ? GLIDE_OPEN : GLIDE_DRIFT;
  const pool = piece.voices.length;
  // Stacked voices: compiled by line count unless the card sets `count` (compiler/lines.ts).
  const stacked = (st.stacked ?? st).active.length;

  const built = new Map<string, Moment | null>();
  const momentFor = (r: RankedChord): Moment | null => {
    let m = built.get(r.num);
    if (m !== undefined) return m;
    const c = chordOf(th, r.num)!;
    const draft = chordDraft(c, n);
    const pcs = n >= 4 ? c.seventh : c.triad;
    // Too few lines for the chord: its new notes come in (as the editor's chord fill does).
    // Stacked lines stay merged (`count` counts lines), so they need no wider spread.
    const lines = Math.min(pool, Math.max(n, pcs.length));
    const register = chordRegister(c, pcs, lines, st, piece, rand(seed, r.num, 0, Purpose.Suggest));
    m = {
      ...draft,
      ...(lines !== stacked ? { count: lines } : {}),
      ...(register ? { register } : {}),
      glide,
      id: SUGGEST_ID,
      at,
      seed: hash32(seed, 'chord', r.num),
    } as Moment;
    if (!momentEffectAt(piece, score, m).effect) m = null;
    built.set(r.num, m);
    return m;
  };

  const ranked = rankNext(th, progressionAt(score, at));
  const cards = pickCards(ranked, Math.min(4, count), (r) => momentFor(r) !== null);
  for (const r of cards) {
    const moment = momentFor(r)!;
    const sym =
      moment.type === 'chord' && moment.notes.kind === 'chord' ? moment.notes.symbol : r.num;
    out.push({
      kind: 'chord',
      label: `${letterName(sym, key)} · ${JOB_LABEL[r.job]} (${displayNumeral(sym)})`,
      job: r.job,
      best: out.length === 0,
      tooltip: r.reason,
      moment,
    });
  }
  return out;
}

/** The Add → Chord default (PLAN §11.3 revision 14). */
export interface ChordChoice {
  /** Chord moment fields: a numeral symbol, voicing Even. */
  moment: ChordDraft;
  job: Job;
  /** Letter name in the key ("G7"). */
  name: string;
}

/**
 * The Add → Chord default at `t`: the chord that best links the harmony before `t` to the next
 * harmony entry after it (transition in × out, neither neighbour); the best next chord when
 * nothing follows; the tonic triad from silence. A seventh chord when four or more lines sound,
 * keeping their spread as Next's cards do (`chordRegister`; stacked lines stay merged). Null when the key at `t` has no chord theory (keep the old default). Past the score's end it
 * reads the state just before the end, like the editor's defaults.
 */
export function chordDefaultAt(piece: Piece, score: CompiledScore, t: Seconds): ChordChoice | null {
  const read = Math.min(t, Math.max(0, score.duration - 0.01));
  const st = readState(piece, score, read);
  const th = theoryOf(keyAt(score, t));
  if (!th) return null;
  const n = st.active.length;
  let c: TheoryChord;
  if (n === 0) {
    c = tonicOf(th);
  } else {
    const { prev, next } = neighboursAt(score, th, t, undefined, true);
    c =
      next !== null
        ? bestBetween(th, prev, next)
        : chordOf(th, rankNext(th, progressionAt(score, t))[0].num)!;
  }
  let moment = chordDraft(c, n === 0 ? 3 : n);
  if (n > 0) {
    const pcs = n >= 4 ? c.seventh : c.triad;
    const draw = rand(
      hash32(piece.seed >>> 0, 'suggest', Math.round(t * 1000)),
      c.num,
      0,
      Purpose.Suggest,
    );
    // As the cards: too few lines get the chord's notes (the editor's chord fill), stacked ones stay merged.
    const lines = Math.min(piece.voices.length, Math.max(n, pcs.length));
    const register = chordRegister(c, pcs, lines, st, piece, draw);
    const stacked = (st.stacked ?? st).active.length;
    moment = {
      ...moment,
      ...(lines !== stacked ? { count: lines } : {}),
      ...(register ? { register } : {}),
    };
  }
  const sym = moment.notes.kind === 'chord' ? moment.notes.symbol : c.num;
  return { moment, job: c.job, name: letterName(sym, th.key) };
}

/** A From-the-key chip's fit for a selected chord's spot (`diatonicChords` order). */
export interface ChipRank {
  /** The chip's `DiatonicChord.degree`. */
  degree: number;
  /** The chip's `DiatonicChord.symbol`. */
  symbol: string;
  /** 0 = best fit among the chips. */
  rank: number;
  score: number;
}

/**
 * For the chord moment `id`, how well each of the key's diatonic chords (core/chord-spec
 * `diatonicChords`, keyed by `degree`) fits its spot: between the chord before it and the next
 * one after it (its own harmony entries skipped). Chips the key's theory doesn't name (e.g. a
 * harmonic-minor III+) are left out. Null when the moment isn't found or the key has no theory.
 */
export function chordPickerRanks(
  piece: Piece,
  score: CompiledScore,
  id: MomentId,
): ChipRank[] | null {
  const m = piece.moments.find((x) => x.id === id);
  if (!m) return null;
  const key = keyAt(score, m.at);
  const th = theoryOf(key);
  if (!th) return null;
  const { prev, next } = neighboursAt(score, th, m.at, id);
  const spot = spotRanks(th, prev, next);
  const rows: Omit<ChipRank, 'rank'>[] = [];
  for (const chip of diatonicChords(key)) {
    const want = chip.quality.id;
    const c = th.chords.find(
      (x) =>
        x.root === chip.root &&
        (want === 'maj' ? x.quality === 'maj' || x.quality === 'dom' : x.quality === want),
    );
    const s = c && spot.find((r) => r.num === c.num);
    if (s) rows.push({ degree: chip.degree, symbol: chip.symbol, score: s.score });
  }
  const order = rows.map((_, i) => i).sort((a, b) => rows[b].score - rows[a].score || a - b);
  const out = rows.map((r) => ({ ...r, rank: 0 }));
  order.forEach((i, rank) => (out[i].rank = rank));
  return out;
}
