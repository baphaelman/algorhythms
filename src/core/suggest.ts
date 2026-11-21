/**
 * Next-move suggestions (PLAN.md §11.3, revision 6): 3–4 musically sensible moments to add at t,
 * drawn from the Generate composer's grammar (core/generate.ts):
 *
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

import { momentEffectAt, readState } from './effect';
import { splitStages } from './generate';
import { nameChord, spellPc } from './harmony';
import { mod } from './math';
import { Purpose, hash32, rand } from './rng';
import { pitchClassOf, scaleIntervals } from './scales';
import { sanitizeRange } from './compiler/range';
import { roundTiesDown } from './voicing';
import type { CompiledScore, Glide, Moment, Piece, Pitch, Seconds } from './types';

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
  /** Short human label, e.g. "Open to Dm9", "Walk 8 s", "Collapse to A". */
  label: string;
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
 * Up to `count` suggested next moments at `t` for `piece` (compiled as `score`), most fitting
 * first. Empty when nothing sounds at t.
 */
export function suggestNext(
  piece: Piece,
  score: CompiledScore,
  t: Seconds,
  count = 4,
): Suggestion[] {
  const at = round3(Math.max(0, t));
  // Stacked voices (revision 8): a merged unison still opens into a chord.
  const st0 = readState(piece, score, at);
  const st = st0.stacked ?? st0;
  const n = st.active.length;
  if (n === 0 || count <= 0) return [];
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
  let rLo = 127;
  let rHi = 0;
  for (const v of st.active) {
    const r = sanitizeRange(piece.voices[v]?.range);
    rLo = Math.min(rLo, r[0]);
    rHi = Math.max(rHi, r[1]);
  }
  const centre = Math.round((lowest + highest) / 2);
  const registerFor = (c: number, k: number, ctr: Pitch): [Pitch, Pitch] | undefined => {
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
    const pcs = pcsOf(c, Math.min(4, S));
    let inside = 0;
    for (let p = a; p <= b; p++) if (pcs.includes(mod(p, 12))) inside++;
    return inside < Math.min(k, 2) || a > b ? undefined : [a, b];
  };
  const chordTonesNear = (c: number, x: Pitch): Pitch => {
    const pcs = pcsOf(c, 3);
    let best = NaN;
    for (let p = rLo; p <= rHi; p++) {
      if (pcs.includes(mod(p, 12)) && !(Math.abs(p - x) >= Math.abs(best - x))) best = p;
    }
    return best === best ? best : Math.round(x);
  };

  const out: Suggestion[] = [];
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
