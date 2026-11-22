/**
 * Live lines (PLAN.md §9, §10): while live, the live voices' recent pitches drawn over the score
 * as trails that end at the playhead and flow left at the score's pixels per second, with a dot
 * at each sounding voice's head. The piece's own lines are veiled behind them. The app samples the
 * live voices once per frame into a ring (`LiveTrail`); drawing is one path per voice and level
 * band, no allocation.
 */

import { pitchToY } from './camera';
import { HIGHLIGHT_WIDTH } from './draw';
import { lineColor, pitchColor, type PaletteInput } from './palettes';
import type { View } from './types';

/** Samples of the live voices, newest last, in a ring. */
export interface LiveTrail {
  /** Ring capacity (samples per voice). */
  cap: number;
  /** Samples held (≤ cap) and the index of the next write. */
  count: number;
  next: number;
  /** Voices sampled. */
  voices: number;
  /** Sample times (live seconds), by ring slot. */
  times: Float64Array;
  /** Pitch and level per slot × voice (slot · voices + voice). */
  pitch: Float32Array;
  level: Float32Array;
  /** Live time at the playhead (the newest sample's time, or later). */
  now: number;
  /** Line colour index per live voice (the piece's voice index). */
  colorIndex: readonly number[];
}

/** Opacity of the veil over the piece's lines while live. */
export const LIVE_VEIL = 0.6;
/** Below this level a live voice is silent (not drawn). */
export const LIVE_SILENT = 0.02;
const BANDS = 4;
const DOT_R = 3.5;

/** Draws the veil and the live lines. The context is set to CSS pixels (as `drawScore` leaves it). */
export function drawLiveLines(
  g: CanvasRenderingContext2D,
  view: View,
  trail: LiveTrail,
  style: PaletteInput & { axisInset?: number },
): void {
  const inset = style.axisInset ?? 0;
  g.globalAlpha = LIVE_VEIL;
  g.fillStyle = style.tokens.paper;
  g.fillRect(inset, 0, view.width - inset, view.height);
  g.globalAlpha = 1;
  if (trail.count === 0) return;
  const { cap, count, voices, times, pitch, level, now } = trail;
  const xHead = view.xHead;
  const pps = view.pps;
  const span = pitchSpan(view);
  g.lineWidth = HIGHLIGHT_WIDTH;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const oldest = (trail.next - count + cap) % cap;
  const last = (trail.next - 1 + cap) % cap;
  // The first sample right of the axis (shared by every voice).
  const tMin = now - (xHead - inset) / pps;
  let k0 = 0;
  while (k0 < count - 1 && times[(oldest + k0 + 1) % cap] < tMin) k0++;
  for (let v = 0; v < voices; v++) {
    const head = pitch[last * voices + v];
    const color =
      lineColor(style, trail.colorIndex[v] ?? v) ??
      pitchColor((head - view.pLo) / span, style.dark, style.oklch);
    g.strokeStyle = color;
    // One path per run at one level band (a fade is drawn lighter in steps).
    let band = 0;
    let lastX = -1e9;
    for (let k = k0; k < count; k++) {
      const slot = (oldest + k) % cap;
      const o = slot * voices + v;
      const lv = level[o];
      const b = lv < LIVE_SILENT ? 0 : Math.min(BANDS, Math.ceil(lv * BANDS));
      if (b === 0) {
        if (band > 0) g.stroke();
        band = 0;
        continue;
      }
      const x = xHead - (now - times[slot]) * pps;
      const y = pitchToY(view, pitch[o]);
      if (band === 0) {
        g.globalAlpha = b / BANDS;
        g.beginPath();
        g.moveTo(x, y);
        band = b;
        lastX = x;
      } else if (b !== band) {
        g.lineTo(x, y);
        g.stroke();
        g.globalAlpha = b / BANDS;
        g.beginPath();
        g.moveTo(x, y);
        band = b;
        lastX = x;
      } else if (x - lastX >= 1 || k === count - 1) {
        g.lineTo(x, y);
        lastX = x;
      }
    }
    if (band > 0) g.stroke();
    // The head: where the voice sounds now.
    const lv = level[last * voices + v];
    if (lv >= LIVE_SILENT) {
      const y = pitchToY(view, head);
      g.globalAlpha = Math.min(1, lv);
      g.fillStyle = color;
      g.beginPath();
      g.arc(xHead, y, DOT_R, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

function pitchSpan(view: View): number {
  const d = view.pHi - view.pLo;
  return d > 0 ? d : 1;
}
