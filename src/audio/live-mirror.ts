/**
 * Main-thread pieces of the live engine path that need no Web Audio (PLAN.md §9), shared by
 * LiveEngine and the Node rigs: the mirror's tracks for a live setup, the view core decides on, and
 * the move records posted to the worklet.
 */

import { bezierOf, easeCodeOf } from '../core/ease';
import { flatten } from '../core/flat';
import type { LiveMove, LiveView } from '../core/live';
import type { Pitch, Seconds } from '../core/types';
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

/** The live state core decides on (`liveUpdate`), read from `tracks` at live time t. */
export function liveView(
  tracks: LiveTracks,
  voices: readonly { id: string; range: readonly [Pitch, Pitch] }[],
  t: Seconds,
): LiveView {
  return {
    voices: voices.map((v, i) => ({
      index: i,
      id: v.id,
      range: v.range,
      pitch: tracks.pitchAt(i, t),
      velocity: tracks.velocityAt(i, t),
      gliding: tracks.glidingAt(i, t),
      dest: tracks.dest(i),
    })),
    level: voices.length > 0 ? tracks.levelAt(0, t) : 0,
    levelTarget: voices.length > 0 ? tracks.levelTarget(0) : 0,
  };
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
  });
  return out;
}
