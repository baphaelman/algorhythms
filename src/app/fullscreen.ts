/**
 * Fullscreen across browsers (PLAN.md §15 M17 "Watch view", "Phones"): element fullscreen with
 * the WebKit-prefixed fallbacks (older iPad Safari), the iPhone's video-only fullscreen
 * (`webkitEnterFullscreen`, iOS's own player), the landscape lock on phones, and the workspace's
 * F key. Each takes the document (or prototype) it reads, for tests; the defaults are the page's.
 */

import { takesText } from './editor/shortcuts';

/** The parts of `document` fullscreen reads (standard and WebKit-prefixed). */
export interface FsDoc {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  onfullscreenchange?: unknown;
}

/** An element that can ask for fullscreen (standard or WebKit-prefixed). */
export interface FsElement {
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => void;
}

const page = (): FsDoc => (typeof document === 'undefined' ? {} : (document as FsDoc));

/** The browser offers element fullscreen (desktop, Android, iPad). */
export function canElementFullscreen(doc: FsDoc = page()): boolean {
  return doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true;
}

/** The element in fullscreen, or null. */
export function fullscreenElement(doc: FsDoc = page()): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** The change event this browser fires (only one, so a change is handled once). */
export function fullscreenChangeEvent(doc: FsDoc = page()): string {
  return 'onfullscreenchange' in doc || typeof doc.exitFullscreen === 'function'
    ? 'fullscreenchange'
    : 'webkitfullscreenchange';
}

/** Asks for fullscreen; a refusal (no click, a policy) or no support resolves quietly. */
export function requestElementFullscreen(el: FsElement): Promise<void> {
  try {
    if (typeof el.requestFullscreen === 'function') {
      return Promise.resolve(el.requestFullscreen()).catch(() => undefined);
    }
    if (typeof el.webkitRequestFullscreen === 'function') el.webkitRequestFullscreen();
  } catch {
    // Refused synchronously: the view stays in the window.
  }
  return Promise.resolve();
}

/** Leaves element fullscreen. */
export function exitElementFullscreen(doc: FsDoc = page()): void {
  try {
    if (typeof doc.exitFullscreen === 'function') {
      void Promise.resolve(doc.exitFullscreen()).catch(() => undefined);
    } else doc.webkitExitFullscreen?.();
  } catch {
    // Already out.
  }
}

/**
 * Only a `<video>` can go fullscreen (iPhone Safari): no element fullscreen, but
 * `webkitEnterFullscreen` on videos, and a canvas stream to feed one.
 */
export function videoFullscreenOnly(
  doc: FsDoc = page(),
  video: object | undefined = typeof HTMLVideoElement === 'undefined'
    ? undefined
    : HTMLVideoElement.prototype,
  canvas: object | undefined = typeof HTMLCanvasElement === 'undefined'
    ? undefined
    : HTMLCanvasElement.prototype,
): boolean {
  if (canElementFullscreen(doc) || !video || !canvas) return false;
  return 'webkitEnterFullscreen' in video && 'captureStream' in canvas;
}

/** The fullscreen button shows: element fullscreen, or the iPhone's video fullscreen. */
export const canFullscreen = (doc: FsDoc = page()): boolean =>
  canElementFullscreen(doc) || videoFullscreenOnly(doc);

/** What an event from iOS's own player does to our transport (it plays muted; we keep the sound). */
export type NativeAction = 'play' | 'pause' | 'exit' | null;

/** Its play and pause follow ours both ways (only a change acts); leaving its player exits. */
export function nativePlayerAction(event: string, playing: boolean): NativeAction {
  if (event === 'play' || event === 'playing') return playing ? null : 'play';
  if (event === 'pause') return playing ? 'pause' : null;
  if (event === 'webkitendfullscreen') return 'exit';
  return null;
}

/** Lock to landscape in fullscreen: a phone (a touch screen) and a video wider than tall. */
export const landscapeWanted = (o: { coarse: boolean; aspect: number }): boolean =>
  o.coarse && o.aspect > 1;

/** Locks the screen to landscape; unsupported or refused is fine. */
export function lockLandscape(): void {
  const o = (typeof screen === 'undefined' ? undefined : screen.orientation) as
    { lock?: (o: string) => Promise<void> } | undefined;
  if (typeof o?.lock !== 'function') return;
  try {
    void Promise.resolve(o.lock('landscape')).catch(() => undefined);
  } catch {
    // Not in fullscreen yet, or not allowed.
  }
}

/** Undoes `lockLandscape`. */
export function unlockOrientation(): void {
  const o = (typeof screen === 'undefined' ? undefined : screen.orientation) as
    { unlock?: () => void } | undefined;
  try {
    o?.unlock?.();
  } catch {
    // Nothing locked.
  }
}

/** F in the Video workspace goes fullscreen: no modifiers, no dialog, not typing. */
export function workspaceFullscreenKey(e: {
  key: string;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: unknown;
  dialog: boolean;
}): boolean {
  if (e.defaultPrevented || e.dialog || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
    return false;
  }
  return (e.key === 'f' || e.key === 'F') && !takesText(e.target);
}
