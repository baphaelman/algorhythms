/**
 * The `pulse` moment (PLAN.md §6.2, revision 9): the reference envelope and the step rules.
 *
 * **Envelope** (what the DSP reproduces, render's opacity and MIDI CC11 read). A voice's pulse
 * records (`CompiledVoice.pulse`, flat: `FlatVoice.pulses`) are sorted by t; at time t the record
 * in force is the last one with record.t ≤ t (ties: the later in the array). Then
 *
 *   gain = pulseEnvelope(accent, floor, decay, t − record.t)        (core/segment.ts)
 *        = accent · (floor + (1 − floor) · (1 − u)³),  u = (t − record.t) / decay,
 *        = accent · floor  once u ≥ 1 (or decay = 0),
 *
 * and 1 before the first record. A hit jumps to its accent and falls to floor × accent; the
 * voice then sits there until its next record. Boundaries (`hit` absent: accent 1, decay 0) put
 * a voice at `floor` when it joins a pulse and back at 1 (floor 1) when the pulse ends. The gain
 * multiplies the level timeline and the life fades; it is not part of `VoiceDef.gain`.
 *
 * **Steps** (compile.ts `onPulseTick`). Step k is at `at + k·step` while < until; its accent is
 * pattern[k mod length], clamped to 0..1, and 0 is a rest (nothing is hit; the walk does not
 * advance). The targeted voices are resolved at each step as for any moment; the sounding ones
 * are ordered by their pitch at that instant (ties: pool index). `together` hits them all;
 * `up`, `down` and `updown` hit one, walking that order (`nextPulseIndex`); `random` draws one
 * from the moment's seed and the step index.
 */

import type { CompiledVoice, PulseMode, Seconds } from './types';
import { pulseEnvelope } from './segment';

/** Index of the pulse record in force at t (the last with record.t ≤ t), or −1. */
export function pulseIndexAt(voice: CompiledVoice, t: Seconds): number {
  const r = voice.pulse;
  if (!r) return -1;
  let lo = 0;
  let hi = r.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (r[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The pulse gain of a voice at t (see the module comment): 1 outside any pulse. O(log n). */
export function pulseGainAt(voice: CompiledVoice, t: Seconds): number {
  const i = pulseIndexAt(voice, t);
  if (i < 0) return 1;
  const r = voice.pulse![i];
  return pulseEnvelope(r.accent, r.floor, r.decay, t - r.t);
}

/**
 * Times where a voice's pulse gain changes shape: every record's time, and the end of each
 * decay that is not cut by the next record. Sorted; empty without pulse records.
 */
export function pulseBreaks(voice: CompiledVoice): Seconds[] {
  const r = voice.pulse ?? [];
  const out: Seconds[] = [];
  for (let i = 0; i < r.length; i++) {
    out.push(r[i].t);
    const end = r[i].t + r[i].decay;
    if (r[i].decay > 0 && (i + 1 >= r.length || end < r[i + 1].t)) out.push(end);
  }
  return out;
}

/** Walk position of an arpeggio mode (`up`, `down`, `updown`). */
export interface PulseWalk {
  /** Index into the pitch-ordered voices last hit; −1 before the first hit. */
  index: number;
  /** updown: +1 rising, −1 falling. */
  dir: number;
}

/**
 * The next voice to hit among `n` pitch-ordered voices (n ≥ 1), from the last position. The
 * walk keeps its index when voices join or leave (clamped to the new count), so a chord that
 * grows or thins mid-pulse continues from where it was. `up` wraps 0 → n−1 → 0; `down` the
 * reverse; `updown` bounces without repeating the ends (0 1 2 1 0 1 …).
 */
export function nextPulseIndex(mode: PulseMode, n: number, last: PulseWalk): PulseWalk {
  if (n <= 1) return { index: 0, dir: last.dir };
  const i = last.index;
  switch (mode) {
    case 'down':
      return { index: i < 0 || i - 1 < 0 ? n - 1 : Math.min(i, n) - 1, dir: -1 };
    case 'updown': {
      if (i < 0) return { index: 0, dir: 1 };
      const cur = Math.min(i, n - 1);
      let dir = last.dir >= 0 ? 1 : -1;
      let next = cur + dir;
      if (next >= n || next < 0) {
        dir = -dir;
        next = cur + dir;
      }
      return { index: next, dir };
    }
    default: // 'up'
      return { index: i < 0 || i + 1 >= n ? 0 : i + 1, dir: 1 };
  }
}
