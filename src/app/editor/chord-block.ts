/**
 * Chord and texture block edits (PLAN.md §6.4, M10b-4): the row inspectors' writes. Every
 * Chords-row moment edits as a chord block; a legacy one (unison, split, merge, progression chord
 * k) is rewritten as a chord (`rewriteAsChord`) in the same undo entry as the edit. Pure helpers
 * first, then the store actions.
 */

import { progressionStarts } from '../../core/moments/progression';
import type {
  ChordMoment,
  CompiledScore,
  Moment,
  MomentId,
  Piece,
  ProgressionChord,
  ProgressionMoment,
  PulseMoment,
  Seconds,
  WalkMoment,
} from '../../core/types';
import { usePlayer } from '../store';
import { scoreOf } from './actions';
import { edit, select } from './history';
import { newMomentIds, randomU32 } from './ops';
import { splitProgression } from './progression';
import {
  LEGACY_TYPES,
  asChord,
  relativeShapeOf,
  rewriteAsChord,
  rowOf,
  setTexture,
  type RelativeShape,
  type TextureChoice,
} from './rows';

/** What a Chords block shows: its chord (absolute) or its relative shape. */
export interface ChordBlockView {
  /** The chord it is or stands for (a legacy block's rewrite; a progression's chord k). */
  chord: ChordMoment | null;
  shape: RelativeShape | null;
  /** Unison, split, merge or progression: an edit rewrites it. */
  legacy: boolean;
}

/** A fixed id source for display-only rewrites (the ids are never stored). */
function probeIds(): () => number {
  let n = 0;
  return () => (0x5eed + n++) >>> 0;
}

/** Chord k of a progression as the chord moment its Freeze would make. */
function progressionChord(piece: Piece, m: ProgressionMoment, k: number): ChordMoment | null {
  const chords = splitProgression(piece, m, probeIds());
  return chords[Math.max(0, Math.min(k, chords.length - 1))] ?? null;
}

/** The chord block view of Chords-row moment `m` (chord `k` of a progression). */
export function chordBlockView(
  piece: Piece,
  score: CompiledScore,
  m: Moment,
  k = 0,
): ChordBlockView {
  const shape = relativeShapeOf(m);
  if (shape) return { chord: null, shape, legacy: false };
  const legacy = LEGACY_TYPES.has(m.type);
  if (m.type === 'progression') return { chord: progressionChord(piece, m, k), shape, legacy };
  const c = m.type === 'chord' ? m : asChord(m, piece, score);
  return { chord: c.type === 'chord' ? c : null, shape, legacy };
}

/** What a chord-block edit does to the (rewritten) block: a new moment, or itself. */
export type BlockEdit = (m: Moment, piece: Piece, score: CompiledScore) => Moment;

/**
 * `piece` with Chords block `id` (chord `k` of a progression) rewritten as a chord when legacy,
 * then `fn` applied to it. Returns the piece unchanged (same object) when `fn` changes nothing,
 * so merely looking at a legacy block never rewrites it.
 */
export function editBlockIn(
  piece: Piece,
  score: CompiledScore,
  id: MomentId,
  k: number,
  fn: BlockEdit,
  rnd: () => number = randomU32,
): { piece: Piece; id: MomentId } {
  const m = piece.moments.find((x) => x.id === id);
  if (!m) return { piece, id };
  // Look first: an edit that changes nothing on the view leaves a legacy block alone.
  const view = chordBlockView(piece, score, m, k);
  const shown = view.chord ?? m;
  if (fn(shown, piece, score) === shown) return { piece, id };
  const r = rewriteAsChord(piece, score, id, k, rnd);
  const i = r.piece.moments.findIndex((x) => x.id === r.id);
  const cur = r.piece.moments[i];
  if (!cur) return { piece, id };
  const next = fn(cur, r.piece, score);
  if (next === cur && r.piece === piece) return { piece, id };
  const moments = r.piece.moments.slice();
  moments[i] = next;
  return { piece: { ...r.piece, moments }, id: r.id };
}

/**
 * `piece` with typed chords `chords` filling a run of plain chord blocks from block `id`'s time
 * (chord `k` of a progression): the first chord rewrites the block (keeping its id, target,
 * glide, voicing and count), each next one starts where the one before ends, and other Chords
 * blocks of the same target starting inside the run are removed. Null for no chords.
 */
export function fillProgressionIn(
  piece: Piece,
  score: CompiledScore,
  id: MomentId,
  k: number,
  chords: readonly ProgressionChord[],
  rnd: () => number = randomU32,
): { piece: Piece; ids: MomentId[] } | null {
  if (chords.length === 0) return null;
  const m = piece.moments.find((x) => x.id === id);
  if (!m) return null;
  const at = m.type === 'progression' ? (progressionStarts(m)[k] ?? m.at) : m.at;
  const r = rewriteAsChord(piece, score, id, k, rnd);
  const base = r.piece.moments.find((x) => x.id === r.id);
  if (!base) return null;
  const tpl: ChordMoment =
    base.type === 'chord'
      ? base
      : {
          id: base.id,
          at,
          type: 'chord',
          notes: { kind: 'chord', symbol: 'I' },
          voicing: 'even',
          assign: 'ordered',
          ...(base.target !== undefined ? { target: base.target } : {}),
          ...(base.glide !== undefined ? { glide: base.glide } : {}),
        };
  const fresh = newMomentIds(r.piece, chords.length - 1, rnd);
  const ids = [r.id, ...fresh];
  const run: ChordMoment[] = [];
  let t = at;
  for (const [j, c] of chords.entries()) {
    const out: ChordMoment = {
      ...tpl,
      id: ids[j],
      at: Math.round(t * 1e6) / 1e6,
      notes: { kind: 'chord', symbol: c.notes },
    };
    // Fixed notes and a label belong to the block that had them; new blocks draw their own seed.
    delete out.frozenFrom;
    delete out.byVoice;
    if (j > 0) {
      delete out.label;
      delete out.seed;
      delete out.overrides;
    }
    run.push(out);
    t += c.len;
  }
  const end = t;
  const same = JSON.stringify(tpl.target ?? 'all');
  const inside = (x: Moment): boolean =>
    x.id !== r.id &&
    rowOf(x.type) === 'chords' &&
    JSON.stringify(x.target ?? 'all') === same &&
    x.at > at + 1e-9 &&
    x.at < end - 1e-9;
  const kept = r.piece.moments.filter((x) => x.id !== r.id && !inside(x));
  const moments = [...kept, ...run]
    .map((x, j) => ({ x, j }))
    .sort((a, b) => a.x.at - b.x.at || a.j - b.j)
    .map((e) => e.x);
  return { piece: { ...r.piece, moments }, ids };
}

// ---------------------------------------------------------------------------------------------
// Actions (one undo entry each)
// ---------------------------------------------------------------------------------------------

/**
 * Edits Chords block `id` (chord `k` of a progression) as a chord block: one undo entry that
 * rewrites a legacy block first. Selects the rewritten block when its id changed (a progression).
 */
export function editChordBlock(id: MomentId, k: number, fn: BlockEdit, label: string): boolean {
  let newId = id;
  const ok = edit((p) => {
    const r = editBlockIn(p, scoreOf(p), id, k, fn);
    newId = r.id;
    return r.piece;
  }, label);
  if (ok && newId !== id) select([newId]);
  return ok;
}

/** Types chords ("IV 2, V 2") into block `id`: a run of chord blocks, one undo entry. */
export function fillProgression(
  id: MomentId,
  k: number,
  chords: readonly ProgressionChord[],
): boolean {
  let ids: MomentId[] = [];
  const ok = edit((p) => {
    const r = fillProgressionIn(p, scoreOf(p), id, k, chords);
    if (!r) return p;
    ids = r.ids;
    return r.piece;
  }, 'Type chords');
  if (ok && ids[0] && ids[0] !== id) select([ids[0]]);
  return ok;
}

/**
 * Sets texture block `id` to `choice` (Hold deletes it), keeping its region, as one undo entry.
 */
export function setTextureOf(id: MomentId, choice: TextureChoice): boolean {
  const piece = usePlayer.getState().piece;
  const m = piece.moments.find((x) => x.id === id);
  if (!m || (m.type !== 'walk' && m.type !== 'pulse')) return false;
  const label =
    choice === 'hold' ? 'Texture: Hold' : `Texture: ${choice[0].toUpperCase()}${choice.slice(1)}`;
  const ok = edit((p) => {
    const i = p.moments.findIndex((x) => x.id === id);
    const cur = p.moments[i] as WalkMoment | PulseMoment | undefined;
    if (!cur) return p;
    const next = setTexture(cur, choice, p);
    if (next === cur) return p;
    const moments = p.moments.slice();
    if (next) moments[i] = next;
    else moments.splice(i, 1);
    return { ...p, moments };
  }, label);
  if (ok && choice === 'hold') select([]);
  return ok;
}

/** Seconds a texture block lasts. */
export function textureLength(m: WalkMoment | PulseMoment): Seconds {
  return m.until - m.at;
}
