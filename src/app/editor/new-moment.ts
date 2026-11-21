/**
 * Default moments for the palette and the add shortcuts (§11.3). Each default reads the piece's
 * state at `at` from the compiled score, so a fresh moment does something audible there when it
 * can. The choices are listed in docs/build-log.md (M4b).
 */

import { mod } from '../../core/math';
import { defaultNoteFields } from '../../core/moments/note';
import { activeAt, keyAt, pitchAt } from '../../core/query';
import {
  FLAT_NAMES,
  SHARP_NAMES,
  degreesToPcs,
  pitchClassOf,
  stepByScale,
} from '../../core/scales';
import { pitchClasses } from '../../core/voicing';
import type {
  ChordMoment,
  CompiledScore,
  Key,
  Moment,
  MomentId,
  MomentOf,
  MomentType,
  Piece,
  Seconds,
} from '../../core/types';

/** Length of a new walk region, seconds. */
export const NEW_WALK_LENGTH = 16;

/** What the piece is doing at `at`: sounding voices (pool order) and the key. */
function stateAt(score: CompiledScore, at: Seconds) {
  const active = activeAt(score, at).map((i) => ({
    id: score.voices[i].id,
    pitch: pitchAt(score.voices[i], at) ?? 0,
  }));
  return { active, key: keyAt(score, at) };
}

/**
 * A new moment of `type` at `at` with id `id`, given the piece and its compiled score. The glide
 * and target are left to the piece defaults ('all').
 */
export function defaultMoment<T extends MomentType>(
  type: T,
  at: Seconds,
  id: MomentId,
  piece: Piece,
  score: CompiledScore,
): MomentOf<T> {
  // At or past the end (open-ended canvas) the defaults follow the state just before it: adding
  // there extends the piece, and the voices hold until then.
  const read = Math.min(at, Math.max(0, score.duration - 0.01));
  const { active, key } = stateAt(score, read);
  // Lines, not Σ weights: count sets how many lines are heard (owner, 2026-11-21).
  const n = active.length;
  const pool = piece.voices.length;
  const base = { id, at };
  let m: Moment;
  switch (type as MomentType) {
    case 'chord': {
      // The tonic triad; the IV triad when the sounding notes already all belong to it.
      const tonic = degreesToPcs([0, 2, 4], key);
      const sounding = active.map((v) => mod(Math.round(v.pitch), 12));
      const onTonic = n > 0 && sounding.every((pc) => tonic.includes(pc));
      const degrees = onTonic ? [3, 5, 7] : [0, 2, 4];
      m = {
        ...base,
        type: 'chord',
        notes: { kind: 'degrees', degrees },
        voicing: 'even',
        assign: 'ordered',
      };
      break;
    }
    case 'unison':
      m = { ...base, type: 'unison', pitch: n >= 2 ? 'center' : 'tonic', octaves: false };
      break;
    case 'split':
      m = { ...base, type: 'split', count: Math.min(pool, Math.max(n + 2, 3)), voicing: 'even' };
      break;
    case 'merge':
      m = {
        ...base,
        type: 'merge',
        count: Math.max(1, Math.ceil(n / 2)),
        which: 'top',
        fade: 2,
      };
      break;
    case 'shift':
      m = { ...base, type: 'shift', by: 2, unit: 'scaleSteps' };
      break;
    case 'spread':
      m = { ...base, type: 'spread', factor: 1.5, around: 'mean', snap: 'scale' };
      break;
    case 'walk':
      m = {
        ...base,
        type: 'walk',
        until: at + NEW_WALK_LENGTH,
        grid: 1,
        density: 0.45,
        steps: [-2, -1, 1, 2],
        stepGlide: 0.3,
      };
      break;
    case 'note':
      // The sounding note nearest the middle, one scale step up (core/moments/note.ts).
      m = { ...base, type: 'note', ...defaultNoteFields(score, read) };
      break;
    case 'pin': {
      // The top sounding voice, two scale steps up (the first pool voice if nothing sounds).
      const top = active.reduce<(typeof active)[number] | null>(
        (best, v) => (best === null || v.pitch > best.pitch ? v : best),
        null,
      );
      const voice = top?.id ?? piece.voices[0]?.id ?? 'v1';
      const from = top?.pitch ?? 60;
      m = { ...base, type: 'pin', voice, pitch: stepByScale(from, 2, key) };
      break;
    }
    case 'key': {
      // Up a fifth, same scale; spelled with flats if the current tonic is.
      const names = key.tonic.includes('b') ? FLAT_NAMES : SHARP_NAMES;
      const tonic = names[mod(pitchClassOf(key.tonic) + 7, 12)];
      m = { ...base, type: 'key', key: { tonic, scale: key.scale } };
      break;
    }
    case 'level':
      m = { ...base, type: 'level', gain: 0.5, over: 2 };
      break;
    case 'pulse':
      m = {
        ...base,
        type: 'pulse',
        until: at + 4,
        step: 0.5,
        pattern: [1],
        decay: 0.3,
        floor: 0,
        mode: 'together',
      };
      break;
  }
  return withChordFill(m, piece, score, at) as MomentOf<T>;
}

/** How many notes a chord names: its pitch list's length or its distinct pitch classes (0: unknown). */
export function chordSize(m: ChordMoment, key: Key): number {
  if (m.notes.kind === 'pitches') return m.notes.pitches.length;
  if (m.notes.kind === 'current') return 0;
  const pc = pitchClasses(m.notes, key, []);
  return pc.ok ? pc.pcs.length : 0;
}

/**
 * A new chord brings in its extra notes (owner, "Mouse-only gaps"): when fewer lines sound at `at`
 * than the chord has notes, `count` becomes its size (at most the pool), so it sounds as a chord.
 * Otherwise, or with a count or a voice target already set, `m` is returned as is. From silence
 * the chord establishes one voice per note anyway (core/moments/establish), so nothing is added.
 */
export function withChordFill<M extends Moment>(
  m: M,
  piece: Piece,
  score: CompiledScore,
  at: Seconds,
): M {
  if (m.type !== 'chord' || m.count !== undefined || m.byVoice) return m;
  if (m.target && typeof m.target === 'object') return m;
  const read = Math.min(at, Math.max(0, score.duration - 0.01));
  const n = activeAt(score, read).length;
  if (n === 0) return m;
  const want = Math.min(piece.voices.length, chordSize(m, keyAt(score, read)));
  return want > n ? { ...m, count: want } : m;
}
