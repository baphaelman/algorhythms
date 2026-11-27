/**
 * Auditioning (PLAN.md §11.3 "Drag preview and auditioning", owner 2026-11-21): short sounds for
 * edits inside an open moment, played only while the transport is stopped.
 *
 * - `auditionAfterEdit(id)`: an inspector pick; once the edit has compiled, the moment's resulting
 *   notes sound once for `AUDITION_SECONDS`. `auditionStepAfterEdit` (a walk step) and
 *   `auditionPointsAfterEdit` (moved dots) do the same for one step or a set of notes.
 * - `auditionMoment(id)`: selecting a moment; its resulting notes once (not the transition).
 * - `holdNote(voice, pitch, t)`: a note drag; the note at its snapped pitch, held until
 *   `stopAudition()` (the release). Each new pitch replaces the sound.
 *
 * Every note keeps its voice's timbre, level, weight, gain, pan and sends at its time: the audition
 * is a tiny score of the real voices (the others silent), played from 0 on the engine's own voice
 * path (`AudioEngine.audition`). A new audition replaces the one sounding; one still waiting for
 * the engine is skipped.
 */

import { keyAt, lifeAt, pitchAt, segmentAt, stackAt, weightAt } from '../core/query';
import type {
  CompiledScore,
  CompiledVoice,
  MomentId,
  Pitch,
  Seconds,
  Segment,
} from '../core/types';
import { auditionAudio, endAuditionAudio, primeAudio, resumeAudio } from './audio';
import { tuneLineAt } from './editor/tune';
import { compiledThisTask, usePlayer } from './store';

/** Length of a one-shot audition, seconds. */
export const AUDITION_SECONDS = 1.5;
/** Longest held audition (a drag), seconds. */
export const HOLD_SECONDS = 30;
/** Fade at the end of a one-shot audition, seconds. */
const FADE_OUT = 0.3;
/** Longest wait for an edit to compile before auditioning it anyway, ms. */
const EDIT_WAIT_MS = 500;

/** One auditioned note: a pool voice and a pitch. */
export interface AuditionNote {
  voice: number;
  pitch: Pitch;
}

/** What the audition is doing (read by tests through the debug hook). */
export const auditionState = {
  /** Auditions started so far. */
  count: 0,
  /** Auditions refused because the transport was playing. */
  suppressed: 0,
  /** An audition is sounding (or about to). */
  active: false,
  /** The latest audition is held (a drag) rather than one-shot. */
  held: false,
  /** The latest audition's notes. */
  notes: [] as AuditionNote[],
  /** What started the latest audition ('hover': a card's hover sound), else null. */
  kind: null as string | null,
  /** The latest audition's length, seconds. */
  seconds: 0,
  /** Auditions stopped so far, and the latest stop's fade-out (seconds; 0 = the engine's 5 ms). */
  stops: 0,
  lastFade: 0,
};

let token = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** The timbre preset of `v` at `t` (the latest change at or before it). */
function timbreAt(v: CompiledVoice, t: Seconds): string {
  let preset = v.timbre[0]?.preset ?? 'default';
  for (const c of v.timbre) {
    if (c.t > t) break;
    preset = c.preset;
  }
  return preset;
}

/** The level of `v` at `t` (1 before the first change; linear ramps). */
export function levelAt(v: CompiledVoice, t: Seconds): number {
  let g = 1;
  for (const c of v.level) {
    if (c.t > t) break;
    const u = c.over > 0 ? (t - c.t) / c.over : 1;
    g = u >= 1 ? c.gain : g + (c.gain - g) * u;
  }
  return g;
}

/**
 * The tiny score an audition plays: every pool voice of `score` (so the engine's voice ids match),
 * those in `notes` holding their pitch from 0 to `seconds` with the timbre, level, weight and stack
 * they have at `t`, the rest silent.
 */
export function auditionScore(
  score: CompiledScore,
  notes: readonly AuditionNote[],
  t: Seconds,
  seconds: Seconds,
  melody?: readonly { pitch: Pitch; len: Seconds }[],
): CompiledScore {
  const pitchOf = new Map<number, Pitch>();
  for (const n of notes) if (!pitchOf.has(n.voice)) pitchOf.set(n.voice, n.pitch);
  const fadeOut = Math.min(FADE_OUT, seconds / 2);
  const voices = score.voices.map((v): CompiledVoice => {
    const p = pitchOf.get(v.index);
    const base: CompiledVoice = {
      id: v.id,
      index: v.index,
      lives: [],
      segments: [],
      timbre: [{ t: 0, preset: timbreAt(v, t), fade: 0 }],
      level: [],
      gain: v.gain,
      pan: v.pan,
      mute: v.mute,
      solo: v.solo,
      sends: { ...v.sends },
    };
    if (p === undefined) return base;
    // The first note's voice plays `melody` (if given) instead of holding its pitch.
    const segments =
      melody && melody.length > 0 && v.index === notes[0].voice
        ? melodySegments(melody, seconds)
        : [{ t0: 0, t1: seconds, p0: p, p1: p, ease: 'linear' } as Segment];
    return {
      ...base,
      lives: [{ born: 0, died: seconds, fadeIn: 0.01, fadeOut }],
      segments,
      level: [{ t: 0, gain: levelAt(v, t), over: 0 }],
      weight: [{ t: 0, w: weightAt(v, t), over: 0 }],
      stack: [{ t: 0, n: stackAt(v, t) }],
    };
  });
  return {
    duration: seconds,
    voices,
    momentSpans: [],
    walkSteps: [],
    diagnostics: [],
    keys: [{ t: 0, key: keyAt(score, t) }],
    referenceHz: score.referenceHz,
    seed: score.seed,
  };
}

/** Glide between melody notes in an audition, seconds. */
const MELODY_GLIDE = 0.04;

/** A melody as contiguous segments from 0: each note held, then a short glide to the next. */
function melodySegments(
  melody: readonly { pitch: Pitch; len: Seconds }[],
  seconds: Seconds,
): Segment[] {
  const out: Segment[] = [];
  let t = 0;
  for (let i = 0; i < melody.length && t < seconds; i++) {
    const { pitch, len } = melody[i];
    const next = melody[i + 1];
    const end = Math.min(seconds, t + len);
    const g = next ? Math.min(MELODY_GLIDE, len / 3) : 0;
    const hold = Math.max(t, end - g);
    out.push({ t0: t, t1: hold, p0: pitch, p1: pitch, ease: 'linear' });
    if (next && end > hold)
      out.push({ t0: hold, t1: end, p0: pitch, p1: next.pitch, ease: 'linear' });
    t = end;
  }
  const last = out.at(-1);
  if (last && last.t1 < seconds)
    out.push({ t0: last.t1, t1: seconds, p0: last.p1, p1: last.p1, ease: 'linear' });
  return out;
}

/** Longest melody audition, seconds. */
const MELODY_SECONDS = 8;

/**
 * The notes a moment lands on, by voice: each voice's destination from the moment's own segments,
 * else (a voice it held, or didn't target) the destination sounding at the end of its span. Voices
 * whose life ends there (thinned out) are left out. Empty if the moment has no span.
 */
export function momentNotes(
  score: CompiledScore,
  id: MomentId,
): { notes: AuditionNote[]; t: Seconds } {
  const span = score.momentSpans.find((s) => s.id === id);
  if (!span) return { notes: [], t: 0 };
  const t = span.end;
  const dest = (s: Segment): Pitch => (s.curve ? s.curve.p1 : s.p1);
  const notes: AuditionNote[] = [];
  for (const v of score.voices) {
    const life = lifeAt(v, t) ?? lifeAt(v, t - 1e-6);
    if (!life || (life.died !== undefined && life.died <= t + 1e-6)) continue;
    let p: Pitch | null = null;
    for (const s of v.segments) if (s.momentId === id) p = dest(s);
    if (p === null) {
      const s = segmentAt(v, t);
      if (s) p = dest(s);
    }
    if (p !== null) notes.push({ voice: v.index, pitch: p });
  }
  return { notes, t };
}

/** True if auditions are refused now (the transport is playing or scrubbing). */
function busy(): boolean {
  const { transport } = usePlayer.getState();
  return transport.status === 'playing' || transport.scrubbing;
}

/**
 * Plays `notes` (voices and timbres as in the current score at `t`) for `seconds`, or held until
 * `stopAudition` when `held`. Replaces any audition sounding. False if refused or empty.
 */
export function audition(
  notes: readonly AuditionNote[],
  t: Seconds,
  {
    held = false,
    seconds = AUDITION_SECONDS,
    melody,
  }: {
    held?: boolean;
    seconds?: Seconds;
    /** The first note's voice plays these notes in turn (a tune's melody). */
    melody?: readonly { pitch: Pitch; len: Seconds }[];
  } = {},
): boolean {
  if (busy()) {
    auditionState.suppressed++;
    return false;
  }
  if (notes.length === 0) return false;
  const { compiled } = usePlayer.getState();
  const length = held ? HOLD_SECONDS : seconds;
  const score = auditionScore(compiled, notes, t, length, melody);
  return playAudition(score, { notes, held, seconds: length });
}

/**
 * Plays a ready-made audition `score` from `from` for `seconds` (then stops it), replacing any
 * audition sounding; `notes` and `held` are recorded in `auditionState`. False if refused.
 */
export function playAudition(
  score: CompiledScore,
  {
    notes,
    seconds,
    from = 0,
    held = false,
    kind = null,
  }: {
    notes: readonly AuditionNote[];
    seconds: Seconds;
    from?: Seconds;
    held?: boolean;
    /** What started it, for tests ('hover': a card's hover sound). */
    kind?: string | null;
  },
): boolean {
  if (busy()) {
    auditionState.suppressed++;
    return false;
  }
  const { piece } = usePlayer.getState();
  const my = ++token;
  auditionState.count++;
  auditionState.active = true;
  auditionState.held = held;
  auditionState.notes = notes.slice();
  auditionState.kind = kind;
  auditionState.seconds = seconds;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => stopAudition(), seconds * 1000);
  void primeAudio().catch(() => undefined);
  resumeAudio();
  void auditionAudio(
    score,
    piece.timbres,
    () => my === token,
    () => my === token && auditionState.active,
    from,
  ).catch(() => undefined);
  return true;
}

/**
 * Stops the audition (a drag's release, or the one-shot's end), fading out over `fade` seconds
 * (default the engine's 5 ms).
 */
export function stopAudition(fade?: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!auditionState.active) return;
  auditionState.active = false;
  auditionState.stops++;
  auditionState.lastFade = fade ?? 0;
  token++;
  endAuditionAudio(fade);
}

/** Plays what moment `id` moves to in the current score: its resulting notes, once. */
export function auditionMoment(id: MomentId, only?: readonly Pitch[]): boolean {
  const { compiled } = usePlayer.getState();
  const r = momentNotes(compiled, id);
  const notes = only ? pickPitches(r.notes, only) : r.notes;
  return audition(notes, r.t);
}

/** The notes sounding `only`'s pitches (nearest within ½ semitone), each voice once. */
function pickPitches(notes: readonly AuditionNote[], only: readonly Pitch[]): AuditionNote[] {
  return notes.filter((n) => only.some((p) => Math.abs(p - n.pitch) < 0.5));
}

let pendingEdit: { stop: () => void } | null = null;

/**
 * After an edit to moment `id` (an inspector pick, a ▲/▼ step): once the edit has compiled, plays
 * the moment's resulting notes once (`only`: just the notes at those pitches). A newer call
 * replaces a pending one. Call from the input handler, so the audio context can resume.
 */
export function auditionAfterEdit(id: MomentId, only?: readonly Pitch[]): void {
  afterEdit(() => auditionMoment(id, only));
}

/**
 * The line that plays tune `id` in the current score (editor/tune `tuneLineAt`). Not just a line
 * with a segment of the tune: a tune whose notes all equal the line's pitch moves nothing.
 */
function tuneVoice(id: MomentId): number | undefined {
  const { compiled, piece } = usePlayer.getState();
  const m = piece.moments.find((x) => x.id === id);
  return m?.type === 'tune' ? tuneLineAt(piece, compiled, m).voice : undefined;
}

/**
 * A tune's "Melody on" pick: once the edit has compiled, `pitch` (its first note) on the line that
 * now plays tune `id`, at `t`.
 */
export function auditionTuneAfterEdit(id: MomentId, pitch: Pitch, t: Seconds): void {
  afterEdit(() => {
    const v = tuneVoice(id);
    if (v !== undefined) audition([{ voice: v, pitch }], t);
  });
}

/**
 * A tune's new melody (Random melody): once the edit has compiled, its notes in turn on the line
 * that plays tune `id`, from `at` (at most MELODY_SECONDS).
 */
export function auditionMelodyAfterEdit(
  id: MomentId,
  notes: readonly { pitch: Pitch; len: Seconds }[],
  at: Seconds,
): void {
  if (notes.length === 0) return;
  afterEdit(() => {
    const v = tuneVoice(id);
    if (v === undefined) return;
    const total = notes.reduce((a, n) => a + n.len, 0);
    const seconds = Math.min(MELODY_SECONDS, total + FADE_OUT);
    audition([{ voice: v, pitch: notes[0].pitch }], at, { seconds, melody: notes });
  });
}

/** A walk step (Steps list ▲/▼): once the edit has compiled, the step's voice at its new pitch. */
export function auditionStepAfterEdit(step: {
  momentId: MomentId;
  tick: number;
  voice: string;
}): void {
  afterEdit(() => {
    const score = usePlayer.getState().compiled;
    const s = score.walkSteps.find(
      (r) => r.momentId === step.momentId && r.tick === step.tick && r.voice === step.voice,
    );
    const voice = score.voices.findIndex((v) => v.id === step.voice);
    if (s && voice >= 0) audition([{ voice, pitch: s.to }], s.t);
  });
}

/**
 * The notes heading for their destinations at `t`: each voice alive there, at the end pitch of its
 * segment at `t`.
 */
export function notesAt(score: CompiledScore, t: Seconds): AuditionNote[] {
  const out: AuditionNote[] = [];
  for (const v of score.voices) {
    const life = lifeAt(v, t);
    if (!life || (life.died !== undefined && life.died <= t + 1e-6)) continue;
    const s = segmentAt(v, t);
    if (s) out.push({ voice: v.index, pitch: s.curve ? s.curve.p1 : s.p1 });
  }
  return out;
}

/**
 * A progression chord picked or changed in the inspector: once the edit has compiled, the notes
 * the voices hold at `t` (just before the chord's end), once.
 */
export function auditionAtAfterEdit(t: Seconds): void {
  afterEdit(() => {
    audition(notesAt(usePlayer.getState().compiled, t), t);
  });
}

/**
 * Moved arrival points (Shift+▲/▼ on dots): once the edit has compiled, their pitches together,
 * each on its voice (else the voice sounding nearest it at its time), at the first one's time.
 */
export function auditionPointsAfterEdit(
  points: readonly { pitch: Pitch; t: Seconds; voice?: number }[],
): void {
  if (points.length === 0) return;
  afterEdit(() => {
    const score = usePlayer.getState().compiled;
    const notes: AuditionNote[] = [];
    for (const p of points) {
      const voice = p.voice ?? nearestVoice(score, p.pitch, p.t);
      if (voice !== undefined && !notes.some((n) => n.voice === voice))
        notes.push({ voice, pitch: p.pitch });
    }
    audition(notes, points[0].t);
  });
}

/**
 * Runs `play` once the edit just made has compiled (at the end of this task if it already has;
 * else on the next compile, or after EDIT_WAIT_MS). A newer call replaces a pending one; refused
 * while the transport plays.
 */
function afterEdit(play: () => void): void {
  pendingEdit?.stop();
  pendingEdit = null;
  if (busy()) {
    auditionState.suppressed++;
    return;
  }
  void primeAudio().catch(() => undefined);
  resumeAudio();
  const before = usePlayer.getState().compiled;
  let done = false;
  const fire = (): void => {
    if (done) return;
    stop();
    play();
  };
  // A one-off edit compiles before returning, so it is already in the score: play at the end of
  // this task (a newer edit in the same task still replaces it). Else wait for the next compile.
  const now = compiledThisTask();
  if (now) queueMicrotask(fire);
  const unsubscribe = now
    ? () => undefined
    : usePlayer.subscribe((s) => {
        if (s.compiled !== before) fire();
      });
  const wait = now ? undefined : setTimeout(fire, EDIT_WAIT_MS);
  const stop = (): void => {
    done = true;
    unsubscribe();
    clearTimeout(wait);
    if (pendingEdit === entry) pendingEdit = null;
  };
  const entry = { stop };
  pendingEdit = entry;
}

/**
 * A note drag: sounds `voice` at `pitch` (its timbre and level at `t`), held until `stopAudition`.
 * The same note again does nothing, so only pitch changes re-sound.
 */
export function holdNote(voice: number | undefined, pitch: Pitch, t: Seconds): boolean {
  if (voice === undefined) voice = nearestVoice(usePlayer.getState().compiled, pitch, t);
  if (voice === undefined) return false;
  const cur = auditionState.notes;
  if (
    auditionState.active &&
    auditionState.held &&
    cur.length === 1 &&
    cur[0].voice === voice &&
    cur[0].pitch === pitch
  ) {
    return true;
  }
  return audition([{ voice, pitch }], t, { held: true });
}

/** The voice sounding nearest to `pitch` at `t` (or just before it), if any. */
function nearestVoice(score: CompiledScore, pitch: Pitch, t: Seconds): number | undefined {
  let best: number | undefined;
  let d = Infinity;
  for (const v of score.voices) {
    const p = pitchAt(v, t) ?? pitchAt(v, t - 1e-3);
    if (p === null || Math.abs(p - pitch) >= d) continue;
    d = Math.abs(p - pitch);
    best = v.index;
  }
  return best;
}

// Play, scrubbing and loads (idle) stop an audition at once; a seek while stopped doesn't. The
// engine also ends it on play, pause and seek.
usePlayer.subscribe((s, prev) => {
  const to = s.transport.status;
  if ((to !== prev.transport.status && to !== 'paused') || s.transport.scrubbing) {
    pendingEdit?.stop();
    stopAudition();
  }
});
