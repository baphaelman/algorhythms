/**
 * Key changes carry forward to fixed notes (PLAN.md §6.2 `key`, owner 2026-11-21).
 *
 * `remapPitch` moves a fixed pitch from one key to another by scale degree: the degree at or below
 * it keeps its index and octave, and a chromatic note keeps its offset from that degree. The
 * tonic moves the shorter way (ties down, §7.8). Scales of different sizes map each old degree to
 * the new scale's tone nearest its interval (ties down).
 *
 * `remapMoment` applies it to one moment's fixed notes; `fixedNoteMoments` finds the moments with
 * fixed notes in a key moment's span (its `at` to the next key moment, in compile order);
 * `carryKey` does both (a note point's `from` only when its line gets that pitch in the span).
 * Key-relative notes (degrees, Roman numerals, 'tonic', 'center') are left
 * alone: they already follow the key.
 *
 * Integer and exact floating-point operations only (§7.11).
 */

import { compile } from './compiler/compile';
import { createIncrementalCompiler } from './compiler/incremental';
import { sanitizeRange, foldIntoRange } from './compiler/range';
import { sameKey } from './effect';
import { NOTE_MATCH } from './moments/note';
import { lifeAt, segmentIndexAt } from './query';
import { evalSegment } from './segment';
import { spellPc } from './harmony';
import { mod } from './math';
import { parsePitchClass, pitchClassOf, scaleIntervals } from './scales';
import type {
  ChordMoment,
  CompiledScore,
  Key,
  Moment,
  MomentId,
  NoteMoment,
  NoteSet,
  Piece,
  Pitch,
  Seconds,
  SplitMoment,
  VoiceOverride,
} from './types';

/** Semitones the tonic moves from `from` to `to`: the shorter way, a tritone goes down. */
export function tonicShift(from: Key, to: Key): number {
  const d = mod(pitchClassOf(to.tonic) - pitchClassOf(from.tonic), 12);
  return d >= 6 ? d - 12 : d;
}

function sameScale(a: Key, b: Key): boolean {
  const x = scaleIntervals(a.scale);
  const y = scaleIntervals(b.scale);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The interval in `iv` (or the octave, 12) nearest `x`; ties go to the lower one. */
function nearestInterval(x: number, iv: readonly number[]): number {
  let best = iv[0];
  for (const c of [...iv, 12]) if (Math.abs(c - x) < Math.abs(best - x)) best = c;
  return best;
}

/**
 * `p` (a fixed pitch written in key `from`) moved to key `to`: same scale degree and octave,
 * chromatic offset kept, tonic moved the shorter way. Non-finite input is returned unchanged.
 */
export function remapPitch(p: Pitch, from: Key, to: Key): Pitch {
  if (!Number.isFinite(p) || sameKey(from, to)) return p;
  const iv0 = scaleIntervals(from.scale);
  const iv1 = scaleIntervals(to.scale);
  const rel = p - pitchClassOf(from.tonic);
  const within = rel - 12 * Math.floor(rel / 12); // [0, 12)
  let j = 0;
  while (j + 1 < iv0.length && iv0[j + 1] <= within) j++;
  const target = iv0.length === iv1.length ? iv1[j] : nearestInterval(iv0[j], iv1);
  // Integer steps added to p, so a fractional pitch keeps its exact fraction.
  return p + tonicShift(from, to) + (target - iv0[j]);
}

/** A pitch class moved from `from` to `to` (octave-free form of `remapPitch`). */
export function remapPc(pc: number, from: Key, to: Key): number {
  return mod(remapPitch(mod(pc, 12) + 60, from, to), 12);
}

const ROMAN_HEAD = /^[#b]?(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)/;

function ascii(s: string): string {
  return s.replace(/♯/g, '#').replace(/♭/g, 'b');
}

/** The parts of a chord symbol: a letter root (null for a Roman numeral), the rest, the slash. */
function splitSymbol(symbol: string): {
  root: number | null;
  rootText: string;
  suffix: string;
  bass: string | null;
} | null {
  const s = symbol.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const slash = s.indexOf('/');
  const head = slash < 0 ? s : s.slice(0, slash);
  const bass = slash < 0 ? null : s.slice(slash + 1);
  const letter = /^([A-G])([#b]*)/.exec(head);
  if (letter) {
    const root = parsePitchClass(letter[0]);
    if (root === null) return null;
    return { root, rootText: letter[0], suffix: head.slice(letter[0].length), bass };
  }
  const roman = ROMAN_HEAD.exec(head);
  if (!roman) return null;
  return { root: null, rootText: roman[0], suffix: head.slice(roman[0].length), bass };
}

/** True if a chord symbol names a fixed note: a letter root, or a slash bass that is a note. */
export function symbolHasFixedNotes(symbol: string): boolean {
  const p = splitSymbol(symbol);
  if (!p) return false;
  return p.root !== null || (p.bass !== null && parsePitchClass(p.bass) !== null);
}

/**
 * A chord symbol moved from `from` to `to`, or null when that needs a pitch list: a letter-root
 * chord when the scale changes. With only the tonic changing, the root and a note bass are
 * transposed and spelled in `to`. A Roman numeral stays; its note bass (if any) is remapped by
 * degree.
 */
export function remapSymbol(symbol: string, from: Key, to: Key): string | null {
  const p = splitSymbol(symbol);
  if (!p) return symbol;
  if (p.root !== null && !sameScale(from, to)) return null;
  const root = p.root === null ? p.rootText : ascii(spellPc(remapPc(p.root, from, to), to));
  let tail = '';
  if (p.bass !== null) {
    const b = parsePitchClass(p.bass);
    tail = '/' + (b === null ? p.bass : ascii(spellPc(remapPc(b, from, to), to)));
  }
  return root + p.suffix + tail;
}

/** True if a NoteSet holds fixed notes (pitches, or a symbol naming a note). */
export function noteSetIsFixed(notes: NoteSet | undefined): boolean {
  if (!notes) return false;
  if (notes.kind === 'pitches') return notes.pitches.length > 0;
  if (notes.kind === 'chord') return symbolHasFixedNotes(notes.symbol);
  return false;
}

const OVERRIDE_TYPES = new Set<Moment['type']>([
  'chord',
  'unison',
  'split',
  'merge',
  'shift',
  'spread',
  'note',
  'pin',
]);

/** True if moment `m` holds any fixed note that a key change leaves behind. */
export function hasFixedNotes(m: Moment): boolean {
  if (OVERRIDE_TYPES.has(m.type) && m.overrides?.some((o) => o.pitch !== undefined)) return true;
  switch (m.type) {
    case 'chord':
      return noteSetIsFixed(m.notes) || noteSetIsFixed(m.frozenFrom?.notes);
    case 'split':
      return noteSetIsFixed(m.notes);
    case 'unison':
      return typeof m.pitch === 'number';
    case 'note':
      return m.from !== undefined || m.to !== undefined || (m.changes?.length ?? 0) > 0;
    case 'pin':
      return true;
    case 'walk':
      return (m.fixed?.length ?? 0) > 0;
    default:
      return false;
  }
}

/** Moment indices in compile order: by `at`, ties in array order. */
function compileOrder(piece: Piece): number[] {
  return piece.moments
    .map((_, i) => i)
    .sort((a, b) => piece.moments[a].at - piece.moments[b].at || a - b);
}

/** A key moment's span and the moments in it that hold fixed notes. */
export interface KeySpan {
  /** Moments with fixed notes after the key moment and before the next one, in compile order. */
  ids: MomentId[];
  /** The next (unmuted) key moment's time; null when the span runs to the end. */
  until: Seconds | null;
}

/**
 * The fixed-note moments in key moment `keyId`'s span: those the compiler runs after it and
 * before the next unmuted key moment. Muted moments count (they keep their notes). Empty when
 * `keyId` is not an unmuted key moment.
 */
export function fixedNoteMoments(piece: Piece, keyId: MomentId): KeySpan {
  const order = compileOrder(piece);
  const pos = order.findIndex((i) => piece.moments[i].id === keyId);
  const k = pos < 0 ? null : piece.moments[order[pos]];
  if (!k || k.type !== 'key' || k.muted) return { ids: [], until: null };
  const ids: MomentId[] = [];
  for (let q = pos + 1; q < order.length; q++) {
    const m = piece.moments[order[q]];
    if (m.type === 'key' && !m.muted) return { ids, until: m.at };
    if (hasFixedNotes(m)) ids.push(m.id);
  }
  return { ids, until: null };
}

/**
 * The key in effect just before key moment `keyId` takes effect: the previous unmuted key
 * moment's key in compile order, else the piece's key. The "old key" of a newly added key moment.
 */
export function keyBefore(piece: Piece, keyId: MomentId): Key {
  const order = compileOrder(piece);
  let key = piece.key;
  for (const i of order) {
    const m = piece.moments[i];
    if (m.id === keyId) break;
    if (m.type === 'key' && !m.muted) key = m.key;
  }
  return key;
}

/** A remapped note that left its voice's range and was folded back by octaves. */
export interface CarryFold {
  momentId: MomentId;
  /** Pool index of the voice. */
  voice: number;
  /** The remapped pitch, before folding. */
  pitch: Pitch;
  /** The pitch written. */
  folded: Pitch;
  /** No octave fitted: the pitch was clamped to the range. */
  clamped: boolean;
}

export interface RemapOptions {
  /**
   * The pitches a letter-root chord currently voices (low → high), for a scale change, which
   * turns it into a pitch list. Null or absent: the chord is left as it is (`skipped`).
   */
  voiced?: (m: ChordMoment | SplitMoment) => Pitch[] | null;
}

export interface RemapResult {
  moment: Moment;
  folds: CarryFold[];
  /** True when some fixed notes could not be remapped (a named chord without voiced pitches). */
  skipped: boolean;
}

/**
 * Moment `m` (written in key `from`) with every fixed note moved to key `to`: pitch lists, named
 * chords (root transposed when only the tonic changes, else a pitch list of what it voices),
 * frozen chords and walks, note points, pins and unisons on a number, and per-voice pitch
 * overrides. Pitches tied to one voice (pins, frozen walk notes, overrides) fold by octave into
 * that voice's range, reported in `folds`. Returns `m` itself when nothing changes.
 */
export function remapMoment(
  piece: Piece,
  m: Moment,
  from: Key,
  to: Key,
  opts: RemapOptions = {},
): RemapResult {
  const folds: CarryFold[] = [];
  let skipped = false;
  if (sameKey(from, to)) return { moment: m, folds, skipped };
  const r = (p: Pitch): Pitch => remapPitch(p, from, to);
  const voiceIndex = new Map(piece.voices.map((v, i) => [v.id, i]));
  const fold = (voice: number | undefined, p: Pitch): Pitch => {
    const q = r(p);
    if (voice === undefined || !piece.voices[voice]) return q;
    const [lo, hi] = sanitizeRange(piece.voices[voice].range);
    const f = foldIntoRange(q, lo, hi);
    if (f.folded)
      folds.push({ momentId: m.id, voice, pitch: q, folded: f.p, clamped: f.clampedToRange });
    return f.p;
  };
  /** `ns` remapped; `voiced` gives a named chord's pitches when the scale changes. */
  const notes = (ns: NoteSet, voiced: () => Pitch[] | null): NoteSet | null => {
    if (ns.kind === 'pitches') return { kind: 'pitches', pitches: ns.pitches.map(r) };
    if (ns.kind !== 'chord' || !symbolHasFixedNotes(ns.symbol)) return ns;
    const symbol = remapSymbol(ns.symbol, from, to);
    if (symbol !== null) return symbol === ns.symbol ? ns : { kind: 'chord', symbol };
    const ps = voiced();
    return ps && ps.length > 0 ? { kind: 'pitches', pitches: ps.map(r) } : null;
  };
  const hostNotes = (ns: NoteSet, host: ChordMoment | SplitMoment): NoteSet => {
    const out = notes(ns, () => opts.voiced?.(host) ?? null);
    if (out === null) skipped = true;
    return out ?? ns;
  };
  const overrides = (os: VoiceOverride[] | undefined): VoiceOverride[] | undefined =>
    os?.map((o) => (o.pitch === undefined ? o : { ...o, pitch: fold(o.voice, o.pitch) }));

  let out: Moment = m;
  switch (m.type) {
    case 'chord': {
      const next: ChordMoment = { ...m, notes: hostNotes(m.notes, m) };
      if (m.frozenFrom && noteSetIsFixed(m.frozenFrom.notes)) {
        // A named chord the scale change can't rename: Unfreeze gives back the frozen notes.
        const fn = notes(m.frozenFrom.notes, () => null) ?? next.notes;
        next.frozenFrom = { ...m.frozenFrom, notes: fn };
      }
      out = next;
      break;
    }
    case 'split':
      out = m.notes ? { ...m, notes: hostNotes(m.notes, m) } : m;
      break;
    case 'unison':
      out = typeof m.pitch === 'number' ? { ...m, pitch: r(m.pitch) } : m;
      break;
    case 'note': {
      const n = { ...m };
      if (m.from !== undefined) n.from = r(m.from);
      if (m.to !== undefined) n.to = r(m.to);
      if (m.changes) n.changes = m.changes.map((c) => ({ from: r(c.from), to: r(c.to) }));
      out = n;
      break;
    }
    case 'pin':
      out = { ...m, pitch: fold(voiceIndex.get(m.voice), m.pitch) };
      break;
    case 'walk':
      out = m.fixed
        ? {
            ...m,
            fixed: m.fixed.map((w) => ({ ...w, pitch: fold(voiceIndex.get(w.voice), w.pitch) })),
          }
        : m;
      break;
    default:
      break;
  }
  if (OVERRIDE_TYPES.has(m.type) && m.overrides?.some((o) => o.pitch !== undefined)) {
    out = { ...out, overrides: overrides(m.overrides) };
  }
  return { moment: out, folds, skipped };
}

export interface CarryResult {
  piece: Piece;
  /** Moments changed. */
  moved: MomentId[];
  folds: CarryFold[];
  /** Moments with fixed notes left as they were (see `RemapResult.skipped`). */
  skipped: MomentId[];
}

/** A voice's destination and pitch just before moment `momentId` at t; null while silent. */
function stateBefore(
  score: CompiledScore,
  voice: number,
  t: Seconds,
  momentId: MomentId,
): { dest: Pitch; now: Pitch } | null {
  const v = score.voices[voice];
  if (!lifeAt(v, t)) return null;
  let i = segmentIndexAt(v, t);
  // Skip the moment's own glides.
  while (i >= 0 && v.segments[i].t0 >= t && v.segments[i].momentId === momentId) i--;
  if (i < 0) return null;
  const s = v.segments[i];
  if (s.t1 < t - 1e-9) return null;
  return { dest: s.curve ? s.curve.p1 : s.p1, now: evalSegment(s, Math.min(t, s.t1)) };
}

/** How far a voice's state is from `p`: by destination or by the pitch at t, the nearer. */
const distance = (st: { dest: Pitch; now: Pitch }, p: Pitch): number =>
  Math.min(Math.abs(st.dest - p), Math.abs(st.now - p));

/**
 * The voices note moment `m`'s `froms` match in `score` (−1: none). As the compiler matches
 * (nearest within NOTE_MATCH, ties: the lower voice, one voice per change), but over every
 * sounding voice: targeting is not checked.
 */
function matchedVoices(score: CompiledScore, m: NoteMoment, froms: readonly Pitch[]): number[] {
  const states = score.voices.map((_, i) => stateBefore(score, i, m.at, m.id));
  const taken = new Set<number>();
  return froms.map((p) => {
    let best = -1;
    let dist = NOTE_MATCH;
    states.forEach((st, i) => {
      if (!st || taken.has(i)) return;
      const d = distance(st, p);
      if (d < dist || (d === dist && best < 0)) {
        best = i;
        dist = d;
      }
    });
    if (best >= 0) taken.add(best);
    return best;
  });
}

/**
 * `remapped` (note moment `m` with every fixed note moved from `from` to `to`) with each `from`
 * put back where the line it matches still has its old pitch: a line held from before the key.
 * `before` is the score `m` was written against, `after` the carried piece's score up to `m`. A
 * `from` that matches no line in `before` stays moved.
 */
function keepHeldFroms(
  m: NoteMoment,
  remapped: NoteMoment,
  from: Key,
  to: Key,
  before: CompiledScore,
  after: CompiledScore,
): NoteMoment {
  const many = (m.changes?.length ?? 0) > 0;
  const froms = many ? m.changes!.map((c) => c.from) : m.from !== undefined ? [m.from] : [];
  const voices = matchedVoices(before, m, froms);
  const keep = froms.map((p, j) => {
    const rp = remapPitch(p, from, to);
    if (voices[j] < 0 || rp === p) return false;
    const st = stateBefore(after, voices[j], m.at, m.id);
    return st !== null && distance(st, p) < distance(st, rp);
  });
  if (!keep.some(Boolean)) return remapped;
  const n = { ...remapped };
  if (many && remapped.changes) {
    n.changes = remapped.changes.map((c, j) => (keep[j] ? { ...c, from: m.changes![j].from } : c));
  } else if (keep[0]) {
    n.from = m.from;
  }
  return n;
}

/**
 * Moves the fixed notes in key moment `keyId`'s span from key `from` to the key moment's key.
 * A note point's `from` moves only when the line it matches gets its pitch in the span; a line
 * held from before the key keeps its pitch, so its `from` stays (else `note-not-sounding`).
 * Decided on compiled scores, note by note in compile order. Returns `piece` itself when nothing
 * changes.
 */
export function carryKey(
  piece: Piece,
  keyId: MomentId,
  from: Key,
  opts: RemapOptions = {},
): CarryResult {
  const k = piece.moments.find((m) => m.id === keyId);
  const none: CarryResult = { piece, moved: [], folds: [], skipped: [] };
  if (!k || k.type !== 'key') return none;
  const { ids } = fixedNoteMoments(piece, keyId);
  if (ids.length === 0) return none;
  const want = new Set(ids);
  const folds: CarryFold[] = [];
  const skipped: MomentId[] = [];
  const notes: number[] = [];
  const moments = piece.moments.map((m, i) => {
    if (!want.has(m.id)) return m;
    const res = remapMoment(piece, m, from, k.key, opts);
    folds.push(...res.folds);
    if (res.skipped) skipped.push(m.id);
    if (m.type === 'note' && res.moment !== m) notes.push(i);
    return res.moment;
  });
  if (notes.length > 0) {
    // The score the notes were written against: the key moment still in the old key.
    const written = piece.moments.map((m) => (m.id === keyId ? { ...m, key: from } : m));
    const before = compile({ ...piece, moments: written });
    const inc = createIncrementalCompiler();
    notes.sort((a, b) => piece.moments[a].at - piece.moments[b].at || a - b);
    // Undecided notes keep their old `from`s; only moments before each note matter to it.
    const decided = new Map(notes.map((i) => [i, moments[i] as NoteMoment]));
    for (const i of notes) moments[i] = piece.moments[i];
    for (const i of notes) {
      const after = inc.compile({ ...piece, moments: moments.slice() });
      const m = piece.moments[i] as NoteMoment;
      moments[i] = keepHeldFroms(m, decided.get(i)!, from, k.key, before, after);
    }
  }
  const moved = piece.moments.filter((m, i) => moments[i] !== m).map((m) => m.id);
  if (moved.length === 0) return { ...none, skipped };
  return { piece: { ...piece, moments }, moved, folds, skipped };
}
