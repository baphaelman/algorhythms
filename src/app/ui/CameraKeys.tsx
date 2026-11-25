/**
 * The video's Camera (PLAN.md §15 M11.5 C3, M15): Follow, Auto, Keys (and Whole piece). Follow,
 * Auto and Keys write the piece's camera mode, one undo entry each; Edit copies Auto's keys into
 * the piece. In Keys, markers on the preview's timeline select, move (drag, arrow keys) and
 * delete keys; with a key selected, dragging the preview pans its view and scrolling zooms it
 * (Shift: the pitch range), one undo entry per gesture. Over the poster (M15) edits the piece's
 * poster keys (frames in poster space) the same way.
 */

import { useEffect, useId, useRef, type RefObject } from 'react';
import { create } from 'zustand';
import type { CameraKey, CameraMode, Piece, PosterCameraKey } from '../../core/types';
import { pieceVideoFrame } from '../../render/poster-video';
import { formatTime } from '../../render/hud';
import { keyOfCamera } from '../../render/camera-path';
import type { VideoCameraMode } from '../../render/video';
import { VIDEO_CAMERAS } from '../export-options';
import {
  addKey,
  deleteKey,
  keyNear,
  keyStep,
  keysOf,
  moveKey,
  panKey,
  panPosterKey,
  posterKeysOf,
  updateKey,
  withCameraKeys,
  withPosterKeys,
  withCameraMode,
  zoomKey,
  zoomPosterKey,
} from '../editor/camera-keys';
import { beginGesture, currentGesture, edit, endGesture, updateGesture } from '../editor/history';
import { usePlayer } from '../store';
import { Radios } from './export-controls';

/** A camera as a key sees it (`keyOfCamera`). */
export interface ViewCamera {
  start: number;
  window: number;
  pitchRange: [number, number];
}

/** What the camera controls need from the dialog. */
export interface CameraCtl {
  /** The preview's score time. */
  time(): number;
  /** Moves the preview to score time t (pausing it). */
  seek(t: number): void;
  /** The camera the preview shows at t, or null before the engine room loads. */
  cameraAt(t: number): ViewCamera | null;
  /** The video's width / height (a key's window is seconds at 16:9 of the same height). */
  aspect(): number;
  /** Auto's keys for this video (its section and aspect), or null before the engine room loads. */
  autoKeys(): readonly CameraKey[] | null;
  /** Sets the form's Camera. */
  setChoice(mode: VideoCameraMode): void;
  /**
   * Over the poster (M15): a key from the frame the preview shows at t, and the artboard's and
   * the video's width / height; null before the engine room loads.
   */
  posterKeyAt(t: number): PosterCameraKey | null;
  posterAspects(): { art: number; video: number } | null;
}

/** A key of either frame (One row's `CameraKey`, Over the poster's `PosterCameraKey`). */
type AnyKey = CameraKey | PosterCameraKey;

/** How a frame's keys are read, written and shaped (M15: One row or Over the poster). */
interface Track {
  of(p: Pick<Piece, 'camera'>): readonly AnyKey[];
  with(p: Piece, keys: readonly AnyKey[]): Piece;
  /** A key from the view the preview shows at t. */
  fromView(ctl: CameraCtl, t: number): AnyKey | null;
  /** ↑ ↓: the view up or down by `d` steps. */
  nudge(k: AnyKey, d: number): AnyKey;
  zoom(k: AnyKey, f: number, range: boolean): AnyKey;
  /** Dragged by (dx, dy), fractions of the frame. */
  pan(ctl: CameraCtl, k: AnyKey, dx: number, dy: number): AnyKey;
}

const ROW: Track = {
  of: keysOf,
  with: (p, keys) => withCameraKeys(p, keys as CameraKey[]),
  fromView: (ctl, t) => {
    const cam = ctl.cameraAt(t);
    return cam ? keyOfCamera(cam, t, undefined, ctl.aspect()) : null;
  },
  nudge: (k, d) => ({ ...(k as CameraKey), pitch: (k as CameraKey).pitch + d }),
  zoom: (k, f, range) => zoomKey(k as CameraKey, f, range ? 'range' : 'window'),
  pan: (_ctl, k, dx, dy) => panKey(k as CameraKey, dx, dy),
};

/** One step of ↑ ↓ on the poster, a fraction of the frame's height. */
const POSTER_NUDGE = 0.05;

const POSTER: Track = {
  of: posterKeysOf,
  with: (p, keys) => withPosterKeys(p, keys as PosterCameraKey[]),
  fromView: (ctl, t) => ctl.posterKeyAt(t),
  nudge: (k, d) => {
    const pk = k as PosterCameraKey;
    return { ...pk, y: pk.y - d * POSTER_NUDGE * pk.h };
  },
  // The range (Shift) has no meaning on the poster: both zoom the frame.
  zoom: (k, f) => zoomPosterKey(k as PosterCameraKey, f),
  pan: (ctl, k, dx, dy) => {
    const a = ctl.posterAspects();
    return a ? panPosterKey(k as PosterCameraKey, dx, dy, a.art, a.video) : k;
  },
};

/** The keys the piece's video frame uses. */
const trackOf = (p: Pick<Piece, 'camera' | 'poster'>): Track =>
  pieceVideoFrame(p) === 'poster' ? POSTER : ROW;

const track = () => trackOf(usePlayer.getState().piece);

/** The selected key's index (in the piece's keys), or null. */
export const useCameraKeys = create<{ selected: number | null }>()(() => ({ selected: null }));

const select = (i: number | null) => useCameraKeys.setState({ selected: i });

/** The selected index if it still names a key. */
function selectedIn(keys: readonly AnyKey[]): number | null {
  const i = useCameraKeys.getState().selected;
  return i !== null && i < keys.length ? i : null;
}

const pieceKeys = () => track().of(usePlayer.getState().piece);

/** Wheel zooms within this pause of each other are one undo entry, ms. */
const WHEEL_GESTURE_MS = 400;

/**
 * Keys mode's keys: the piece's own (`fresh`: Auto's instead), else Auto's, else one key from
 * the view the preview shows now.
 */
function startKeys(ctl: CameraCtl, fresh: boolean): readonly AnyKey[] {
  const tr = track();
  const own = tr.of(usePlayer.getState().piece);
  if (!fresh && own.length > 0) return own;
  // Auto's keys are One row's.
  const auto = tr === ROW ? ctl.autoKeys() : null;
  if (auto && auto.length > 0) return auto;
  const k = tr.fromView(ctl, ctl.time());
  return k ? [k] : own;
}

/** Choosing a Camera: Follow, Auto and Keys write the piece; Whole piece is the dialog's. */
function choose(ctl: CameraCtl, mode: VideoCameraMode): void {
  if (mode === 'whole') {
    ctl.setChoice('whole');
    return;
  }
  const m: CameraMode = mode;
  if (m === 'keys') {
    // The seed key is the view shown before switching.
    const keys = startKeys(ctl, false);
    const tr = track();
    edit(
      (p) =>
        keys.length === 0 || (p.camera?.mode === 'keys' && tr.of(p) === keys)
          ? withCameraMode(p, 'keys')
          : tr.with(p, keys),
      'Camera',
    );
    select(null);
  } else edit((p) => withCameraMode(p, m), 'Camera');
  ctl.setChoice(m);
}

/** Over the poster's cameras (M15): Auto plays as Follow there, so it isn't offered. */
const POSTER_CAMERAS = VIDEO_CAMERAS.filter((c) => c.id !== 'auto').map((c) =>
  c.id === 'follow'
    ? { ...c, hint: 'Follows the playhead row by row; Window sets how much it shows.' }
    : c.id === 'whole'
      ? { ...c, label: 'Whole', hint: 'The whole poster in frame.' }
      : c,
);

/** The Camera group, its hint, and Edit (Auto). */
export function CameraField({
  value: chosen,
  poster = false,
  disabled,
  ctl,
}: {
  value: VideoCameraMode;
  /** Over the poster (M15): Follow, Whole and Keys in poster space. */
  poster?: boolean;
  disabled: boolean;
  ctl: CameraCtl;
}) {
  const id = useId();
  const options = poster ? POSTER_CAMERAS : VIDEO_CAMERAS;
  const value = poster && chosen === 'auto' ? 'follow' : chosen;
  const hint = options.find((c) => c.id === value)?.hint;
  return (
    <>
      <Radios
        legend="Camera"
        name={`${id}-camera`}
        value={value}
        options={options}
        disabled={disabled}
        testId="export-camera"
        onChange={(mode) => choose(ctl, mode)}
      />
      <div className="field-row camera-hint">
        <small className="export-hint">{hint}</small>
        {value === 'auto' && (
          <button
            type="button"
            disabled={disabled}
            title="Copy the auto camera into keys you can change"
            data-testid="camera-edit"
            onClick={() => {
              const keys = startKeys(ctl, true);
              edit((p) => track().with(p, keys), 'Edit camera');
              select(null);
              ctl.setChoice('keys');
            }}
          >
            Edit
          </button>
        )}
      </div>
    </>
  );
}

/** Keys selected key, as an edit of its own: `fn` on the key. */
function editSelected(fn: (k: AnyKey) => AnyKey, label: string): void {
  const i = selectedIn(pieceKeys());
  if (i === null) return;
  const tr = track();
  edit((p) => tr.with(p, updateKey(tr.of(p), i, fn)), label);
}

/** Focuses key marker i after the next render (or `fallback` when there is none). */
function focusMarker(root: HTMLElement | null, i: number, fallback?: string): void {
  requestAnimationFrame(() => {
    const el =
      root?.querySelector<HTMLElement>(`[data-key-index="${i}"]`) ??
      (fallback
        ? root?.closest('.export-preview, .video-timeline')?.querySelector<HTMLElement>(fallback)
        : null);
    el?.focus();
  });
}

/**
 * The key markers on the preview's timeline (`from`..`to`, the slider's range; keys outside it
 * aren't shown), placed in the slider's wrapper. Click selects (and moves the preview there); drag moves in time; focused:
 * arrows move, ↑ ↓ move the pitch, − = zoom, Delete removes.
 */
export function KeyMarkers({
  from,
  to,
  disabled,
  ctl,
}: {
  from: number;
  to: number;
  disabled: boolean;
  ctl: CameraCtl;
}) {
  const keys = usePlayer((s) => trackOf(s.piece).of(s.piece));
  const picked = useCameraKeys((s) => s.selected);
  const lane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; id: number } | null>(null);
  const id = useId();
  const span = Math.max(1e-6, to - from);
  const pct = (t: number) => `${(Math.min(1, Math.max(0, (t - from) / span)) * 100).toFixed(3)}%`;
  const timeAt = (clientX: number): number => {
    const r = lane.current?.getBoundingClientRect();
    if (!r || r.width === 0) return from;
    return from + (Math.min(Math.max(clientX - r.left, 0), r.width) / r.width) * span;
  };

  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (disabled) return;
    const k = keys[i];
    if (!k) return;
    const step = keyStep(e.key, { shift: e.shiftKey, alt: e.altKey });
    let done = true;
    if (step !== null) {
      // Kept on this timeline, so the focused marker stays.
      const at = Math.min(Math.max(k.at + step, from), to);
      const next = moveKey(keys, i, at);
      const tr = track();
      edit((p) => tr.with(p, moveKey(tr.of(p), i, at)), 'Move camera key');
      select(i);
      ctl.seek(next[i].at);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      select(i);
      const tr = track();
      editSelected((x) => tr.nudge(x, d), 'Camera view');
    } else if (e.key === '-' || e.key === '=' || e.key === '+') {
      select(i);
      const tr = track();
      editSelected((x) => tr.zoom(x, e.key === '-' ? 1.25 : 0.8, false), 'Camera zoom');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const tr = track();
      edit((p) => tr.with(p, deleteKey(tr.of(p), i)), 'Delete camera key');
      const left = keys.length - 1;
      const next = left === 0 ? -1 : Math.min(i, left - 1);
      select(next >= 0 ? next : null);
      focusMarker(lane.current, next, '[data-testid="camera-key-add"]');
    } else done = false;
    if (done) e.preventDefault();
  };

  return (
    <div className="camera-key-track" ref={lane} data-testid="camera-keys">
      <small className="visually-hidden" id={`${id}-k`}>
        Arrow keys move it in time (Shift ten seconds, Alt a tenth); up and down move the view;
        minus and equals zoom; Delete removes it.
      </small>
      {keys.map((k, i) =>
        // Keys outside the section aren't on this timeline (they'd pile up at its ends).
        k.at < from - 1e-6 || k.at > to + 1e-6 ? null : (
          <button
            key={i}
            type="button"
            className={picked === i ? 'camera-key on' : 'camera-key'}
            aria-label={`Camera key at ${formatTime(k.at)}`}
            aria-pressed={picked === i}
            aria-describedby={`${id}-k`}
            title={formatTime(k.at)}
            disabled={disabled}
            data-testid="camera-key"
            data-key-index={i}
            data-at={k.at.toFixed(3)}
            style={{ left: pct(k.at) }}
            onClick={() => {
              select(i);
              ctl.seek(k.at);
            }}
            onKeyDown={(e) => onKey(e, i)}
            onPointerDown={(e) => {
              if (disabled || e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { i, id: e.pointerId };
              select(i);
              ctl.seek(k.at);
              beginGesture('Move camera key');
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              const t = timeAt(e.clientX);
              const tr = track();
              updateGesture((p) => tr.with(p, moveKey(tr.of(p), d.i, t)));
              const at = pieceKeys()[d.i]?.at;
              if (at !== undefined) ctl.seek(at);
            }}
            onPointerUp={() => {
              if (!drag.current) return;
              drag.current = null;
              endGesture();
            }}
            onPointerCancel={() => {
              if (!drag.current) return;
              drag.current = null;
              endGesture();
            }}
          />
        ),
      )}
    </div>
  );
}

/** Add (a key at the preview's time, from the view it shows) and Delete (the selected key). */
export function KeyButtons({ disabled, ctl }: { disabled: boolean; ctl: CameraCtl }) {
  const keys = usePlayer((s) => trackOf(s.piece).of(s.piece));
  const picked = useCameraKeys((s) => s.selected);
  const sel = picked !== null && picked < keys.length ? picked : null;
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className="field-row camera-key-buttons" ref={root}>
      <button
        type="button"
        disabled={disabled}
        title="Add a camera key here, from this view"
        data-testid="camera-key-add"
        onClick={() => {
          const t = ctl.time();
          const near = keyNear(pieceKeys(), t);
          if (near >= 0) {
            select(near);
            return;
          }
          const tr = track();
          const key = tr.fromView(ctl, t);
          if (!key) return;
          const { keys: next, index } = addKey(pieceKeys(), key);
          edit((p) => tr.with(p, next), 'Add camera key');
          select(index);
        }}
      >
        + Key
      </button>
      <button
        type="button"
        disabled={disabled || sel === null}
        title="Delete the selected key"
        data-testid="camera-key-delete"
        onClick={() => {
          if (sel === null) return;
          const tr = track();
          edit((p) => tr.with(p, deleteKey(tr.of(p), sel)), 'Delete camera key');
          const left = keys.length - 1;
          select(left > 0 ? Math.min(sel, left - 1) : null);
          // This button disables itself when no key is left: focus Add.
          if (left === 0) {
            requestAnimationFrame(() =>
              root.current?.querySelector<HTMLElement>('[data-testid="camera-key-add"]')?.focus(),
            );
          }
        }}
      >
        Delete
      </button>
      <output data-testid="camera-key-count">
        {sel === null
          ? `${keys.length} key${keys.length === 1 ? '' : 's'}`
          : `Key ${sel + 1} of ${keys.length}`}
      </output>
    </div>
  );
}

/**
 * Dragging the preview pans the selected key's view (the paper follows the pointer) and the
 * wheel or a pinch zooms it (Shift: the pitch range). The preview first moves to the key's time,
 * so what you shape is the key itself. Readouts (HUD boxes) keep their own drags.
 */
export function useKeyView(
  stage: RefObject<HTMLElement | null>,
  ctl: CameraCtl,
  on: boolean,
): void {
  useEffect(() => {
    const el = stage.current;
    if (!el || !on) return;
    let pan: { i: number; k: AnyKey; x: number; y: number; id: number } | null = null;
    let wheel: { i: number; k: AnyKey; f: number; range: boolean; g: object | null } | null = null;
    let wheelTimer = 0;
    const endWheel = () => {
      window.clearTimeout(wheelTimer);
      if (wheel && currentGesture() === wheel.g) endGesture();
      wheel = null;
    };
    const target = (): { i: number; k: AnyKey } | null => {
      const keys = pieceKeys();
      const i = selectedIn(keys);
      return i === null ? null : { i, k: keys[i] };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.hud-box')) return;
      const s = target();
      if (!s) return;
      endWheel();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      ctl.seek(s.k.at);
      pan = { ...s, x: e.clientX, y: e.clientY, id: e.pointerId };
      el.classList.add('panning');
      beginGesture('Camera view');
    };
    const move = (e: PointerEvent) => {
      if (!pan || pan.id !== e.pointerId) return;
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - pan.x) / Math.max(1, r.width);
      const dy = (e.clientY - pan.y) / Math.max(1, r.height);
      const { i, k } = pan;
      const tr = track();
      updateGesture((p) =>
        tr.with(
          p,
          updateKey(tr.of(p), i, () => tr.pan(ctl, k, dx, dy)),
        ),
      );
    };
    const up = (e: PointerEvent) => {
      if (!pan || pan.id !== e.pointerId) return;
      pan = null;
      el.classList.remove('panning');
      endGesture();
    };
    const onWheel = (e: WheelEvent) => {
      const s = target();
      if (!s) return;
      e.preventDefault();
      // Shift turns a vertical wheel sideways in some browsers: take either axis.
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const px = e.deltaMode === 1 ? d * 16 : e.deltaMode === 2 ? d * 400 : d;
      const range = e.shiftKey;
      if (!wheel || wheel.i !== s.i || wheel.range !== range || currentGesture() !== wheel.g) {
        endWheel();
        ctl.seek(s.k.at);
        beginGesture(range ? 'Camera range' : 'Camera zoom');
        wheel = { ...s, f: 1, range, g: currentGesture() };
      }
      wheel.f *= Math.exp(px * (e.ctrlKey ? 0.01 : 0.002));
      const { i, k, f } = wheel;
      const tr = track();
      updateGesture((p) =>
        tr.with(
          p,
          updateKey(tr.of(p), i, () => tr.zoom(k, f, range)),
        ),
      );
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(endWheel, WHEEL_GESTURE_MS);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      endWheel();
      if (pan) endGesture();
      el.classList.remove('panning');
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', onWheel);
    };
  }, [stage, ctl, on]);
}
