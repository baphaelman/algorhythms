/**
 * Compose for me's setup (PLAN.md §11.3 "Compose for me, directed", M12): the answers, their
 * Surprise me defaults, the brief they make, the open piece's melody, and the answers remembered
 * per browser. Pure functions (storage is passed in), unit-tested in Node.
 */

import type { Piece } from '../core/types';
import {
  PROGRESSIONS,
  type ComposeBrief,
  type ComposeLength,
  type Mood as ComposeMood,
  type ComposePart,
  type Shape as ComposeShape,
} from '../core/compose-brief';

export const SURPRISE = 'surprise';
type Surprise = typeof SURPRISE;

export const MOODS: readonly { id: ComposeMood; label: string }[] = [
  { id: 'calm', label: 'Calm' },
  { id: 'bright', label: 'Bright' },
  { id: 'dreamy', label: 'Dreamy' },
  { id: 'dark', label: 'Dark' },
  { id: 'driving', label: 'Driving' },
];
export const LENGTHS: readonly { id: ComposeLength; label: string }[] = [
  { id: 60, label: '1 min' },
  { id: 120, label: '2 min' },
  { id: 180, label: '3 min' },
  { id: 300, label: '5 min' },
];
export const SHAPES: readonly { id: ComposeShape; label: string }[] = [
  { id: 'build', label: 'Build up' },
  { id: 'arc', label: 'Arc' },
  { id: 'steady', label: 'Steady' },
  { id: 'journey', label: 'Journey' },
];
export const PARTS: readonly { id: ComposePart; label: string }[] = [
  { id: 'chords', label: 'Chords' },
  { id: 'bass', label: 'Bass' },
  { id: 'melody', label: 'Melody' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'bells', label: 'Bells' },
];
export const TONICS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;
export const KEY_SCALES: readonly { id: string; label: string }[] = [
  { id: 'major', label: 'Major' },
  { id: 'minor', label: 'Minor' },
  { id: 'dorian', label: 'Dorian' },
  { id: 'lydian', label: 'Lydian' },
  { id: 'mixolydian', label: 'Mixolydian' },
  { id: 'phrygian', label: 'Phrygian' },
  { id: 'pentatonic-major', label: 'Pentatonic' },
  { id: 'pentatonic-minor', label: 'Minor pentatonic' },
];
export const TEMPO_MIN = 40;
export const TEMPO_MAX = 200;

/** Start from: Surprise, nothing, the open piece's melody, or a progression's name. */
export type StartAnswer = Surprise | 'none' | 'melody' | { progression: string };

/** The setup screen's answers. */
export interface ComposeAnswers {
  mood: ComposeMood | Surprise;
  length: ComposeLength | Surprise;
  shape: ComposeShape | Surprise;
  /** Surprise, or at least one part. */
  parts: ComposePart[] | Surprise;
  start: StartAnswer;
  /** Key and scale (More): the tonic's pitch class, or Surprise; the scale counts only with one. */
  tonic: number | Surprise;
  scale: string;
  /** Beats per minute (More), or Surprise (from the mood). */
  tempo: number | Surprise;
}

export const DEFAULT_ANSWERS: ComposeAnswers = {
  mood: SURPRISE,
  length: SURPRISE,
  shape: SURPRISE,
  parts: SURPRISE,
  start: SURPRISE,
  tonic: SURPRISE,
  scale: 'major',
  tempo: SURPRISE,
};

export type MelodyNote = { at: number; pitch: number; dur: number };

/**
 * The open piece's melody: the sounding notes of its unmuted tunes on the first tune's line
 * (same target and line), in time order, at absolute times. Null when it has none.
 */
export function melodyOf(piece: Piece): MelodyNote[] | null {
  const tunes = piece.moments
    .filter((m) => m.type === 'tune' && !m.muted)
    .sort((a, b) => a.at - b.at);
  const first = tunes[0];
  if (!first || first.type !== 'tune') return null;
  const lineOf = (m: typeof first) => JSON.stringify([m.target ?? null, m.line ?? 'low']);
  const line = lineOf(first);
  const notes: MelodyNote[] = [];
  for (const m of tunes) {
    if (m.type !== 'tune' || lineOf(m) !== line) continue;
    let at = m.at;
    for (const n of m.notes) {
      if (n.pitch !== undefined) notes.push({ at, pitch: n.pitch, dur: n.len });
      at += n.len;
    }
  }
  notes.sort((a, b) => a.at - b.at);
  return notes.length > 0 ? notes : null;
}

/** The brief for these answers (Surprise leaves a field out). `melody`: the open piece's. */
export function buildBrief(
  a: ComposeAnswers,
  seed: number,
  melody: MelodyNote[] | null = null,
): ComposeBrief {
  const brief: ComposeBrief = { seed: seed >>> 0 };
  if (a.mood !== SURPRISE) brief.mood = a.mood;
  if (a.length !== SURPRISE) brief.length = a.length;
  if (a.shape !== SURPRISE) brief.shape = a.shape;
  if (a.parts !== SURPRISE && a.parts.length > 0) {
    brief.parts = PARTS.map((p) => p.id).filter((p) => (a.parts as ComposePart[]).includes(p));
  }
  if (a.start === 'none') brief.start = { kind: 'none' };
  else if (a.start === 'melody') {
    if (melody) brief.start = { kind: 'melody', notes: melody.map((n) => ({ ...n })) };
  } else if (a.start !== SURPRISE) brief.start = { kind: 'progression', name: a.start.progression };
  if (a.tonic !== SURPRISE) brief.key = { tonic: a.tonic, mode: a.scale };
  if (a.tempo !== SURPRISE) brief.tempo = a.tempo;
  return brief;
}

/** The answers as the screen shows them: a melody start without a melody shows Surprise. */
export function shownAnswers(a: ComposeAnswers, hasMelody: boolean): ComposeAnswers {
  return a.start === 'melody' && !hasMelody ? { ...a, start: SURPRISE } : a;
}

// ---------------------------------------------------------------------------------------------
// Remembered answers (per browser)
// ---------------------------------------------------------------------------------------------

/** localStorage key of the remembered answers. */
export const COMPOSE_PREFS_KEY = 'algorhythms.compose';
export type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function storageOf(s?: PrefsStorage | null): PrefsStorage | null {
  if (s !== undefined) return s;
  return globalThis.localStorage ?? null;
}

const oneOf = <T>(v: unknown, ids: readonly { id: T }[]): T | Surprise =>
  ids.some((o) => o.id === v) ? (v as T) : SURPRISE;

/** Reads stored answers, keeping only valid fields (the rest are Surprise). */
export function parseAnswers(raw: unknown): ComposeAnswers {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const parts = Array.isArray(o.parts)
    ? PARTS.map((p) => p.id).filter((p) => (o.parts as unknown[]).includes(p))
    : [];
  let start: StartAnswer = SURPRISE;
  if (o.start === 'none' || o.start === 'melody') start = o.start;
  else if (typeof o.start === 'object' && o.start !== null) {
    const name = (o.start as { progression?: unknown }).progression;
    if (PROGRESSIONS.some((p) => p.name === name)) start = { progression: name as string };
  }
  const tonic = o.tonic;
  const tempo = o.tempo;
  return {
    mood: oneOf(o.mood, MOODS),
    length: oneOf(o.length, LENGTHS),
    shape: oneOf(o.shape, SHAPES),
    parts: parts.length > 0 ? parts : SURPRISE,
    start,
    tonic:
      Number.isInteger(tonic) && (tonic as number) >= 0 && (tonic as number) < 12
        ? (tonic as number)
        : SURPRISE,
    scale: KEY_SCALES.some((s) => s.id === o.scale) ? (o.scale as string) : DEFAULT_ANSWERS.scale,
    tempo:
      typeof tempo === 'number' && tempo >= TEMPO_MIN && tempo <= TEMPO_MAX
        ? Math.round(tempo)
        : SURPRISE,
  };
}

export function loadAnswers(storage?: PrefsStorage | null): ComposeAnswers {
  try {
    const raw = storageOf(storage)?.getItem(COMPOSE_PREFS_KEY);
    return raw ? parseAnswers(JSON.parse(raw)) : { ...DEFAULT_ANSWERS };
  } catch {
    return { ...DEFAULT_ANSWERS };
  }
}

export function saveAnswers(a: ComposeAnswers, storage?: PrefsStorage | null): boolean {
  try {
    const st = storageOf(storage);
    if (!st) return false;
    st.setItem(COMPOSE_PREFS_KEY, JSON.stringify(a));
    return true;
  } catch {
    return false;
  }
}

/** localStorage key of "Watch the composer" ('0' when unticked). */
export const COMPOSE_WATCH_KEY = 'algorhythms.compose.watch';

/** Whether to watch the build (ticked unless stored unticked, or when storage fails). */
export function loadWatch(storage?: PrefsStorage | null): boolean {
  try {
    return storageOf(storage)?.getItem(COMPOSE_WATCH_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveWatch(watch: boolean, storage?: PrefsStorage | null): boolean {
  try {
    const st = storageOf(storage);
    if (!st) return false;
    st.setItem(COMPOSE_WATCH_KEY, watch ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
