/**
 * The live video preview (PLAN.md §12 "Preview and layout", §15 M15 "Panels"): the video frame
 * at the preview's time, drawn by the export's own code (`export-run` preview functions) to fit
 * its box, redrawn at most once per animation frame on any change; Play / Pause and a time
 * slider under it. Playing runs the section through the app's player, the lead-in and end card
 * silently. A component of its own so the editor's piece panel (M16) can show it too.
 *
 * In Keys, dragging the frame pans the selected key's view and the wheel zooms it
 * (`useKeyView`); the HUD readouts drag on it.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../../render/hud';
import { videoSize } from '../../render/video';
import { bookendsOf, type ExportForm } from '../export-options';
import { previewFit } from '../video-timeline';
import { currentTime, pause, play, seekTo, usePlayer } from '../store';
import { useKeyView } from './CameraKeys';
import { HudOverlay } from './ExportFields';
import {
  cameraCtl,
  clockNow,
  pausePreview,
  previewStats,
  quiet,
  silentNow,
  togglePreview,
  useExportUi,
  videoContext,
  type Runtime,
} from './export-state';

/** Follows the player while the preview plays; stops it at the section's end (or a card's). */
function usePreviewClock(playing: boolean): void {
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const c = clockNow();
      if (quiet.now) {
        // The lead-in or end card: a wall clock; the music starts at the section's start.
        const v = silentNow(quiet.now);
        if (v >= c.to) {
          quiet.now = null;
          useExportUi.setState({ previewPlaying: false, previewT: c.to });
          return;
        }
        if (quiet.now.v < c.span.start && v >= c.span.start) {
          quiet.now = null;
          seekTo(c.span.start);
          play();
          useExportUi.setState({ previewT: c.span.start });
        } else useExportUi.setState({ previewT: v });
        raf = requestAnimationFrame(tick);
        return;
      }
      const now = currentTime();
      const span = c.span;
      if (usePlayer.getState().transport.status !== 'playing') {
        useExportUi.setState({ previewPlaying: false, previewT: now });
        return;
      }
      // Only the section plays: stop at its end (or if the player left it, e.g. a loop's wrap);
      // an end card (or ring-out) after it runs on silently.
      if (now >= span.end - 1e-3 || now < span.start - 0.05) {
        pause();
        const at = Math.min(Math.max(now, span.start), span.end);
        if (now >= span.end - 1e-3 && c.to > span.end + 0.05) {
          quiet.now = { v: at, at: performance.now() };
          useExportUi.setState({ previewT: at });
          raf = requestAnimationFrame(tick);
          return;
        }
        useExportUi.setState({ previewPlaying: false, previewT: at });
        return;
      }
      if (useExportUi.getState().previewT !== now) useExportUi.setState({ previewT: now });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

/** Moves the preview to clock time x; while playing, the music follows (cards run silently). */
export function scrubPreview(x: number): void {
  const c = clockNow();
  const v = Math.min(Math.max(x, c.from), c.to);
  useExportUi.setState({ previewT: v });
  if (!useExportUi.getState().previewPlaying) return;
  const span = c.span;
  if (v >= span.start && v < span.end - 0.05) {
    if (quiet.now) {
      quiet.now = null;
      seekTo(v);
      play();
    } else seekTo(v);
  } else {
    if (!quiet.now) pause();
    quiet.now = { v, at: performance.now() };
  }
}

export function VideoPreview({
  form,
  runtime,
  disabled = false,
  keys = form.videoCamera === 'keys',
}: {
  form: ExportForm;
  runtime: Runtime | null;
  /** An export is running: the controls rest. */
  disabled?: boolean;
  /** Keys: the frame shapes the selected key's view. */
  keys?: boolean;
}) {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  // The app's theme and line colours feed 'Current' and 'As in the app'.
  const appView = usePlayer((s) => `${s.view.theme} ${s.view.colors}`);
  const t = useExportUi((s) => s.previewT);
  const playing = useExportUi((s) => s.previewPlaying);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  const draws = useRef(0);
  const frame = useRef(0);
  const job = useRef<(() => void) | null>(null);
  const id = useId();
  useKeyView(stage, cameraCtl, keys && !disabled);
  usePreviewClock(playing);
  // Leaving stops the preview.
  useEffect(() => () => pausePreview(), []);

  // The box the frame may fill. State changes only when a number does.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      previewStats.measures++;
      const w = el.clientWidth;
      const h = el.clientHeight;
      setAvail((a) => (a.w === w && a.h === h ? a : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const px = videoSize(form.videoAspect, form.videoSize);
  const fit = previewFit(avail, px.width / px.height);
  const dpr = Math.min(2, devicePixelRatio || 1);
  const pxW = Math.round(fit.w * dpr);
  const pxH = Math.max(1, Math.round((px.height * pxW) / px.width));
  // The video's clock: the section, less the lead-in before it, plus the end card after it.
  const clock = useMemo(
    () => clockNow(form),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, compiled, runtime],
  );
  const v = Math.min(Math.max(clock.from, t), clock.to);
  const span = clock.span;
  const time = Math.min(Math.max(span.start, v), span.end);
  const bookends = bookendsOf(form, piece) !== undefined;
  const shown = bookends ? v - clock.from : v;

  useEffect(() => {
    if (!runtime || avail.w === 0) return;
    // The latest change replaces the pending draw's job; the frame already asked for stays (a
    // change every frame, as while playing, must not keep pushing the draw back).
    job.current = () => {
      const c = canvas.current;
      const g = c?.getContext('2d');
      if (!c || !g) return;
      if (c.width !== pxW) c.width = pxW;
      if (c.height !== pxH) c.height = pxH;
      const t0 = performance.now();
      const place = runtime.previewVideo(
        g,
        { piece, compiled },
        form,
        videoContext(),
        v,
        pxW / px.width,
      );
      const prev = useExportUi.getState().hudPlace;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(place)) {
        useExportUi.setState({ hudPlace: place });
      }
      previewStats.lastMs = performance.now() - t0;
      previewStats.maxMs = Math.max(previewStats.maxMs, previewStats.lastMs);
      draws.current++;
      previewStats.draws++;
      c.dataset.draws = String(draws.current);
    };
    if (frame.current === 0) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const run = job.current;
        job.current = null;
        run?.();
      });
    }
  }, [runtime, piece, compiled, form, v, pxW, pxH, px.width, appView, avail.w]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  const what = `Preview of the video frame at ${formatTime(shown)}, ${form.videoAspect}`;

  return (
    <div className="export-preview video-preview" data-testid="export-preview">
      <div className="preview-box" ref={box}>
        <div
          ref={stage}
          className={keys ? 'preview-stage keys' : 'preview-stage'}
          style={{ width: `${fit.w}px`, height: `${fit.h}px` }}
        >
          <canvas
            ref={canvas}
            role="img"
            aria-label={what}
            data-testid="preview-canvas"
            data-t={time.toFixed(3)}
            data-tau={bookends ? shown.toFixed(3) : undefined}
            style={{ width: `${fit.w}px`, height: `${fit.h}px` }}
          />
          <HudOverlay form={form} kind="video" disabled={disabled} />
        </div>
      </div>
      <div className="field-row preview-time">
        <button
          type="button"
          className="preview-play"
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          aria-keyshortcuts="Space"
          title={`${playing ? 'Pause' : 'Play'} preview (Space)`}
          disabled={disabled}
          data-testid="preview-play"
          data-playing={playing}
          onClick={togglePreview}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <label htmlFor={`${id}-t`} className="visually-hidden">
          Preview time
        </label>
        <span className="preview-track">
          <input
            id={`${id}-t`}
            type="range"
            min={clock.from}
            max={Math.max(clock.from + 0.1, clock.to)}
            step={0.1}
            value={v}
            aria-valuetext={formatTime(shown)}
            data-testid="preview-time"
            onChange={(e) => scrubPreview(Number(e.target.value))}
          />
        </span>
        <output htmlFor={`${id}-t`} data-testid="preview-time-value">
          {formatTime(shown)}
        </output>
      </div>
    </div>
  );
}
