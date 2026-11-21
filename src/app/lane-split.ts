/**
 * The score/lanes divider's position, remembered per viewer (PLAN §11.3 "Dense lanes"): the lane
 * area's share of the timeline height, or null for the default split. Storage may be missing or
 * throw (private windows, blocked site data): every access is guarded and falls back to null.
 */

const KEY = 'algorhythms.laneSplit';

export function loadLaneSplit(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw == null) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 && v < 1 ? v : null;
  } catch {
    return null;
  }
}

export function saveLaneSplit(share: number | null): void {
  try {
    if (share === null) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, String(Math.round(share * 1e4) / 1e4));
  } catch {
    // Not remembered: the split still applies for this page.
  }
}
