/**
 * Fullscreen for the watch view (PLAN.md §15 M17 "Watch view"), from its own button and from the
 * Video workspace's (YouTube's corner). Element fullscreen of the stage where the browser has it
 * (../fullscreen.ts); on an iPhone, iOS's own player fed by the preview canvas's stream. Entering
 * from the workspace opens the watch view at the same time, playing or not; leaving that
 * fullscreen (any way) returns to the workspace.
 */

import { create } from 'zustand';
import { videoSize } from '../../render/video';
import { useExportSurface } from '../export-surface';
import { fullscreenLeaves } from '../watch';
import {
  canElementFullscreen,
  exitElementFullscreen,
  fullscreenElement,
  landscapeWanted,
  lockLandscape,
  nativePlayerAction,
  requestElementFullscreen,
  unlockOrientation,
  videoFullscreenOnly,
} from '../fullscreen';
import { leaveWatch, pausePreview, playPreview, useExportUi } from './export-state';

/**
 * `played`: Play has been pressed in this watch view (the large Play and the first frame's pin
 * go). `fullscreen`: in fullscreen (the stage's, or iOS's player).
 */
export const useWatchUi = create<{ played: boolean; fullscreen: boolean }>()(() => ({
  played: false,
  fullscreen: false,
}));

/** The watch view was opened by the workspace's fullscreen button (or F). */
let fromWorkspace = false;
/** The view's own button is leaving fullscreen (the view stays, unless from the workspace). */
let exitingOurs = false;

export const openedFromWorkspace = (): boolean => fromWorkspace;

/** The view starts: `played` if the workspace's button opened it. */
export function watchMounted(): void {
  useWatchUi.setState({ played: fromWorkspace, fullscreen: inFullscreen() });
}

// The view ends (any way): out of fullscreen, and the workspace entry is forgotten. (Not on the
// view's unmount: React's dev double mount would drop both.)
useExportSurface.subscribe((s, p) => {
  if (s.watch || !p.watch) return;
  fromWorkspace = false;
  exitFullscreen(false);
});

/** The fullscreen target: the Video workspace's stage. */
const stageEl = (): HTMLElement | null => document.querySelector('.video-ws .video-stage');

function wantLandscape(): void {
  const f = useExportUi.getState().form;
  const px = videoSize(f.videoAspect, f.videoSize);
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (landscapeWanted({ coarse, aspect: px.width / px.height })) lockLandscape();
}

const inFullscreen = (): boolean => fullscreenElement() !== null || ios.active;

/** Goes fullscreen (call it from a click or a key). */
export function enterFullscreen(): void {
  if (inFullscreen()) return;
  if (canElementFullscreen()) {
    const el = stageEl();
    if (!el) return;
    void requestElementFullscreen(el).then(() => {
      if (fullscreenElement()) wantLandscape();
    });
  } else if (videoFullscreenOnly()) enterIosPlayer();
}

/** Leaves fullscreen; `ours`: the view's own button or F (the view stays, unless from the workspace). */
export function exitFullscreen(ours: boolean): void {
  if (ios.active) {
    exitingOurs = ours;
    ios.video?.webkitExitFullscreen?.();
    return;
  }
  if (!fullscreenElement()) return;
  exitingOurs = ours;
  unlockOrientation();
  exitElementFullscreen();
}

export function toggleFullscreen(): void {
  if (inFullscreen()) exitFullscreen(true);
  else enterFullscreen();
}

/**
 * The fullscreen state changed (the browser's event, or iOS's player closing): note it, and say
 * whether the view should leave for the workspace.
 */
export function fullscreenChanged(): boolean {
  const fs = inFullscreen();
  const ours = exitingOurs;
  if (!fs) exitingOurs = false;
  useWatchUi.setState({ fullscreen: fs });
  return fullscreenLeaves({ fullscreen: fs, ours, fromWorkspace });
}

/**
 * The workspace's fullscreen button (or F): the watch view at the current time, playing or not,
 * in fullscreen where the browser allows (else filling the window).
 */
export function fullscreenFromWorkspace(): void {
  if (useExportSurface.getState().watch) return;
  fromWorkspace = true;
  useWatchUi.setState({ played: true });
  // Ask now, inside the click: the stage is already on the page.
  enterFullscreen();
  useExportSurface.setState({ watch: true });
}

// ---- iPhone: iOS's own player, showing the preview canvas's stream ------------------------------

interface IosVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

const ios: { video: IosVideo | null; canvas: HTMLCanvasElement | null; active: boolean } = {
  video: null,
  canvas: null,
  active: false,
};

/** The preview's canvas feeds a hidden, muted video (made ahead, so the click can go at once). */
export function attachIosPlayer(canvas: HTMLCanvasElement): () => void {
  if (!videoFullscreenOnly()) return () => undefined;
  let stream: MediaStream;
  try {
    stream = canvas.captureStream(30);
  } catch {
    return () => undefined;
  }
  const v = document.createElement('video') as IosVideo;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('aria-hidden', 'true');
  v.dataset.testid = 'ios-player';
  v.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  v.srcObject = stream;
  document.body.append(v);
  // Muted inline video may play unasked: once, so it has a frame before the click.
  void v.play().then(
    () => {
      if (!ios.active) v.pause();
    },
    () => undefined,
  );
  const onEvent = (e: Event): void => {
    if (!ios.active) return;
    const act = nativePlayerAction(e.type, useExportUi.getState().previewPlaying);
    if (act === 'play') playPreview();
    else if (act === 'pause') pausePreview();
    else if (act === 'exit') {
      ios.active = false;
      if (fullscreenChanged()) leaveWatch();
    }
  };
  for (const t of ['play', 'pause', 'webkitendfullscreen']) v.addEventListener(t, onEvent);
  // Ours drives its play and pause (a paused stream shows the frame it stopped on).
  const off = useExportUi.subscribe((s, p) => {
    if (s.previewPlaying === p.previewPlaying || !ios.active) return;
    if (s.previewPlaying) void v.play().catch(() => undefined);
    else v.pause();
  });
  ios.video = v;
  ios.canvas = canvas;
  return () => {
    off();
    for (const t of ['play', 'pause', 'webkitendfullscreen']) v.removeEventListener(t, onEvent);
    for (const track of stream.getTracks()) track.stop();
    v.remove();
    if (ios.video === v) {
      ios.video = null;
      ios.canvas = null;
      ios.active = false;
    }
  };
}

function enterIosPlayer(): void {
  const v = ios.video;
  if (!v || typeof v.webkitEnterFullscreen !== 'function') return;
  try {
    v.webkitEnterFullscreen();
  } catch {
    // Not ready (no frame yet): the view stays in the window.
    return;
  }
  ios.active = true;
  useWatchUi.setState({ fullscreen: true });
  if (useExportUi.getState().previewPlaying) void v.play().catch(() => undefined);
}
