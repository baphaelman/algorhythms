/**
 * Main-thread pieces of the live engine path that need no Web Audio (PLAN.md §9), shared by
 * LiveEngine and the Node rigs: the mirror's tracks for a live setup, the view core decides on, and
 * the move records posted to the worklet.
 */

import { bezierOf, easeCodeOf, EaseCode } from '../core/ease';
import {
  SEG_BX1,
  SEG_BX2,
  SEG_BY1,
  SEG_BY2,
  SEG_CURVE_P1,
  SEG_CURVE_T1,
  SEG_EASE,
  SEG_M0,
  SEG_P0,
  SEG_P1,
  SEG_STRIDE,
  SEG_T0,
  SEG_T1,
} from '../core/segment';
import { flatten } from '../core/flat';
import {
  liveUpdate,
  type LiveVoiceView,
  MERGE_WINDOW,
  type LiveMove,
  type LiveSettings,
  type LiveUpdate,
  type LiveView,
} from '../core/live';
import { hash32 } from '../core/rng';
import type { EaseRef, Pitch, Seconds, Segment } from '../core/types';
import {
  LIVE_BX1,
  LIVE_BX2,
  LIVE_BY1,
  LIVE_BY2,
  LIVE_DELAY,
  LIVE_DUR,
  LIVE_EASE,
  LIVE_P1,
  LIVE_SCALE,
  LIVE_LINE,
  LIVE_SHARE,
  LIVE_STRIDE,
  LIVE_VOICE,
  LiveTracks,
} from '../dsp/live';
import { VoiceData } from '../dsp/voice';
import { liveScore, type LiveSetup } from './live-setup';

/** The mirror's tracks for `setup`: the same records the worklet starts from. */
export function mirrorTracks(setup: LiveSetup): LiveTracks {
  const flat = flatten(liveScore(setup));
  const slots = new Int32Array(flat.timbreNames.length);
  return new LiveTracks(
    flat.voices.map((fv, i) => VoiceData.fromFlat(fv, flat.voiceParams, i, slots)),
  );
}

const EASES: readonly EaseRef[] = ['smootherstep', 'smoothstep', 'cosine', 'linear', 'expo'];

/** Voice i's segment in force at live time t, with times from t (the planner's frame). */
export function segmentAt(tracks: LiveTracks, i: number, t: Seconds): Segment {
  const d = tracks.data[i];
  const o = tracks.segmentAt(i, t) * SEG_STRIDE;
  const s = d.segs;
  const code = s[o + SEG_EASE] | 0;
  const ease: EaseRef =
    code === EaseCode.Bezier
      ? {
          kind: 'bezier',
          x1: s[o + SEG_BX1],
          y1: s[o + SEG_BY1],
          x2: s[o + SEG_BX2],
          y2: s[o + SEG_BY2],
        }
      : EASES[code];
  const seg: Segment = {
    t0: s[o + SEG_T0] - t,
    t1: s[o + SEG_T1] - t,
    p0: s[o + SEG_P0],
    p1: s[o + SEG_P1],
    ease,
  };
  const m0 = s[o + SEG_M0];
  if (m0 !== 0) seg.m0 = m0;
  if (s[o + SEG_CURVE_T1] !== s[o + SEG_T1] || s[o + SEG_CURVE_P1] !== s[o + SEG_P1]) {
    seg.curve = { t1: s[o + SEG_CURVE_T1] - t, p1: s[o + SEG_CURVE_P1] };
  }
  return seg;
}

/**
 * A voice's view after a new change cancels its moves not started yet (as a moment cancels the
 * lines' pending moves in the compiler): the segment in force with its full curve, and its end as
 * the committed destination. `pending`: it had such moves.
 */
function uncut(v: LiveVoiceView & { seg: Segment }): LiveVoiceView {
  const c = v.seg.curve;
  const seg = c ? { ...v.seg, t1: c.t1, p1: c.p1 } : v.seg;
  if (c) delete seg.curve;
  return { ...v, seg, dest: seg.p1, pending: c !== undefined };
}

/** The live state core decides on (`liveUpdate`), read from `tracks` at live time t. */
export function liveView(
  tracks: LiveTracks,
  voices: readonly { id: string; range: readonly [Pitch, Pitch] }[],
  t: Seconds,
): LiveView {
  return {
    voices: voices.map((v, i) =>
      uncut({
        index: i,
        id: v.id,
        range: v.range,
        pitch: tracks.pitchAt(i, t),
        velocity: tracks.velocityAt(i, t),
        gliding: tracks.glidingAt(i, t),
        dest: NaN,
        seg: segmentAt(tracks, i, t),
        line: tracks.lineAt(i, t),
      }),
    ),
    level: voices.length > 0 ? tracks.levelAt(0, t) : 0,
    levelTarget: voices.length > 0 ? tracks.levelTarget(0) : 0,
  };
}

/** A press (§9 merge window): its first change, the state it was decided on, and when. */
export interface LivePress {
  /** Seq its first change was posted with. */
  seq: number;
  /** Call time of its first change (s, any clock). */
  at: Seconds;
  view: LiveView;
  /** Live time it was decided at. */
  t: Seconds;
}

/** What a change of H decides (LiveEngine, the Node rig). */
export interface LiveDecision {
  update: LiveUpdate;
  /** Decision time (a re-planned press: its first change's). */
  t: Seconds;
  /** The press it re-plans (its first seq), or 0 for a new change. */
  press: number;
  seed: number;
  /** The current press after this change (null: none). */
  next: LivePress | null;
}

/**
 * The decision for held set `held` at call time `at` (s): within MERGE_WINDOW of `press`'s first
 * change, with notes held, the press re-planned on the state its first change saw; otherwise a
 * new change on `tracks` at live time t, which starts a press when notes are held. `nextSeq` is
 * the seq it would be posted with; seeds are hash32(baseSeed, the press's first seq).
 */
export function decideLive(
  press: LivePress | null,
  tracks: LiveTracks,
  voices: readonly { id: string; range: readonly [Pitch, Pitch] }[],
  held: readonly Pitch[],
  settings: Readonly<LiveSettings>,
  baseSeed: number,
  nextSeq: number,
  at: Seconds,
  t: Seconds,
): LiveDecision {
  if (press && held.length > 0 && at - press.at <= MERGE_WINDOW) {
    const seed = hash32(baseSeed, press.seq);
    const update = liveUpdate(press.view, held, settings, seed);
    return { update, t: press.t, press: press.seq, seed, next: press };
  }
  const view = liveView(tracks, voices, t);
  const seed = hash32(baseSeed, nextSeq);
  const update = liveUpdate(view, held, settings, seed);
  const next = held.length > 0 ? { seq: nextSeq, at, view, t } : null;
  return { update, t, press: 0, seed, next };
}

/** Live moves as LIVE_STRIDE records (dsp/live.ts); at least one record long. */
export function encodeMoves(moves: readonly LiveMove[]): Float64Array<ArrayBuffer> {
  const out = new Float64Array(Math.max(1, moves.length) * LIVE_STRIDE);
  moves.forEach((m, i) => {
    const o = i * LIVE_STRIDE;
    const bz = bezierOf(m.ease);
    out[o + LIVE_VOICE] = m.voice;
    out[o + LIVE_DELAY] = m.delay;
    out[o + LIVE_DUR] = m.dur;
    out[o + LIVE_P1] = m.p1;
    out[o + LIVE_EASE] = easeCodeOf(m.ease);
    out[o + LIVE_BX1] = bz.x1;
    out[o + LIVE_BY1] = bz.y1;
    out[o + LIVE_BX2] = bz.x2;
    out[o + LIVE_BY2] = bz.y2;
    out[o + LIVE_SCALE] = m.scale;
    out[o + LIVE_SHARE] = m.share;
    out[o + LIVE_LINE] = m.line ?? m.voice;
  });
  return out;
}
