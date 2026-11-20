/**
 * The score animation loop (PLAN.md §11.3a): one `requestAnimationFrame` loop that reads the store
 * and `currentTime()` directly, draws the canvas with `drawScore`, runs the overview and ghost
 * tweens, and writes the time readout, scrubber and key/voice status by direct DOM writes. React
 * is never on this path.
 *
 * The canvas is redrawn only while playing, tweening, or after something changed (a store update,
 * a resize, a theme change), so a paused player costs nothing.
 */

import { activeAt, keyAt } from '../core/query';
import type { CompiledScore, MomentId, Piece } from '../core/types';
import {
  cameraAt,
  cameraScore,
  drawScore,
  easeOverview,
  formatTime,
  hoverLabel,
  keyName,
  nearestLine,
  supportsOklch,
  tokensOf,
  type CameraState,
  type MomentLabels,
  type ScoreStyle,
  type View,
} from '../render';
import { live, writeText } from './dom';
import { useEditor } from './editor/history';
import { hoverPointer } from './hover';
import { currentTime, usePlayer, type PlayerState } from './store';

/** Duration of the future-ghost fade, ms (the prototype's 900). */
const GHOST_TWEEN_MS = 900;

/** Frame timings for the performance e2e (filled only while `frameStats.enabled`). */
export const frameStats = {
  enabled: false,
  /** Time spent in each frame's work (ms), newest last. */
  work: [] as number[],
  /** Interval between frames (ms), newest last. */
  interval: [] as number[],
  /** Frames that drew the canvas. */
  drawn: 0,
  /** The overview factor (0 follow .. 1 whole piece) as of the last frame. */
  overview: 1,
  reset(): void {
    this.work = [];
    this.interval = [];
    this.drawn = 0;
  },
};

interface Tween {
  value: number;
  from: number;
  to: number;
  t0: number;
}

function stepTween(tw: Tween, target: number, now: number): boolean {
  if (target !== tw.to) {
    tw.from = tw.value;
    tw.to = target;
    tw.t0 = now;
  }
  return tw.value !== tw.to;
}

function labelsOf(piece: Piece): MomentLabels {
  const out: Record<MomentId, string> = {};
  for (const m of piece.moments) if (m.label) out[m.id] = m.label;
  return out;
}

/** Geometry the pointer handlers need: the current pixels-per-second of the canvas. */
export function currentPps(canvas: HTMLCanvasElement, s: PlayerState, t: number): number {
  const cam: CameraState = {
    window: s.view.window,
    overview: 0,
    playheadX: s.piece.view.playheadX,
  };
  const size = { width: canvas.clientWidth, height: canvas.clientHeight };
  return cameraAt(cameraScore(s.compiled), cam, t, size, s.view.hud).pps;
}

/**
 * Starts the loop on `canvas`; returns a function that stops it and removes its listeners.
 * `tip`, if given, shows the hover readout of the line under the mouse.
 */
export function startScoreLoop(canvas: HTMLCanvasElement, tip?: HTMLElement | null): () => void {
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) return () => undefined;
  const oklch = supportsOklch();
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');

  let width = 0;
  let height = 0;
  let dpr = 1;
  let dirty = true;
  const overview: Tween = { value: 1, from: 1, to: 1, t0: 0 };
  const ghost: Tween = { value: 1, from: 1, to: 1, t0: 0 };
  let lastCompiled: CompiledScore | null = null;
  let lastPiece: Piece | null = null;
  let labels: MomentLabels = {};
  let lastScrub = '';
  let lastFrame = 0;
  let lastView: View | null = null;
  let lastSelection: readonly MomentId[] = [];
  let highlight: ReadonlySet<MomentId> = new Set();
  let hoverVersion = -1;
  let lastTip = '';

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    dirty = true;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const markDirty = (): void => {
    dirty = true;
  };
  const unsubscribe = usePlayer.subscribe(markDirty);
  const unsubscribeEditor = useEditor.subscribe(markDirty);
  darkQuery.addEventListener('change', markDirty);
  const themeWatcher = new MutationObserver(markDirty);
  themeWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  void document.fonts?.ready.then(markDirty);

  let raf = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const w0 = frameStats.enabled ? performance.now() : 0;
    const s = usePlayer.getState();
    const { compiled, piece, view, transport } = s;
    const reduced = reducedQuery.matches;
    const t = currentTime();
    const atRest = transport.status === 'idle' || transport.status === 'ended';

    // A new piece or score: at rest, jump to the overview instead of tweening to it.
    if (compiled !== lastCompiled) {
      if (piece !== lastPiece) labels = labelsOf(piece);
      if (transport.status === 'idle') {
        overview.value = overview.from = overview.to = 1;
        ghost.value = ghost.from = ghost.to = 1;
      }
      lastCompiled = compiled;
      lastPiece = piece;
      dirty = true;
    }

    // Tweens: overview (follow <-> whole piece) and the future ghost.
    let tweening = stepTween(overview, atRest ? 1 : 0, now);
    if (tweening) {
      overview.value = easeOverview(overview.from, overview.to, now - overview.t0, reduced);
      if (overview.value === overview.to) tweening = false;
    }
    const ghostTarget = atRest ? 1 : (piece.view.futureOpacity ?? 0);
    let ghosting = stepTween(ghost, ghostTarget, now);
    if (ghosting) {
      const k = reduced ? 1 : Math.min(1, (now - ghost.t0) / GHOST_TWEEN_MS);
      ghost.value = ghost.from + (ghost.to - ghost.from) * k;
      if (k >= 1) {
        ghost.value = ghost.to;
        ghosting = false;
      }
    }

    frameStats.overview = overview.value;

    // Direct DOM writes: time, duration, scrubber, key and voice count.
    writeText(live.time, formatTime(t));
    writeText(live.duration, formatTime(compiled.duration));
    if (live.scrub) {
      const max = String(compiled.duration);
      if (live.scrub.max !== max) live.scrub.max = max;
      if (!transport.scrubbing) {
        const v = t.toFixed(2);
        if (v !== lastScrub) {
          lastScrub = v;
          live.scrub.value = v;
        }
      }
    }
    if (live.status) {
      const active = activeAt(compiled, t).length;
      writeText(
        live.status,
        `${keyName(keyAt(compiled, t))} · ${active} / ${compiled.voices.length} voices`,
      );
    }

    const selection = useEditor.getState().selection;
    if (selection !== lastSelection) {
      lastSelection = selection;
      highlight = new Set(selection);
    }

    let drew = false;
    if (transport.status === 'playing' || tweening || ghosting || dirty) {
      dirty = false;
      if (width > 0 && height > 0) {
        const dark = view.theme === 'dark' || (view.theme === 'system' && darkQuery.matches);
        const style: ScoreStyle = {
          tokens: tokensOf(dark ? 'dark' : 'light'),
          dark,
          colors: view.colors,
          oklch,
          customColors: piece.voices.map((v) => v.color),
          futureOpacity: ghost.value,
          hud: view.hud,
          labels,
          highlight,
        };
        const cam: CameraState = {
          window: view.window,
          overview: overview.value,
          playheadX: piece.view.playheadX,
          pan: transport.status === 'playing' ? 0 : view.pan,
        };
        lastView = drawScore(g, compiled, cam, style, t, { width, height }, dpr);
        frameStats.drawn++;
        drew = true;
      }
    }

    // Hover readout: re-tested when the frame or the pointer changed.
    if (tip && (drew || hoverPointer.version !== hoverVersion)) {
      hoverVersion = hoverPointer.version;
      const hit =
        hoverPointer.on && lastView
          ? nearestLine(
              compiled,
              lastView,
              hoverPointer.x,
              hoverPointer.y,
              undefined,
              ghost.value > 0.05,
            )
          : null;
      const text = hit ? hoverLabel(compiled, hit, piece.voices[hit.voice]?.name) : '';
      if (text !== lastTip) {
        lastTip = text;
        tip.textContent = text;
        tip.hidden = text === '';
      }
      if (hit) {
        // Beside the point, flipped left near the right edge.
        const left =
          hit.x + 12 + tip.offsetWidth > width ? hit.x - 12 - tip.offsetWidth : hit.x + 12;
        tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(hit.y - 24)}px)`;
      }
    }

    if (frameStats.enabled) {
      frameStats.work.push(performance.now() - w0);
      if (lastFrame > 0) frameStats.interval.push(now - lastFrame);
    }
    lastFrame = now;
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    unsubscribe();
    unsubscribeEditor();
    darkQuery.removeEventListener('change', markDirty);
    themeWatcher.disconnect();
  };
}
