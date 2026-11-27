/**
 * The watch view's rules (PLAN.md §15 M17 "Watch view"): its keys, when it ends, when leaving
 * fullscreen leaves it, its times, and Share's Opens to. DOM-free, for tests; the view is
 * ui/WatchView.tsx.
 */

import { watchLinkOf } from './share';

/** The video's clock on the score's clock (`clockNow`): from the lead-in's start to the end card's end. */
export interface WatchClock {
  from: number;
  to: number;
}

/** ←/→ seek this far (s); with Shift, `WATCH_SEEK_LONG`, as in the editor. */
export const WATCH_SEEK = 5;
export const WATCH_SEEK_LONG = 15;

/** How long the controls stay after the pointer stops while playing (ms). */
export const CONTROLS_IDLE_MS = 2500;

export type WatchAction = 'leave' | 'seek' | 'fullscreen';

/**
 * What a keydown does in the watch view: Escape leaves (always, even from a focused control),
 * ←/→ seek by `by` seconds, F toggles fullscreen. Space is the shared Space rule (space-key.ts).
 * A used key, a modifier other than Shift, or an open dialog is not ours.
 */
export function watchKey(e: {
  key: string;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** A modal dialog is open. */
  dialog: boolean;
}): { action: WatchAction; by?: number } | null {
  if (e.defaultPrevented || e.dialog || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === 'Escape') return { action: 'leave' };
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const by = e.shiftKey ? WATCH_SEEK_LONG : WATCH_SEEK;
    return { action: 'seek', by: e.key === 'ArrowLeft' ? -by : by };
  }
  if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) return { action: 'fullscreen' };
  return null;
}

/**
 * Leaving browser fullscreen leaves the watch view (Escape, the browser's own controls), unless
 * the view's own fullscreen button left it (`ours`): then it stays, in the window. Opened by the
 * workspace's fullscreen button (`fromWorkspace`), any way out returns to the workspace.
 */
export function fullscreenLeaves(e: {
  fullscreen: boolean;
  ours: boolean;
  fromWorkspace?: boolean;
}): boolean {
  return !e.fullscreen && (!e.ours || e.fromWorkspace === true);
}

/** The first frame: the lead-in's start (the title card, if any), else the section's start. */
export const watchFirstFrame = (clock: WatchClock): number => clock.from;

/** The time is the video's end (within a frame's slack) and nothing plays: the end screen. */
export function watchEnded(v: number, clock: WatchClock, playing: boolean): boolean {
  return !playing && v >= clock.to - 0.06;
}

/** The time shown and the seek bar's position: seconds into the video, and its length. */
export function watchTimes(v: number, clock: WatchClock): { at: number; length: number } {
  const length = Math.max(0, clock.to - clock.from);
  return { at: Math.min(Math.max(0, v - clock.from), length), length };
}

/** `m:ss`, as video players show it (the hours too past an hour). */
export function playerTime(s: number): string {
  const t = Math.max(0, Math.floor(s + 1e-6));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Spoken time for the seek bar ("1 minute 5 seconds of 3 minutes"). */
export function spokenTime(s: number): string {
  const t = Math.max(0, Math.floor(s + 1e-6));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (m === 0) return part(sec, 'second');
  return sec === 0 ? part(m, 'minute') : `${part(m, 'minute')} ${part(sec, 'second')}`;
}

/** Where a shared link opens: the editor, or the watch view (a watch link). */
export type OpensTo = 'music' | 'video';

/** The link as it opens: the share link, or its watch link (`#w&p=…`). */
export const linkOpening = (link: string, to: OpensTo): string =>
  link && to === 'video' ? watchLinkOf(link) : link;
