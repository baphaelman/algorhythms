/**
 * Hover info for the score view (PLAN.md §11.3 "Selection feedback"): the line nearest the
 * pointer, and its readout (voice, note name with cents, Hz). Pure; the app owns the pointer.
 */

import { spellPc } from '../core/harmony';
import { keyAt, pitchAt } from '../core/query';
import { hzOf } from '../core/tuning';
import type { CompiledScore, Key, Pitch, Seconds } from '../core/types';
import { pitchToY, timeToX, xToTime } from './camera';
import type { View } from './types';

/** Default hit radius, CSS px. */
export const HOVER_RADIUS_PX = 6;

/** A line under the pointer. */
export interface LineHit {
  /** Pool index of the voice. */
  voice: number;
  /** Time and pitch of the nearest point on the line. */
  t: Seconds;
  pitch: Pitch;
  /** Its position in CSS px, and its distance from the pointer. */
  x: number;
  y: number;
  dist: number;
}

/**
 * The line nearest (x, y) within `radius` px, or null. Each voice is probed at a few times across
 * ±radius around the pointer, so steep glides are found too. Lines later than `view.t` count only
 * when `includeFuture` (the ghost is visible).
 */
export function nearestLine(
  compiled: CompiledScore,
  view: View,
  x: number,
  y: number,
  radius = HOVER_RADIUS_PX,
  includeFuture = true,
): LineHit | null {
  if (!(view.pps > 0)) return null;
  const steps = 4;
  let best: LineHit | null = null;
  for (const v of compiled.voices) {
    if (v.segments.length === 0) continue;
    for (let k = -steps; k <= steps; k++) {
      const px = x + (radius * k) / steps;
      const t = xToTime(view, px);
      if (t < 0 || t > view.duration) continue;
      if (!includeFuture && t > view.t) continue;
      const p = pitchAt(v, t);
      if (p === null) continue;
      const py = pitchToY(view, p);
      const dist = Math.hypot(px - x, py - y);
      if (dist <= radius && (!best || dist < best.dist)) {
        best = { voice: v.index, t, pitch: p, x: timeToX(view, t), y: py, dist };
      }
    }
  }
  return best;
}

/** Note name of a pitch with the octave, e.g. "F♯4", "A4 +12¢", "B♭3 −30¢". */
export function noteLabel(p: Pitch, key?: Key): string {
  const n = Math.round(p);
  const cents = Math.round((p - n) * 100);
  const pc = ((n % 12) + 12) % 12;
  const name = key ? spellPc(pc, key) : SHARPS[pc];
  let octave = Math.floor(n / 12) - 1;
  // Enharmonic spellings across the octave line (B♯3 = C4, C♭4 = B3).
  if (pc === 0 && name.startsWith('B')) octave--;
  if (pc === 11 && name.startsWith('C')) octave++;
  if (cents === 0) return `${name}${octave}`;
  return `${name}${octave} ${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}

const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** The readout of a hit: "<voice> · <note> · <Hz> Hz", spelled in the key at the hit's time. */
export function hoverLabel(compiled: CompiledScore, hit: LineHit, voiceName?: string): string {
  const name = voiceName ?? `note ${hit.voice + 1}`;
  const note = noteLabel(hit.pitch, keyAt(compiled, hit.t));
  const hz = hzOf(hit.pitch, compiled.referenceHz).toFixed(2);
  return `${name} · ${note} · ${hz} Hz`;
}
