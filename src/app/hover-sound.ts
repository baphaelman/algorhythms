/**
 * Hover to hear (PLAN.md M13, §11.3; owner 2026-11-23, reverting "hover previews are silent"):
 * hovering or focusing an Add or Next card plays what it would do, once its ghost preview starts
 * (one 250 ms dwell timer, ./preview.ts `PREVIEW_DELAY_MS`). Played through the auditions
 * (./audition.ts), so only while the transport is stopped, on the real voices.
 *
 * - A moment that moves pitches: its transition from the notes sounding at its span's start, at
 *   its real length time-compressed to fit `MAX_GLIDE` (the shape kept), then the result held
 *   for `HOLD_SECONDS`.
 * - A texture (pulse, walk), tune or progression: the music from its start, as it would sound,
 *   for `AFTER_SECONDS`.
 * - A level, timbre or key that moves no pitch: the notes as they sound after it, held for
 *   `AFTER_SECONDS`.
 *
 * Leaving the card stops the sound with a `STOP_FADE` fade. "Hover sound" (view settings, on by
 * default, kept in localStorage) turns it off. Each card also names its result
 * (./editor/card-result.ts).
 */

import { create } from 'zustand';
import { evalSegment } from '../core/segment';
import type {
  CompiledScore,
  CompiledVoice,
  MomentId,
  MomentType,
  Seconds,
  Segment,
} from '../core/types';
import { playAudition, stopAudition, auditionState, type AuditionNote } from './audition';
import { pitchIn } from './editor/card-result';
import { PROBE_ID } from './editor/palette-effects';
import { onPreviewEscape, previewState } from './preview';

/** Longest transition heard, seconds; longer ones are compressed to fit. */
export const MAX_GLIDE = 2;
/** How long the result is held after the transition, seconds. */
export const HOLD_SECONDS = 1.5;
/** How long a texture, level, timbre or key is heard, seconds. */
export const AFTER_SECONDS = 2;
/** Fade when the pointer leaves the card, seconds. */
export const STOP_FADE = 0.05;
/** Fade at the end of a hover sound, seconds. */
const END_FADE = 0.3;
/** `auditionState.kind` of a hover sound. */
export const HOVER_KIND = 'hover';

/** Moment types heard as they play from their start (not as one transition). */
const PLAYED: ReadonlySet<MomentType> = new Set(['pulse', 'walk', 'tune', 'progression']);

/** What a hover plays of a previewed score: the window [t0, t1] sped up by 1/k, then a hold. */
export interface HoverPlan {
  mode: 'transition' | 'played' | 'after';
  t0: Seconds;
  t1: Seconds;
  /** Time factor (≤ 1): t1 − t0 is heard in k·(t1 − t0) seconds. */
  k: number;
  /** Held after t1, seconds. */
  hold: Seconds;
}

/** What moment `id` (of type `type`, at `at`) plays on hover in `score`, the piece with it in. */
export function hoverPlan(
  score: CompiledScore,
  id: MomentId,
  type: MomentType,
  at: Seconds,
): HoverPlan {
  const span = score.momentSpans.find((s) => s.id === id);
  const start = span ? Math.min(span.start, at) : at;
  if (PLAYED.has(type)) {
    return { mode: 'played', t0: start, t1: start + AFTER_SECONDS, k: 1, hold: 0 };
  }
  const moves = score.voices.some((v) => v.segments.some((s) => s.momentId === id));
  if (!span || !moves) {
    const t = span ? Math.max(span.end, at) : at;
    return { mode: 'after', t0: t, t1: t, k: 1, hold: AFTER_SECONDS };
  }
  const d = Math.max(0, span.end - start);
  return {
    mode: 'transition',
    t0: start,
    t1: span.end,
    k: d > MAX_GLIDE ? MAX_GLIDE / d : 1,
    hold: HOLD_SECONDS,
  };
}

/**
 * The audition score of `plan`: `score` with every time scaled by k (so shapes are kept), cut at
 * t1, then each voice alive at t1 held at its pitch there for `hold` (its level, timbre and
 * weight as they were heading). Played from `from` for `seconds`; `notes`: the held result.
 */
export function hoverScore(
  score: CompiledScore,
  plan: HoverPlan,
): { score: CompiledScore; from: Seconds; seconds: Seconds; notes: AuditionNote[] } {
  const { t0, t1, k, hold } = plan;
  const end = k * t1 + hold;
  const fade = Math.min(END_FADE, Math.max(0.01, (end - k * t0) / 2));
  const notes: AuditionNote[] = [];
  const eps = 1e-6;
  const voices = score.voices.map((v): CompiledVoice => {
    const lives = [];
    let alive = false;
    for (const l of v.lives) {
      if (l.born > t1 + eps) continue;
      if (l.died !== undefined && l.died <= t1 + eps) {
        lives.push({
          ...l,
          born: k * l.born,
          died: k * l.died,
          fadeIn: k * l.fadeIn,
          fadeOut: l.fadeOut !== undefined ? k * l.fadeOut : undefined,
        });
        continue;
      }
      alive = true;
      const born = k * l.born;
      lives.push({
        ...l,
        born,
        died: end,
        fadeIn: Math.min(k * l.fadeIn, Math.max(0, end - born - fade)),
        fadeOut: Math.min(fade, end - born),
        crossOut: undefined,
      });
    }
    const segments: Segment[] = [];
    for (const s of v.segments) {
      if (s.t0 > t1 + eps) break;
      const cut = s.t1 > t1;
      const scaled: Segment = {
        ...s,
        t0: k * s.t0,
        t1: k * (cut ? t1 : s.t1),
        p1: cut ? evalSegment(s, t1) : s.p1,
      };
      // A cut segment keeps its whole curve, so the part heard has its real shape.
      const curve = s.curve ?? (cut ? { t1: s.t1, p1: s.p1 } : undefined);
      if (curve) scaled.curve = { t1: k * curve.t1, p1: curve.p1 };
      segments.push(scaled);
    }
    if (alive) {
      const p = pitchIn(v, t1);
      if (p !== null) {
        notes.push({ voice: v.index, pitch: p });
        if (hold > 0) segments.push({ t0: k * t1, t1: end, p0: p, p1: p, ease: 'linear' });
      }
    }
    // Changes up to t1 (a timbre's first entry, at 0, always).
    const before = <T extends { t: Seconds }>(xs: readonly T[] | undefined, first = false): T[] =>
      (xs ?? []).filter((x, i) => (first && i === 0) || x.t <= t1 + eps);
    const pulse = before(v.pulse).map((r) => ({ ...r, t: k * r.t, decay: k * r.decay }));
    // Held notes sound fully, not at a pulse's floor.
    if (alive && hold > 0 && pulse.length > 0)
      pulse.push({ t: k * t1, accent: 1, decay: 0, floor: 1, strike: false });
    const out: CompiledVoice = {
      ...v,
      lives,
      segments,
      timbre: before(v.timbre, true).map((c) => ({ ...c, t: k * c.t, fade: k * c.fade })),
      level: before(v.level).map((c) => ({ ...c, t: k * c.t, over: k * c.over })),
    };
    if (v.weight)
      out.weight = v.weight
        .filter((w) => w.t - (w.lead ?? 0) <= t1 + eps)
        .map((w) => ({
          ...w,
          t: k * w.t,
          over: k * w.over,
          lead: w.lead !== undefined ? k * w.lead : undefined,
        }));
    if (v.stack) out.stack = before(v.stack).map((c) => ({ ...c, t: k * c.t }));
    if (v.pulse) out.pulse = pulse;
    return out;
  });
  const keys = (score.keys ?? []).filter((c, i) => i === 0 || c.t <= t1 + eps);
  return {
    score: {
      duration: end,
      voices,
      momentSpans: [],
      walkSteps: [],
      diagnostics: [],
      keys: keys.map((c) => ({ ...c, t: k * c.t })),
      referenceHz: score.referenceHz,
      seed: score.seed,
    },
    from: k * t0,
    seconds: end - k * t0,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------------------------

const KEY = 'algorhythms.hoverSound';

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** "Hover sound" (view settings): on by default, remembered. */
export const useHoverSound = create<{ on: boolean }>()(() => ({ on: stored() }));

/** Sets and persists "Hover sound"; turning it off stops a hover sound playing. */
export function setHoverSound(on: boolean): void {
  useHoverSound.setState({ on });
  if (!on) stopHoverSound();
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, '0');
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------------------------

/** What the hover sound did (read by tests through the debug hook). */
export const hoverSoundState = {
  /** Hover sounds started so far. */
  count: 0,
  /** The latest one's plan, or null. */
  plan: null as HoverPlan | null,
  /** The latest one's moment type. */
  type: null as MomentType | null,
  /** `performance.now()` of the latest card hover or focus (its dwell's start), and of the latest start. */
  hoverAt: NaN,
  startedAt: NaN,
};

/**
 * Plays moment `id` (type `type` at `at`) from `score`, the previewed piece with it in. False if
 * the setting is off, the transport is playing, or there is nothing to hear.
 */
export function playHover(
  score: CompiledScore,
  id: MomentId,
  type: MomentType,
  at: Seconds,
): boolean {
  if (!useHoverSound.getState().on) return false;
  const plan = hoverPlan(score, id, type, at);
  const h = hoverScore(score, plan);
  if (h.notes.length === 0 && plan.mode !== 'played') return false;
  if (!(h.seconds > 0)) return false;
  const ok = playAudition(h.score, {
    notes: h.notes,
    seconds: h.seconds,
    from: h.from,
    kind: HOVER_KIND,
  });
  if (ok) {
    hoverSoundState.startedAt = performance.now();
    hoverSoundState.count++;
    hoverSoundState.plan = plan;
    hoverSoundState.type = type;
  }
  return ok;
}

/** Stops a hover sound (if one is playing) with a `STOP_FADE` fade. */
export function stopHoverSound(): void {
  if (auditionState.active && auditionState.kind === HOVER_KIND) stopAudition(STOP_FADE);
}

/** Plays the hover preview showing now (./preview.ts), if any. */
export function soundPreview(): boolean {
  const g = previewState.ghost;
  const type = previewState.type;
  if (!g || type === null || previewState.drag) return false;
  return playHover(g.score, PROBE_ID, type, g.from);
}

onPreviewEscape(stopHoverSound);
