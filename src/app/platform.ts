/**
 * Small platform checks for the player (PLAN.md §11.5). DOM-free: they take the navigator as an
 * argument so tests can pass a fake one.
 */

/** The parts of `navigator` these checks read. */
export interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

/** True on iPhone, iPad and iPod (including iPadOS, which reports itself as a Mac). */
export function isIos(nav: NavigatorLike): boolean {
  if (/iP(hone|ad|od)/.test(nav.userAgent)) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

/** Whether the Audio Session API (`navigator.audioSession`) exists on this navigator. */
export function hasAudioSession(nav: object): boolean {
  return 'audioSession' in nav && (nav as { audioSession?: unknown }).audioSession != null;
}

/**
 * iOS mutes Web Audio while the ring/silent switch is on, unless the page asks for the
 * 'playback' audio session. Where that API is missing, the player shows a one-line hint.
 */
export function needsSilentModeHint(nav: NavigatorLike): boolean {
  return isIos(nav) && !hasAudioSession(nav);
}

/**
 * Asks iOS for the 'playback' audio session (so the silent switch doesn't mute the page).
 * Returns true when the API exists and was set.
 */
export function requestPlaybackSession(nav: object): boolean {
  if (!hasAudioSession(nav)) return false;
  try {
    (nav as { audioSession: { type: string } }).audioSession.type = 'playback';
    return true;
  } catch {
    return false;
  }
}

/** Format a window length for the slider readout: "2.5 s", "20 s", "1:30". */
export function formatWindow(seconds: number): string {
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
