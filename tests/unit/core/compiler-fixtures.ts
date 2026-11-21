/**
 * Shared helpers for the compiler tests: piece builders and score checks.
 */
import { newPiece } from '../../../src/core/defaults';
import { evalSegment } from '../../../src/core/segment';
import { pitchAt } from '../../../src/core/query';
import type {
  CompiledScore,
  CompiledVoice,
  Moment,
  Piece,
  Pitch,
  Segment,
} from '../../../src/core/types';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A moment without its id (filled in by `piece`). */
export type MomentInput = DistributiveOmit<Moment, 'id'> & { id?: string };

/** A piece with `pool` voices (range 36..96), the given start pitches and moments. */
export function piece(opts: {
  seed?: number;
  pool?: number;
  start?: Pitch[];
  moments?: MomentInput[];
  glide?: Partial<Piece['defaults']['glide']>;
  end?: Piece['end'];
  range?: [Pitch, Pitch];
  key?: Piece['key'];
}): Piece {
  const p = newPiece({ seed: opts.seed ?? 2611, poolSize: opts.pool ?? 12 });
  for (const v of p.voices) v.range = opts.range ?? [36, 96];
  p.start = (opts.start ?? [57]).map((pitch, i) => ({ voice: p.voices[i].id, pitch }));
  p.moments = (opts.moments ?? []).map((m, i) => ({ ...m, id: m.id ?? `m${i}` }) as Moment);
  if (opts.glide) p.defaults.glide = { ...p.defaults.glide, ...opts.glide };
  if (opts.end) p.end = opts.end;
  if (opts.key) p.key = opts.key;
  return p;
}

/** Voices with at least one life. */
export function soundingVoices(score: CompiledScore): CompiledVoice[] {
  return score.voices.filter((v) => v.lives.length > 0);
}

/** Pitch of every voice at t (null when silent). */
export function pitchesAt(score: CompiledScore, t: number): (Pitch | null)[] {
  return score.voices.map((v) => pitchAt(v, t));
}

/** Segments of a voice inside one life (by born time). */
export function lifeSegments(v: CompiledVoice, lifeIndex: number): Segment[] {
  const life = v.lives[lifeIndex];
  const end = life.died ?? Infinity;
  return v.segments.filter((s) => s.t0 >= life.born && s.t1 <= end);
}

/** Final pitch of a voice (at its last segment's end). */
export function finalPitch(v: CompiledVoice): Pitch {
  const s = v.segments[v.segments.length - 1];
  return evalSegment(s, s.t1);
}

/** Sorted final pitches of all voices alive at time t. */
export function chordAt(score: CompiledScore, t: number): Pitch[] {
  return pitchesAt(score, t)
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
}

/** Weight of a voice at t (revision 8; 1 without a weight timeline). */
export function weightAt(v: CompiledScore['voices'][number], t: number): number {
  let w = 1;
  for (const c of v.weight ?? []) {
    if (c.t > t) break;
    const u = c.over > 0 ? (t - c.t) / c.over : 1;
    w = u >= 1 ? c.w : w + (c.w - w) * u;
  }
  return w;
}

/**
 * Sorted pitches at t with each line repeated by its (rounded) weight: the stacked voices the
 * lines stand for (revision 8 "Distinct notes").
 */
export function stackedChordAt(score: CompiledScore, t: number): Pitch[] {
  const out: Pitch[] = [];
  score.voices.forEach((v, i) => {
    const p = pitchesAt(score, t)[i];
    if (p === null) return;
    const n = Math.max(1, Math.round(weightAt(v, t)));
    for (let j = 0; j < n; j++) out.push(p);
  });
  return out.sort((a, b) => a - b);
}
