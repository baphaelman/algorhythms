/**
 * The address bar is the share link (PLAN.md §11.4): wires `AddressBar` (address-rules.ts) to the
 * player, My pieces and the page's history, and follows `hashchange`. Call `startAddressBar` after
 * `startPersistence` and before `startPlayer`.
 */

import { AddressBar, writeRecord } from './address-rules';
import { usePersist } from './persist';
import { encodePiecePayload } from './share';
import { loadInfo, openAddress, usePlayer } from './store';

function idle(fn: () => void): void {
  const w = globalThis as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 1000 });
  else setTimeout(fn, 0);
}

function session(): Storage | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

let bar: AddressBar | null = null;

export function startAddressBar(): AddressBar {
  if (bar) return bar;
  const write = (hash: string): void => {
    try {
      history.replaceState(history.state, '', location.pathname + location.search + hash);
    } catch {
      /* ignore */
    }
  };
  const b = new AddressBar({
    encode: encodePiecePayload,
    write,
    current: () => location.hash,
    remember: (rec) => writeRecord(session(), rec),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    idle,
  });
  bar = b;
  const entry = (): string | null => usePersist.getState().current;
  let seen = loadInfo().count;
  usePlayer.subscribe((state, prev) => {
    const info = loadInfo();
    if (info.count !== seen) {
      seen = info.count;
      b.loaded(state.piece, { example: info.example, fromUrl: info.keepHash, entry: entry() });
    } else if (state.piece !== prev.piece) {
      b.edited(state.piece, entry());
    }
  });
  usePersist.subscribe((s, p) => {
    if (s.current !== p.current) b.entryChanged(s.current);
  });
  window.addEventListener('hashchange', () => {
    const hash = location.hash;
    if (b.isOwn(hash)) return;
    // A fragment that names nothing: the address bar goes back to the open piece.
    if (!openAddress(hash) && b.last !== '') write(b.last);
  });
  return b;
}
