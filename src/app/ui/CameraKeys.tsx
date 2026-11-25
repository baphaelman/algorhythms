/**
 * The Export dialog's Camera (PLAN.md §15 M11.5 C3): Follow, Auto, Keys (and Whole piece). Follow,
 * Auto and Keys write the piece's camera mode, one undo entry each; Edit copies Auto's keys into
 * the piece. In Keys, markers on the preview's timeline select, move (drag, arrow keys) and
 * delete keys; with a key selected, dragging the preview pans its view and scrolling zooms it
 * (Shift: the pitch range), one undo entry per gesture.
 */

import { useEffect, useId, useRef, type RefObject } from 'react';
import { create } from 'zustand';
import type { CameraKey, CameraMode } from '../../core/types';
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
  updateKey,
  withCameraKeys,
  withCameraMode,
  zoomKey,
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
}

/** The selected key's index (in the piece's keys), or null. */
export const useCameraKeys = create<{ selected: number | null }>()(() => ({ selected: null }));

const select = (i: number | null) => useCameraKeys.setState({ selected: i });

/** The selected index if it still names a key. */
function selectedIn(keys: readonly CameraKey[]): number | null {
  const i = useCameraKeys.getState().selected;
  return i !== null && i < keys.length ? i : null;
}

const pieceKeys = () => keysOf(usePlayer.getState().piece);

/** Wheel zooms within this pause of each other are one undo entry, ms. */
const WHEEL_GESTURE_MS = 400;

/**
 * Keys mode's keys: the piece's own (`fresh`: Auto's instead), else Auto's, else one key from
 * the view the preview shows now.
 */
function startKeys(ctl: CameraCtl, fresh: boolean): readonly CameraKey[] {
  const own = keysOf(usePlayer.getState().piece);
  if (!fresh && own.length > 0) return own;
  const auto = ctl.autoKeys();
  if (auto && auto.length > 0) return auto;
  const t = ctl.time();
  const cam = ctl.cameraAt(t);
  return cam ? [keyOfCamera(cam, t, undefined, ctl.aspect())] : own;
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
    edit(
      (p) =>
        keys.length === 0 || (p.camera?.mode === 'keys' && keysOf(p) === keys)
          ? withCameraMode(p, 'keys')
          : withCameraKeys(p, keys),
      'Camera',
    );
    select(null);
  } else edit((p) => withCameraMode(p, m), 'Camera');
  ctl.setChoice(m);
}

/** The Camera group, its hint, and Edit (Auto). */
export function CameraField({
  value,
  disabled,
  ctl,
}: {
  value: VideoCameraMode;
  disabled: boolean;
  ctl: CameraCtl;
}) {
  const id = useId();
  const hint = VIDEO_CAMERAS.find((c) => c.id === value)?.hint;
  return (
    <>
      <Radios
        legend="Camera"
        name={`${id}-camera`}
        value={value}
        options={VIDEO_CAMERAS}
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
              edit((p) => withCameraKeys(p, keys), 'Edit camera');
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
function editSelected(fn: (k: CameraKey) => CameraKey, label: string): void {
  const i = selectedIn(pieceKeys());
  if (i === null) return;
  edit((p) => withCameraKeys(p, updateKey(keysOf(p), i, fn)), label);
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
  const keys = usePlayer((s) => keysOf(s.piece));
  const picked = useCameraKeys((s) => s.selected);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; id: number } | null>(null);
  const id = useId();
  const span = Math.max(1e-6, to - from);
  const pct = (t: number) => `${(Math.min(1, Math.max(0, (t - from) / span)) * 100).toFixed(3)}%`;
  const timeAt = (clientX: number): number => {
    const r = track.current?.getBoundingClientRect();
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
      edit((p) => withCameraKeys(p, moveKey(keysOf(p), i, at)), 'Move camera key');
      select(i);
      ctl.seek(next[i].at);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      select(i);
      editSelected((x) => ({ ...x, pitch: x.pitch + d }), 'Camera view');
    } else if (e.key === '-' || e.key === '=' || e.key === '+') {
      select(i);
      editSelected((x) => zoomKey(x, e.key === '-' ? 1.25 : 0.8, 'window'), 'Camera zoom');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      edit((p) => withCameraKeys(p, deleteKey(keysOf(p), i)), 'Delete camera key');
      const left = keys.length - 1;
      const next = left === 0 ? -1 : Math.min(i, left - 1);
      select(next >= 0 ? next : null);
      focusMarker(track.current, next, '[data-testid="camera-key-add"]');
    } else done = false;
    if (done) e.preventDefault();
  };

  return (
    <div className="camera-key-track" ref={track} data-testid="camera-keys">
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
              updateGesture((p) => withCameraKeys(p, moveKey(keysOf(p), d.i, t)));
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
  const keys = usePlayer((s) => keysOf(s.piece));
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
          const cam = ctl.cameraAt(t);
          if (!cam) return;
          const { keys: next, index } = addKey(
            pieceKeys(),
            keyOfCamera(cam, t, undefined, ctl.aspect()),
          );
          edit((p) => withCameraKeys(p, next), 'Add camera key');
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
          edit((p) => withCameraKeys(p, deleteKey(keysOf(p), sel)), 'Delete camera key');
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
    let pan: { i: number; k: CameraKey; x: number; y: number; id: number } | null = null;
    let wheel: { i: number; k: CameraKey; f: number; range: boolean; g: object | null } | null =
      null;
    let wheelTimer = 0;
    const endWheel = () => {
      window.clearTimeout(wheelTimer);
      if (wheel && currentGesture() === wheel.g) endGesture();
      wheel = null;
    };
    const target = (): { i: number; k: CameraKey } | null => {
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
      updateGesture((p) =>
        withCameraKeys(
          p,
          updateKey(keysOf(p), i, () => panKey(k, dx, dy)),
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
      updateGesture((p) =>
        withCameraKeys(
          p,
          updateKey(keysOf(p), i, () => zoomKey(k, f, range ? 'range' : 'window')),
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
