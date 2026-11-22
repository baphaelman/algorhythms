/**
 * The score animation loop (PLAN.md §11.3a): one `requestAnimationFrame` loop that reads the store
 * and `currentTime()` directly, applies the follow mode to the camera (§10), draws the canvas with
 * `drawScore`, runs the ghost tween, and writes the time readout, scrubber and key/voice status by direct DOM writes. React
 * is never on this path.
 *
 * The canvas is redrawn only while playing, tweening, or after something changed (a store update,
 * a pan, a resize, a theme change), so a paused player costs nothing.
 */

import { activeAt, keyAt } from '../core/query';
import type { CompiledScore, MomentId, Piece, Seconds } from '../core/types';
import {
  DEFAULT_FUTURE_OPACITY,
  cameraAt,
  cameraScore,
  clampStart,
  drawLiveLines,
  clampWindow,
  drawScore,
  followStart,
  formatTime,
  hoverLabel,
  keyName,
  nearestLine,
  supportsOklch,
  tokensOf,
  type CameraState,
  type MomentLabels,
  type MomentTimes,
  type ScoreStyle,
  type View,
} from '../render';
import { composeView } from './compose-view';
import { live, writeText } from './dom';
import { useEditor } from './editor/history';
import { PIANO_WIDTH } from './editor/piano';
import { hoverPointer } from './hover';
import { lineHighlight } from './line-highlight';
import { live as liveEngine } from './live';
import { LiveTrailBuffer } from './live-trail';
import { previewState, type PreviewGhost } from './preview';
import { camera, cameraOf, currentTime, usePlayer } from './store';

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
  /** The camera of the last frame: left-edge time, window (s), playhead x as a width fraction. */
  start: 0,
  window: 0,
  head: 0,
  /** Opacity of the future lines as of the last frame. */
  ghost: 1,
  /** The last drawn frame showed a moment preview's ghost lines (from this time; NaN: none). */
  preview: NaN,
  /** The whole line highlighted in the last drawn frame (`lineHighlight`; -1: none). */
  highlightVoice: -1,
  /** Live samples drawn in the last drawn frame (0: no live lines). */
  liveSamples: 0,
  /** The view of the last drawn frame (pitch ↔ y for e2e pixel checks). */
  view: null as View | null,
  reset(): void {
    this.work = [];
    this.interval = [];
    this.drawn = 0;
  },
};

/** Called every frame with the score view's camera (for DOM overlays such as the moment lane). */
export type FrameListener = (view: View, compiled: CompiledScore) => void;
const frameListeners = new Set<FrameListener>();

/** Subscribes to every frame's camera; returns the unsubscribe function. */
export function onScoreFrame(fn: FrameListener): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

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

/** Marker times: `moment.at`, so canvas markers sit where the lane puts them. */
function timesOf(piece: Piece): MomentTimes {
  const out: Record<MomentId, Seconds> = {};
  for (const m of piece.moments) out[m.id] = m.at;
  return out;
}

/** Geometry the pointer handlers need: the current pixels-per-second of the canvas. */
export function currentPps(canvas: HTMLCanvasElement): number {
  return canvas.clientWidth / cameraOf().window;
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
  const ghost: Tween = { value: 1, from: 1, to: 1, t0: 0 };
  let lastCompiled: CompiledScore | null = null;
  let lastPiece: Piece | null = null;
  let labels: MomentLabels = {};
  let markerTimes: MomentTimes = {};
  let lastScrub = '';
  let lastFrame = 0;
  let lastT = NaN;
  let lastStart = NaN;
  let lastWindow = NaN;
  let lastView: View | null = null;
  let lastSelection: readonly MomentId[] = [];
  let lastFlash: MomentId | null = null;
  let lastReveal: Seconds | undefined;
  let highlight: ReadonlySet<MomentId> = new Set();
  let lastLine = -1;
  let lineSet: ReadonlySet<number> | undefined;
  let hoverVersion = -1;
  let lastTip = '';
  let domHead = false;
  let lastPitch: [number, number] | null = null;
  let lastPreview: PreviewGhost | null = null;
  /** The editor's hovered line, for its dotted trace when silent (revision 9). */
  let traceVoice = -1;
  /** Live mode's lines (§9): sampled every frame while live, drawn over the veiled score. */
  const trail = new LiveTrailBuffer();
  let wasLive = false;

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
    const idle = transport.status === 'idle';

    // A new piece or score.
    if (piece !== lastPiece) {
      labels = labelsOf(piece);
      markerTimes = timesOf(piece);
      lastPiece = piece;
      dirty = true;
    }
    if (compiled !== lastCompiled) {
      if (idle) ghost.value = ghost.from = ghost.to = 1;
      lastCompiled = compiled;
      dirty = true;
    }

    // Camera: follow while playing or after the playhead moved (a seek); else just clamp.
    const D = compiled.duration;
    const win = clampWindow(view.window, D);
    const held = camera.hold;
    if (camera.release) camera.hold = camera.release = false;
    camera.start =
      !held && (transport.status === 'playing' || t !== lastT)
        ? followStart(view.follow, camera.start, t, win, D)
        : clampStart(camera.start, win, D);
    lastT = t;
    if (camera.start !== lastStart || win !== lastWindow) {
      lastStart = camera.start;
      lastWindow = win;
      dirty = true;
    }
    frameStats.start = camera.start;
    frameStats.window = win;
    frameStats.head = (t - camera.start) / win;

    // The future ghost: full before the first play, then dimmed.
    const ghostTarget = idle ? 1 : (piece.view.futureOpacity ?? DEFAULT_FUTURE_OPACITY);
    let ghosting = stepTween(ghost, ghostTarget, now);
    if (ghosting) {
      const k = reduced ? 1 : Math.min(1, (now - ghost.t0) / GHOST_TWEEN_MS);
      ghost.value = ghost.from + (ghost.to - ghost.from) * k;
      if (k >= 1) {
        ghost.value = ghost.to;
        ghosting = false;
      }
    }
    frameStats.ghost = ghost.value;

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
        `${keyName(keyAt(compiled, t))} · ${active} / ${compiled.voices.length} notes`,
      );
    }

    const selection = useEditor.getState().selection;
    // Compose for me: the moment a pass is editing is highlighted with the selection.
    const flash = composeView.flash;
    if (selection !== lastSelection || flash !== lastFlash) {
      lastSelection = selection;
      lastFlash = flash;
      highlight = new Set(flash ? [...selection, flash] : selection);
      dirty = true;
    }
    if (lineHighlight.voice !== lastLine) {
      lastLine = lineHighlight.voice;
      lineSet = lastLine >= 0 ? new Set([lastLine]) : undefined;
      dirty = true;
    }
    const reveal = composeView.reveal;
    if (reveal !== lastReveal) {
      lastReveal = reveal;
      dirty = true;
    }

    const cam: CameraState = { start: camera.start, window: win };
    if (camera.pitch) cam.pitchRange = camera.pitch;
    if (camera.pitch !== lastPitch) {
      lastPitch = camera.pitch;
      dirty = true;
    }
    if (frameListeners.size > 0 && width > 0 && height > 0) {
      const v = cameraAt(cameraScore(compiled), cam, t, { width, height }, view.hud);
      for (const fn of frameListeners) fn(v, compiled);
    }

    // A moment preview's ghost lines (./preview.ts).
    const preview = previewState.ghost;
    if (preview !== lastPreview) {
      lastPreview = preview;
      dirty = true;
    }

    // The editor layout's DOM playhead replaces the canvas one (§10 Drawing rules 5).
    if ((live.playhead !== null) !== domHead) {
      domHead = live.playhead !== null;
      dirty = true;
    }

    // Live: a new trail per session; while live every frame samples and redraws.
    const liveOn = liveEngine.active;
    if (liveOn !== wasLive) {
      wasLive = liveOn;
      if (liveOn) {
        const ids = liveEngine.voiceIds;
        trail.reset(
          ids.length,
          ids.map((id) =>
            Math.max(
              0,
              piece.voices.findIndex((v) => v.id === id),
            ),
          ),
        );
      }
      dirty = true;
    }
    if (liveOn && trail.sample(liveEngine)) dirty = true;

    let drew = false;
    if (transport.status === 'playing' || ghosting || dirty) {
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
          markerTimes,
          // A line pointed at from the inspector replaces the selection's highlight.
          highlight: lineSet ? undefined : highlight,
          highlightVoices: lineSet,
          playhead: !domHead,
          traces: domHead,
          traceVoice: domHead && traceVoice >= 0 ? traceVoice : undefined,
          // The bar grid in the editor layout (the one with the DOM playhead).
          bars: domHead ? { bpm: piece.view.gridBpm, meter: piece.view.meter } : undefined,
          axisInset: domHead ? PIANO_WIDTH : 0,
          preview: preview ?? undefined,
          reveal,
        };
        lastView = drawScore(g, compiled, cam, style, t, { width, height }, dpr);
        if (liveOn) drawLiveLines(g, lastView, trail, style);
        frameStats.liveSamples = liveOn ? trail.count : 0;
        frameStats.view = lastView;
        frameStats.drawn++;
        frameStats.highlightVoice = lastLine;
        frameStats.preview = preview ? preview.from : NaN;
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
              !domHead,
            )
          : null;
      // The hovered line's dotted trace (editor): redraw when it changes.
      const hv = domHead && hit ? hit.voice : -1;
      if (hv !== traceVoice) {
        traceVoice = hv;
        dirty = true;
      }
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
