/**
 * The row model (PLAN.md §6.4, M10b; design: docs/build-log.md "M10b-1 row model"). Blocks are
 * today's moments: `rowsOf` is a read-only view of a piece as rows of blocks, and the conversion
 * helpers return new moments for the row inspectors to write. No DOM, no store.
 */

import { partOf, partScope } from '../../core/parts';
import { progressionStarts } from '../../core/moments/progression';
import { activeAt, keyAt, pitchAt } from '../../core/query';
import { pitchClassOf } from '../../core/scales';
import type {
  ChordMoment,
  CompiledScore,
  Glide,
  Key,
  Moment,
  MomentBase,
  MomentId,
  MomentType,
  NoteSet,
  Piece,
  Pitch,
  PulseMoment,
  Seconds,
  ShiftMoment,
  SpreadMoment,
  VoiceSelector,
  WalkMoment,
} from '../../core/types';
import { keyName } from '../../render/draw';
import { partNames } from './parts';
import { freezeProgression, progressionChordNames } from './progression';
import { tuneEnd } from './tune';

// ---------------------------------------------------------------------------------------------
// Rows and blocks
// ---------------------------------------------------------------------------------------------

export type RowName = 'key' | 'chords' | 'texture' | 'melody' | 'level' | 'sound';

/** Rows top to bottom. */
export const ROW_ORDER: readonly RowName[] = [
  'key',
  'chords',
  'texture',
  'melody',
  'level',
  'sound',
];

/** Rows that get one row per part when the piece has parts. */
export const PART_ROWS: ReadonlySet<RowName> = new Set(['texture', 'melody', 'level', 'sound']);

/** Rows whose blocks last until the next block on the row. */
const CHAINED: ReadonlySet<RowName> = new Set(['key', 'chords']);

/** The id of the piece key's band (it is not a moment). */
export const PIECE_KEY = '__piece-key';

export type BlockKind =
  'key' | 'chord' | 'relative' | 'wander' | 'arpeggio' | 'pulse' | 'melody' | 'level' | 'sound';

export interface Block {
  /** Moment id (`PIECE_KEY` for the piece key's band). */
  id: MomentId;
  /** A progression's chord index (one block per chord). */
  index?: number;
  type: MomentType | null;
  row: RowName;
  /** On a part row: the part ('' = All). Absent on shared rows and pieces without parts. */
  part?: string;
  start: Seconds;
  end: Seconds;
  label: string;
  /** "one note", "6 notes" for a chord with `count`. */
  detail?: string;
  kind: BlockKind;
  /** unison, split, merge or progression: an inspector edit rewrites it as chord(s). */
  legacy: boolean;
  muted: boolean;
  /** Sub-row within its row (overlapping blocks stack). */
  sub: number;
}

export interface Row {
  row: RowName;
  part?: string;
  blocks: Block[];
  /** Sub-rows used (at least 1). */
  subRows: number;
}

/** A note or pin moment: a dot on the lines, not a block. */
export interface Dot {
  id: MomentId;
  type: 'note' | 'pin';
  at: Seconds;
  muted: boolean;
}

export interface RowsView {
  rows: Row[];
  dots: Dot[];
}

/** The row a moment type belongs to; null for the dots (note, pin). */
export function rowOf(type: MomentType): RowName | null {
  switch (type) {
    case 'key':
      return 'key';
    case 'chord':
    case 'unison':
    case 'split':
    case 'merge':
    case 'shift':
    case 'spread':
    case 'progression':
      return 'chords';
    case 'walk':
    case 'pulse':
      return 'texture';
    case 'tune':
      return 'melody';
    case 'level':
      return 'level';
    case 'timbre':
      return 'sound';
    case 'note':
    case 'pin':
      return null;
  }
}

/** Types an inspector edit rewrites as chord moments. */
export const LEGACY_TYPES: ReadonlySet<MomentType> = new Set([
  'unison',
  'split',
  'merge',
  'progression',
]);

/**
 * The part row a target belongs on: `{ part }` or a one-name `{ parts }`, or `{ voices }` all of
 * one part; else '' (All).
 */
export function blockPart(piece: Piece, target: VoiceSelector | undefined): string {
  const sc = partScope(target);
  if (sc) return !sc.except && sc.names.length === 1 ? sc.names[0] : '';
  if (target && typeof target === 'object' && 'voices' in target) {
    const parts = new Set(target.voices.map((id) => partOf(piece.voices.find((v) => v.id === id))));
    return parts.size === 1 ? [...parts][0] : '';
  }
  return '';
}

const targetKey = (t: VoiceSelector | undefined): string => JSON.stringify(t ?? 'all');

const countText = (n: number): string => (n === 1 ? 'one note' : `${n} notes`);

/** The chord part of a harmony label: "ii7 · Dm7" → "Dm7". */
function chordPart(label: string): string {
  const dot = label.indexOf(' · ');
  return dot < 0 ? label : label.slice(dot + 3);
}

/** A texture moment's kind: walk = Wander, pulse together = Pulse, other pulses = Arpeggio. */
export function textureOf(m: Moment): TextureKind | null {
  if (m.type === 'walk') return 'wander';
  if (m.type === 'pulse') return m.mode === 'together' ? 'pulse' : 'arpeggio';
  return null;
}

/** Short label of a relative chord block. */
function relativeLabel(m: ShiftMoment | SpreadMoment): string {
  if (m.type === 'shift') {
    const sign = m.by > 0 ? '+' : m.by < 0 ? '−' : '';
    return `${sign}${Math.abs(m.by)} ${m.unit === 'scaleSteps' ? 'steps' : 'st'}`;
  }
  return m.factor === -1 ? 'upside down' : m.factor > 1 ? 'wider' : 'closer';
}

interface Draft extends Omit<Block, 'sub'> {
  /** Chain key (chained rows): same-target blocks end each other; 'all' ends every target. */
  chain: string;
}

/**
 * The piece as rows of blocks (§6.4) and dots. Reads `score` for chord names (`harmony`), key
 * times and the end of the last chained block (`duration`). Never writes to `piece`. Points (a
 * key change, a 0 s level ramp) count as `minSpan` seconds wide for sub-row stacking.
 */
export function rowsOf(
  piece: Piece,
  score: Pick<CompiledScore, 'duration' | 'harmony' | 'keys'>,
  opts: { minSpan?: Seconds } = {},
): RowsView {
  const minSpan = opts.minSpan ?? 0.5;
  const parted = partNames(piece).length > 0;
  const chordName = new Map<MomentId, string>();
  for (const h of score.harmony ?? [])
    if (!h.from && !chordName.has(h.momentId)) chordName.set(h.momentId, chordPart(h.label));
  const keyOfT = (t: Seconds): Key => {
    let k = piece.key;
    for (const e of score.keys ?? []) if (e.t <= t) k = e.key;
    return k;
  };

  const drafts: Draft[] = [
    {
      id: PIECE_KEY,
      type: null,
      row: 'key',
      start: 0,
      end: 0,
      label: keyName(piece.key),
      kind: 'key',
      legacy: false,
      muted: false,
      chain: '',
    },
  ];
  const dots: Dot[] = [];

  for (const m of piece.moments) {
    const row = rowOf(m.type);
    if (row === null) {
      dots.push({ id: m.id, type: m.type as 'note' | 'pin', at: m.at, muted: !!m.muted });
      continue;
    }
    const base = {
      id: m.id,
      type: m.type,
      row,
      legacy: LEGACY_TYPES.has(m.type),
      muted: !!m.muted,
      chain: row === 'key' ? '' : targetKey(m.target),
      ...(parted && PART_ROWS.has(row) ? { part: blockPart(piece, m.target) } : {}),
    };
    const label = m.label?.trim() || undefined;
    const at = m.at;
    switch (m.type) {
      case 'progression': {
        const starts = progressionStarts(m);
        const names = progressionChordNames(m, score.harmony, keyOfT);
        m.chords.forEach((c, k) => {
          drafts.push({
            ...base,
            index: k,
            start: starts[k],
            end: starts[k + 1],
            label: (k === 0 ? label : undefined) ?? chordPart(names[k] ?? c.notes),
            kind: 'chord',
            ...(m.count !== undefined ? { detail: countText(m.count) } : {}),
          });
        });
        break;
      }
      case 'key':
        drafts.push({ ...base, start: at, end: at, label: label ?? keyName(m.key), kind: 'key' });
        break;
      case 'chord':
        drafts.push({
          ...base,
          start: at,
          end: at,
          label: label ?? chordName.get(m.id) ?? 'chord',
          kind: 'chord',
          ...(m.count !== undefined ? { detail: countText(m.count) } : {}),
        });
        break;
      case 'unison':
        drafts.push({ ...base, start: at, end: at, label: label ?? 'one note', kind: 'chord' });
        break;
      case 'split':
      case 'merge':
        drafts.push({
          ...base,
          start: at,
          end: at,
          label: label ?? countText(m.count),
          kind: 'chord',
        });
        break;
      case 'shift':
      case 'spread':
        drafts.push({
          ...base,
          start: at,
          end: at,
          label: label ?? relativeLabel(m),
          kind: 'relative',
        });
        break;
      case 'walk':
      case 'pulse': {
        const kind = textureOf(m) as TextureKind;
        drafts.push({
          ...base,
          start: at,
          end: Math.max(at, m.until),
          label: label ?? TEXTURE_NAMES[kind],
          kind: kind as BlockKind,
        });
        break;
      }
      case 'tune':
        drafts.push({
          ...base,
          start: at,
          end: Math.max(at, tuneEnd(m)),
          label: label ?? 'melody',
          kind: 'melody',
        });
        break;
      case 'level':
        drafts.push({
          ...base,
          start: at,
          end: at + Math.max(0, m.over),
          label: label ?? `${Math.round(m.gain * 100)}%`,
          kind: 'level',
        });
        break;
      case 'timbre':
        drafts.push({
          ...base,
          start: at,
          end: at + Math.max(0, m.fade),
          label: label ?? m.preset,
          kind: 'sound',
        });
        break;
      case 'note':
      case 'pin':
        break;
    }
  }

  // Chained rows: a block ends at the next later block on its row with its target, or targeting
  // all; the last one at the score's end.
  const ALL = targetKey(undefined);
  for (const row of CHAINED) {
    const list = drafts.filter((d) => d.row === row);
    for (const d of list) {
      let end = Math.max(score.duration, d.start);
      for (const e of list) {
        if (e.start > d.start && e.start < end && (e.chain === d.chain || e.chain === ALL))
          end = e.start;
      }
      d.end = end;
    }
  }

  // Group into rows: shared rows once; part rows per part, plus All when used.
  const rows: Row[] = [];
  for (const row of ROW_ORDER) {
    const mine = drafts.filter((d) => d.row === row);
    if (parted && PART_ROWS.has(row)) {
      const names = partNames(piece);
      if (mine.some((d) => d.part === '')) names.push('');
      for (const part of names)
        rows.push(
          packRow(
            row,
            mine.filter((d) => d.part === part),
            minSpan,
            part,
          ),
        );
    } else {
      rows.push(packRow(row, mine, minSpan));
    }
  }
  return { rows, dots };
}

/** Sub-rows by greedy packing over time (blocks in time order; ties keep piece order). */
function packRow(row: RowName, drafts: Draft[], minSpan: Seconds, part?: string): Row {
  const order = drafts.map((_, i) => i).sort((a, b) => drafts[a].start - drafts[b].start || a - b);
  const ends: Seconds[] = [];
  const blocks = new Array<Block>(drafts.length);
  for (const i of order) {
    const { chain: _chain, ...d } = drafts[i];
    const right = Math.max(d.end, d.start + minSpan);
    let sub = ends.findIndex((e) => e <= d.start + 1e-9);
    if (sub < 0) {
      sub = ends.length;
      ends.push(right);
    } else ends[sub] = right;
    blocks[i] = { ...d, sub };
  }
  return {
    row,
    ...(part !== undefined ? { part } : {}),
    blocks: order.map((i) => blocks[i]),
    subRows: Math.max(1, ends.length),
  };
}

// ---------------------------------------------------------------------------------------------
// Chord blocks: Notes, Arrive, relative shapes
// ---------------------------------------------------------------------------------------------

export type Arrive = 'land' | 'float' | 'custom';

/**
 * Float: the video's slow, staggered glide from the marker (the demo's `buildTimeline` for its
 * 2-bar blocks: length 2.4 s ±15 %, stagger 1 s, each voice ending on its own).
 */
export const FLOAT_GLIDE: Readonly<Glide> = Object.freeze({
  land: false,
  length: 2.4,
  stagger: 1,
  jitter: 0.15,
  arrive: 'spread',
  order: 'random',
  ease: 'smootherstep',
});

const FLOAT_KEYS = Object.keys(FLOAT_GLIDE) as (keyof Glide)[];

/** How a block arrives: Float when its own glide is exactly FLOAT_GLIDE, Land when it lands. */
export function arriveOf(m: Pick<Moment, 'glide'>, defaults: Glide): Arrive {
  const g = m.glide ?? {};
  if (FLOAT_KEYS.every((k) => JSON.stringify(g[k]) === JSON.stringify(FLOAT_GLIDE[k])))
    return 'float';
  return { ...defaults, ...g }.land === true ? 'land' : 'custom';
}

/**
 * `m` set to arrive `a`: Land sets `glide.land` (dropping the Float values when it was Float);
 * Float replaces the glide; Custom stops landing, keeping the rest (minus the Float values).
 */
export function setArrive<M extends Moment>(m: M, a: Arrive, defaults: Glide): M {
  if (arriveOf(m, defaults) === a) return m;
  if (a === 'float') return { ...m, glide: { ...FLOAT_GLIDE } };
  const wasFloat = arriveOf(m, defaults) === 'float';
  const g: Partial<Glide> = { ...m.glide };
  if (wasFloat) for (const k of FLOAT_KEYS) delete g[k];
  g.land = a === 'land';
  return { ...m, glide: g };
}

/** Notes: n on a chord block (1..pool size). */
export function setNotesCount(m: ChordMoment, n: number, pool: number): ChordMoment {
  const count = Math.max(1, Math.min(pool, Math.round(n)));
  return m.count === count ? m : { ...m, count };
}

export type RelativeShape =
  | { kind: 'moved'; by: number; unit: 'semitones' | 'scaleSteps' }
  | { kind: 'spacing'; factor: number }
  | { kind: 'upside-down' };

/** A relative chord block's shape, or null for an absolute one. */
export function relativeShapeOf(m: Moment): RelativeShape | null {
  if (m.type === 'shift') return { kind: 'moved', by: m.by, unit: m.unit };
  if (m.type === 'spread')
    return m.factor === -1 ? { kind: 'upside-down' } : { kind: 'spacing', factor: m.factor };
  return null;
}

/** The fields every Chords block keeps when it changes type. */
function common(m: Moment): Omit<MomentBase, 'type'> {
  const out: Omit<MomentBase, 'type'> = { id: m.id, at: m.at };
  for (const k of ['target', 'glide', 'seed', 'label', 'muted', 'overrides'] as const) {
    if (m[k] !== undefined) (out as Record<string, unknown>)[k] = m[k];
  }
  return out;
}

/** A Chords block as a relative one: shift (moved) or spread (spacing; upside down = −1). */
export function setRelative(m: Moment, shape: RelativeShape): ShiftMoment | SpreadMoment {
  if (shape.kind === 'moved')
    return { ...common(m), type: 'shift', by: shape.by, unit: shape.unit };
  const factor = shape.kind === 'upside-down' ? -1 : shape.factor;
  const keep = m.type === 'spread' ? { around: m.around, snap: m.snap } : null;
  return {
    ...common(m),
    type: 'spread',
    factor,
    around: keep?.around ?? 'mean',
    snap: keep?.snap ?? 'scale',
  };
}

/** A Chords block as an absolute chord of `notes` (voicing even, ordered). */
export function setAbsolute(m: Moment, notes: NoteSet): ChordMoment {
  if (m.type === 'chord') return { ...m, notes };
  return { ...common(m), type: 'chord', notes, voicing: 'even', assign: 'ordered' };
}

// ---------------------------------------------------------------------------------------------
// Legacy rewrites
// ---------------------------------------------------------------------------------------------

/** Pitches of the voices sounding at `t` that `target` would act on (parts only; else all). */
function soundingAt(
  piece: Piece,
  score: CompiledScore,
  t: Seconds,
  target?: VoiceSelector,
): Pitch[] {
  const sc = partScope(target);
  const out: Pitch[] = [];
  for (const i of activeAt(score, t)) {
    const v = score.voices[i];
    if (sc && sc.names.includes(partOf(piece.voices[i])) === sc.except) continue;
    const p = pitchAt(v, t);
    if (p !== null) out.push(p);
  }
  return out;
}

/**
 * A unison, split or merge as the chord moment it stands for (§6.4); other moments as they are.
 * For an inspector edit only: an unedited moment is never rewritten. Id and seed are kept.
 */
export function asChord(m: Moment, piece: Piece, score: CompiledScore): Moment {
  if (m.type === 'split') {
    const out: ChordMoment = {
      ...common(m),
      type: 'chord',
      notes: m.notes ?? { kind: 'current' },
      voicing: m.voicing,
      assign: 'ordered',
      count: m.count,
    };
    return out;
  }
  if (m.type === 'merge') {
    return {
      ...common(m),
      type: 'chord',
      notes: { kind: 'current' },
      voicing: 'nearest',
      assign: 'ordered',
      count: m.count,
    };
  }
  if (m.type !== 'unison') return m;
  const read = Math.max(0, m.at - 1e-3);
  let p: Pitch;
  if (typeof m.pitch === 'number') p = m.pitch;
  else if (m.pitch === 'tonic' && !m.octaves) {
    return {
      ...common(m),
      type: 'chord',
      notes: { kind: 'degrees', degrees: [0] },
      voicing: 'even',
      assign: 'ordered',
      count: 1,
    };
  } else {
    const ps = soundingAt(piece, score, read, m.target);
    if (m.pitch === 'tonic' || ps.length === 0) {
      p = 48 + pitchClassOf(keyAt(score, read).tonic);
    } else p = Math.round(ps.reduce((a, b) => a + b, 0) / ps.length);
  }
  if (!m.octaves) {
    return {
      ...common(m),
      type: 'chord',
      notes: { kind: 'pitches', pitches: [p] },
      voicing: 'even',
      assign: 'ordered',
      count: 1,
    };
  }
  // Octaves: that pitch class across the targeted voices' range; the count is unchanged.
  const pcOf = ((Math.round(p) % 12) + 12) % 12;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of piece.voices) {
    lo = Math.min(lo, v.range[0]);
    hi = Math.max(hi, v.range[1]);
  }
  const pitches: Pitch[] = [];
  for (let q = Math.ceil((lo - pcOf) / 12) * 12 + pcOf; q <= hi; q += 12) pitches.push(q);
  return {
    ...common(m),
    type: 'chord',
    notes: { kind: 'pitches', pitches: pitches.length ? pitches : [p] },
    voicing: 'nearest',
    assign: 'ordered',
  };
}

/**
 * `piece` with legacy block `id` rewritten as chord moment(s), and the id of the chord block that
 * was chord `index` (a progression is frozen into one chord per chord, which sounds the same).
 * The piece itself when the moment is not legacy (or is missing).
 */
export function rewriteAsChord(
  piece: Piece,
  score: CompiledScore,
  id: MomentId,
  index = 0,
  rnd?: () => number,
): { piece: Piece; id: MomentId } {
  const i = piece.moments.findIndex((m) => m.id === id);
  const m = piece.moments[i];
  if (!m || !LEGACY_TYPES.has(m.type)) return { piece, id };
  if (m.type === 'progression') {
    const before = new Set(piece.moments.map((x) => x.id));
    const out = freezeProgression(piece, id, rnd);
    const fresh = out.moments.filter((x) => !before.has(x.id));
    return { piece: out, id: fresh[Math.min(index, fresh.length - 1)]?.id ?? id };
  }
  const moments = piece.moments.slice();
  moments[i] = asChord(m, piece, score);
  return { piece: { ...piece, moments }, id };
}

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------

export type TextureKind = 'wander' | 'arpeggio' | 'pulse';
export type TextureChoice = TextureKind | 'hold';

export const TEXTURE_NAMES: Record<TextureKind, string> = {
  wander: 'Wander',
  arpeggio: 'Arpeggio',
  pulse: 'Pulse',
};

/** Beat and bar (seconds): the piece's tempo, else the demo's 80 bpm; meter default 4. */
export function beatAndBar(piece: Piece): { beat: Seconds; bar: Seconds; perBar: number } {
  const bpm = piece.view?.gridBpm;
  const beat = typeof bpm === 'number' && bpm > 0 ? 60 / bpm : 0.75;
  const meter = piece.view?.meter;
  const perBar = typeof meter === 'number' && meter > 0 ? meter : 4;
  return { beat, bar: beat * perBar, perBar };
}

const r6 = (t: Seconds): Seconds => Math.round(t * 1e6) / 1e6;

/** The up-down walk over n lines (1-based: 1 2 … n … 2), repeated to `steps` entries. */
export function arpeggioOrder(n: number, steps: number): number[] {
  const up = Array.from({ length: Math.max(1, n) }, (_, i) => i + 1);
  const cyc = up.length <= 1 ? up : [...up, ...up.slice(1, -1).reverse()];
  return Array.from({ length: steps }, (_, s) => cyc[s % cyc.length]);
}

/**
 * The fields of an Arpeggio pulse over `n` lines: eighth steps, accent 1 on the bar's first step
 * and 0.78 after, `order` the up-down walk. Both lists are one bar long, so it restarts each bar.
 */
export function arpeggioFields(
  piece: Piece,
  n: number,
): Pick<PulseMoment, 'step' | 'pattern' | 'mode' | 'order' | 'decay' | 'floor'> {
  const { beat, perBar } = beatAndBar(piece);
  const steps = perBar * 2;
  return {
    step: r6(beat / 2),
    pattern: [1, ...Array<number>(steps - 1).fill(0.78)],
    mode: 'order',
    order: arpeggioOrder(n, steps),
    decay: 0.3,
    floor: 0,
  };
}

/**
 * A texture moment of `kind` over [at, until] with the fields the row model gives it (build log
 * "M10b-1 row model"); `n` is the note count it arpeggiates. Glide and target left to the caller.
 */
export function textureMoment(
  kind: TextureKind,
  base: { id: MomentId; at: Seconds; until: Seconds },
  piece: Piece,
  n: number,
): WalkMoment | PulseMoment {
  const { beat } = beatAndBar(piece);
  if (kind === 'wander') {
    return {
      ...base,
      type: 'walk',
      grid: r6(beat),
      density: 0.5,
      steps: [-2, -1, 1, 2],
      stepGlide: 0.22,
      over: 'chord',
    };
  }
  if (kind === 'pulse') {
    return {
      ...base,
      type: 'pulse',
      step: r6(beat / 2),
      pattern: [1, 0.45, 0.7, 0.45],
      decay: 0.3,
      floor: 0,
      mode: 'together',
    };
  }
  return { ...base, type: 'pulse', ...arpeggioFields(piece, n) };
}

/**
 * A texture block set to `choice`: null for Hold (delete it); itself when unchanged; else the
 * new texture over the same region, keeping id, target, label, muted and seed.
 */
export function setTexture(
  m: WalkMoment | PulseMoment,
  choice: TextureChoice,
  piece: Piece,
  n: number,
): WalkMoment | PulseMoment | null {
  if (choice === 'hold') return null;
  if (textureOf(m) === choice) return m;
  const out = textureMoment(choice, { id: m.id, at: m.at, until: m.until }, piece, n);
  for (const k of ['target', 'seed', 'label', 'muted'] as const) {
    if (m[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = m[k];
  }
  return out;
}

/**
 * Where a new texture at `at` ends: the end of the Chords block sounding at `at`, else 2 bars.
 */
export function textureUntil(view: RowsView, piece: Piece, at: Seconds): Seconds {
  const chords = view.rows.find((r) => r.row === 'chords');
  let best: Block | undefined;
  for (const b of chords?.blocks ?? []) {
    if (b.start <= at + 1e-9 && b.end > at + 1e-9 && (!best || b.start > best.start)) best = b;
  }
  return r6(best ? best.end : at + 2 * beatAndBar(piece).bar);
}
