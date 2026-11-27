/**
 * The watch view (PLAN.md §15 M17 "Watch view"): the Video workspace's preview filling the
 * window (VideoWorkspace adds this over its stage), paused on the first frame with a large Play.
 * Play starts the sound and, with a mouse, real fullscreen of the stage. Controls show on hover
 * or a tap: play/pause, the seek bar, the time, fullscreen. Escape (or leaving fullscreen with the
 * browser's own key) lands in the Video workspace at the same time; the corner offers Edit video
 * and Open the music; the end screen Replay and Open the music. Rules: ../watch.ts.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { ExportForm } from '../export-options';
import { usePlayer } from '../store';
import { canFullscreen as canGoFullscreen, fullscreenChangeEvent } from '../fullscreen';
import {
  CONTROLS_IDLE_MS,
  playerTime,
  spokenTime,
  watchEnded,
  watchFirstFrame,
  watchKey,
  watchTimes,
} from '../watch';
import { FullIcon } from './FullIcon';
import { backToMusic } from './PosterWorkspace';
import {
  clockNow,
  leaveWatch,
  scrubPreview,
  togglePreview,
  useExportUi,
  type Runtime,
} from './export-state';
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenChanged,
  toggleFullscreen,
  useWatchUi,
  watchMounted,
} from './watch-fullscreen';

/** A mouse (or pen) is the main pointer: Play goes fullscreen. Phones stay in the page. */
const finePointer = (): boolean => !matchMedia('(pointer: coarse)').matches;

/** Play / Pause in the watch view (Space too); the first Play goes fullscreen with a mouse. */
export function watchPlayPause(): void {
  const playing = useExportUi.getState().previewPlaying;
  if (!playing && !useWatchUi.getState().played) {
    useWatchUi.setState({ played: true });
    if (finePointer()) enterFullscreen();
  }
  togglePreview();
}

/** Open the music: the editor, as Back to music. */
function openMusic(): void {
  exitFullscreen(false);
  backToMusic();
}

/** Edit video: the Video workspace, at the same time. */
function editVideo(): void {
  exitFullscreen(false);
  leaveWatch();
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-testid="preview-play"]')?.focus(),
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4.5v15l12.5-7.5z" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" />
  </svg>
);
export function WatchView({
  form,
  runtime,
  stage,
}: {
  form: ExportForm;
  runtime: Runtime | null;
  /** The stage (for pointer movement over the whole window). */
  stage: RefObject<HTMLElement | null>;
}) {
  const title = usePlayer((s) => s.piece.meta.title);
  const compiled = usePlayer((s) => s.compiled);
  const t = useExportUi((s) => s.previewT);
  const playing = useExportUi((s) => s.previewPlaying);
  const played = useWatchUi((s) => s.played);
  const clock = useMemo(
    () => clockNow(form),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, compiled, runtime],
  );
  const v = Math.min(Math.max(clock.from, t), clock.to);
  const { at, length } = watchTimes(v, clock);
  const ended = played && watchEnded(v, clock, playing);
  const [shown, setShown] = useState(true);
  const fullscreen = useWatchUi((s) => s.fullscreen);
  const idle = useRef(0);
  const pointer = useRef('mouse');
  // Element fullscreen, or (iPhone) iOS's own player.
  const canFullscreen = canGoFullscreen();

  // A new watch view starts unplayed, unless the workspace's fullscreen opened it.
  useEffect(watchMounted, []);

  // Until Play, the first frame: the lead-in's start is known once the engine room loads.
  useEffect(() => {
    if (useWatchUi.getState().played) return;
    useExportUi.setState({ previewT: watchFirstFrame(clock) });
  }, [clock.from]); // eslint-disable-line react-hooks/exhaustive-deps

  // Controls hide a moment after the pointer stops while playing; paused, they stay.
  const poke = (): void => {
    setShown(true);
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setShown(false), CONTROLS_IDLE_MS);
  };
  useEffect(() => {
    if (!playing) return;
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setShown(false), CONTROLS_IDLE_MS);
    return () => clearTimeout(idle.current);
  }, [playing]);

  // Leaving browser fullscreen leaves the view (its own button keeps it, unless the workspace's
  // button opened it).
  useEffect(() => {
    const ev = fullscreenChangeEvent();
    const onChange = (): void => {
      if (fullscreenChanged()) leaveWatch();
    };
    document.addEventListener(ev, onChange);
    return () => document.removeEventListener(ev, onChange);
  }, []);

  // Escape leaves, ←/→ seek, F fullscreen (Space: the shared rule, VideoWorkspace).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = watchKey({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        dialog: document.querySelector('dialog[open]') !== null,
      });
      if (!k) return;
      e.preventDefault();
      if (k.action === 'leave') editVideo();
      else if (k.action === 'fullscreen') toggleFullscreen();
      else {
        scrubPreview(useExportUi.getState().previewT + (k.by ?? 0));
        poke();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Pointer movement anywhere on the stage shows the controls.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onMove = (e: PointerEvent): void => {
      pointer.current = e.pointerType;
      if (e.pointerType === 'mouse') poke();
    };
    const onDown = (e: PointerEvent): void => {
      pointer.current = e.pointerType;
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
    };
  }, [stage]);

  const visible = shown || !playing;
  // A click on the picture plays/pauses; a tap shows (or hides) the controls.
  const onSurface = (): void => {
    if (pointer.current === 'mouse') {
      watchPlayPause();
      poke();
    } else if (visible && playing) {
      clearTimeout(idle.current);
      setShown(false);
    } else poke();
  };

  return (
    <div
      className="watch"
      data-testid="watch-view"
      data-controls={visible ? 'shown' : 'hidden'}
      data-ended={ended || undefined}
      role="group"
      aria-label={`Watch ${title}`}
    >
      <div className="watch-surface" data-testid="watch-surface" onClick={onSurface} />
      {/* Under the corner and the bar, so both stay usable at the end. */}
      {ended && (
        <div className="watch-end" role="group" aria-label="The end" data-testid="watch-end">
          <button
            type="button"
            className="primary"
            data-testid="watch-replay"
            autoFocus
            onClick={watchPlayPause}
          >
            Replay
          </button>
          <button type="button" data-testid="watch-end-music" onClick={openMusic}>
            Open the music
          </button>
        </div>
      )}
      <div className="watch-top">
        <span className="watch-title" data-testid="watch-title">
          {title}
        </span>
        <span className="watch-links">
          <button type="button" data-testid="watch-edit-video" onClick={editVideo}>
            Edit video
          </button>
          <button type="button" data-testid="watch-open-music" onClick={openMusic}>
            Open the music
          </button>
        </span>
      </div>
      {!played && (
        <button
          type="button"
          className="watch-big-play"
          data-testid="watch-big-play"
          aria-label="Play the video"
          autoFocus
          onClick={watchPlayPause}
        >
          <PlayIcon />
        </button>
      )}
      <div className="watch-bar" onPointerDown={poke} onFocus={poke}>
        <input
          type="range"
          className="watch-seek"
          data-testid="watch-seek"
          aria-label="Seek"
          aria-valuetext={`${spokenTime(at)} of ${spokenTime(length)}`}
          min={0}
          max={length || 1}
          step="any"
          value={at}
          style={{ '--at': `${length > 0 ? (at / length) * 100 : 0}%` } as CSSProperties}
          onChange={(e) => scrubPreview(clock.from + Number(e.currentTarget.value))}
        />
        <div className="watch-row">
          <button
            type="button"
            className="watch-btn"
            data-testid="watch-play"
            data-playing={playing}
            aria-label={playing ? 'Pause' : 'Play'}
            aria-keyshortcuts="Space"
            title={`${playing ? 'Pause' : 'Play'} (Space)`}
            onClick={watchPlayPause}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="watch-time" data-testid="watch-time">
            {playerTime(at)} / {playerTime(length)}
          </span>
          {canFullscreen && (
            <button
              type="button"
              className="watch-btn watch-full"
              data-testid="watch-fullscreen"
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              aria-keyshortcuts="F"
              title={`${fullscreen ? 'Exit full screen' : 'Full screen'} (F)`}
              onClick={toggleFullscreen}
            >
              <FullIcon on={fullscreen} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
