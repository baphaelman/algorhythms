/**
 * Default moments for the palette and the add shortcuts (§11.3). Each default reads the piece's
 * state at `at` from the compiled score, so a fresh moment does something audible there when it
 * can. The choices are listed in docs/build-log.md (M4b).
 */

import { MOMENT_DEFAULTS } from '../../core/defaults';
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
import { chordDefaultAt } from '../../core/suggest';
import { pitchClasses } from '../../core/voicing';
import { momentSeed } from '../../core/rng';
import { writtenInAt } from './tune';
import { fittedNotes, harmonyScore, melodyLength } from './melody-fit';
import { newProgressionChords, progressionSpacing } from './progression';
import { timbreOptions } from './voices';
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
  TuneMoment,
} from '../../core/types';

/**
 * Where adding at `t` puts a moment: 0:00 while the piece has no moments (the piece key is not one,
 * M4.5-39), so the first moment always opens the piece (owner 2026-11-21); else `t`.
 */
export function addTimeIn(piece: Piece, t: Seconds): Seconds {
  return piece.moments.length === 0 ? 0 : t;
}

/** Length of a new walk region, seconds. */
export const NEW_WALK_LENGTH = 16;

/** Seconds per beat when the piece has a tempo, else null. */
function beatOf(piece: Piece): Seconds | null {
  const bpm = piece.view?.gridBpm;
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null;
}

const round6 = (t: Seconds): Seconds => Math.round(t * 1e6) / 1e6;

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
      // The chord that best fits the spot, by the key's chord theory (§11.3 rev 14).
      const fit = chordDefaultAt(piece, score, at);
      if (fit) {
        m = { ...fit.moment, ...base };
        break;
      }
      // Keys without theory: the tonic triad; the IV triad when the sounding notes already all belong to it.
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
    case 'pulse': {
      // A gated chord with a strong-weak accent: eighth notes for two bars with a tempo, else
      // 0.5 s steps for 4 s (R9-7).
      const beat = beatOf(piece);
      const meter = piece.view?.meter;
      const bar = typeof meter === 'number' && meter > 0 ? meter : 4;
      m = {
        ...base,
        type: 'pulse',
        until: beat ? round6(at + 2 * bar * beat) : at + 4,
        step: beat ? round6(beat / 2) : 0.5,
        pattern: [1, 0.5, 0.75, 0.5],
        decay: 0.3,
        floor: 0,
        mode: 'together',
      };
      break;
    }
    case 'tune': {
      // With more than one line sounding the melody goes on top (`line: 'high'`; a product call,
      // build log "Tune: Melody on"). A melody fitted to the chords (M10b-5) over the Chords
      // block at `at` (2 bars without one), seeded by the piece seed and the id.
      const high = n > 1;
      const seed = momentSeed(piece.seed, id);
      const tune: TuneMoment = {
        ...base,
        type: 'tune',
        notes: [],
        ...(high ? { line: 'high' as const } : {}),
        // Revision 10: new tunes follow the key (inspector "Follow key").
        writtenIn: writtenInAt(score, base.at),
        fit: { seed },
      };
      const hs = piece.moments.some((x) => x.type === 'tune' && x.fit)
        ? harmonyScore(piece)
        : score;
      tune.notes = fittedNotes(piece, hs, tune, seed, melodyLength(piece, score, at));
      m = tune;
      break;
    }
    case 'progression':
      // The key's own chords (I vi IV V in major), each the default spacing: glide, then Next's
      // hold (owner notes 2026-11-22).
      m = {
        ...base,
        type: 'progression',
        chords: newProgressionChords(progressionSpacing(piece), key),
        voicing: 'even',
        assign: 'ordered',
      };
      break;
    case 'timbre':
      m = {
        ...base,
        type: 'timbre',
        preset: newTimbrePreset(piece, score, at),
        fade: MOMENT_DEFAULTS.timbre.fade,
      };
      break;
  }
  return withChordFill(m, piece, score, at) as MomentOf<T>;
}

/** The preset voice `v` (pool index) is heading for at `t` (changes at `t` included). */
function timbreAt(score: CompiledScore, v: number, t: Seconds): string | undefined {
  let preset: string | undefined;
  for (const c of score.voices[v]?.timbre ?? []) if (c.t <= t) preset = c.preset;
  return preset;
}

/**
 * A new timbre moment's preset: the first of the piece's timbres, then the built-ins
 * (`timbreOptions` order), that no note plays at `at`, so the change is heard on every note it
 * targets (the default target 'all' includes silent notes). If every one is in use, the first
 * that differs from the most common timbre there.
 */
export function newTimbrePreset(piece: Piece, score: CompiledScore, at: Seconds): string {
  const now = piece.voices.map((def, v) => timbreAt(score, v, at) ?? def.timbre);
  const options = timbreOptions(piece);
  const free = options.find((t) => !now.includes(t));
  if (free !== undefined) return free;
  const count = new Map<string, number>();
  for (const t of now) count.set(t, (count.get(t) ?? 0) + 1);
  const common = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  return options.find((t) => t !== common) ?? options[0];
}

/** How many notes a chord names: its pitch list's length or its distinct pitch classes (0: unknown). */
export function chordSize(m: ChordMoment, key: Key): number {
  if (m.notes.kind === 'pitches') return m.notes.pitches.length;
  if (m.notes.kind === 'current') return 0;
  const pc = pitchClasses(m.notes, key, []);
  return pc.ok ? pc.pcs.length : 0;
}

/**
 * A new chord (or progression, by its largest chord) brings in its extra notes (owner, "Mouse-only gaps"): when fewer lines sound at `at`
 * than the chord has notes, `count` becomes its size (at most the pool), so it sounds as a chord.
 * Otherwise, or with a count or a voice target already set, `m` is returned as is. From silence
 * the chord establishes one voice per note anyway (core/moments/establish), so nothing is added;
 * a progression whose largest chord has more notes than its first gets that count, so chord 1
 * establishes the full count (owner notes 2026-11-22).
 */
export function withChordFill<M extends Moment>(
  m: M,
  piece: Piece,
  score: CompiledScore,
  at: Seconds,
): M {
  if (m.type === 'progression') {
    if (m.count !== undefined || (m.target && typeof m.target === 'object')) return m;
    const read = Math.min(at, Math.max(0, score.duration - 0.01));
    // Its chords' sizes, each read in the key at `at`.
    const key = keyAt(score, read);
    const sizes = m.chords.map((c) => {
      const pc = pitchClasses({ kind: 'chord', symbol: c.notes }, key, []);
      return pc.ok ? pc.pcs.length : 0;
    });
    const size = Math.max(0, ...sizes);
    // From silence chord 1 brings in its own notes' worth.
    const n = activeAt(score, read).length || (sizes[0] ?? 0);
    const want = Math.min(piece.voices.length, size);
    return n > 0 && want > n ? { ...m, count: want } : m;
  }
  if (m.type !== 'chord' || m.count !== undefined || m.byVoice) return m;
  if (m.target && typeof m.target === 'object') return m;
  const read = Math.min(at, Math.max(0, score.duration - 0.01));
  const n = activeAt(score, read).length;
  if (n === 0) return m;
  const want = Math.min(piece.voices.length, chordSize(m, keyAt(score, read)));
  return want > n ? { ...m, count: want } : m;
}
