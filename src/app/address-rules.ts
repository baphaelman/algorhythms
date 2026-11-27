/**
 * The address bar is the share link (PLAN.md §11.4, owner 2026-11-24), DOM-free:
 * - an unedited bundled example reads `#<example-id>`; anything else reads `#p=<payload>`;
 * - a watch link (M17: `#w&p=…`, `#w&<example-id>`) opens like its share link, to watch; the bar
 *   then shows the editor link (the flag is dropped), as for any opened piece; an example's watch
 *   link may name the video's frame (`#w&<id>&f=poster`), which the example opens with;
 * - edits re-encode after a debounce (400 ms) and an idle callback, never per frame;
 * - the URL is written with `replaceState` (by the caller's `write`), so Back is unchanged;
 * - a per-tab record `{ hash, entry }` lets a reload of our own URL reopen the same My pieces
 *   entry instead of opening it as a shared piece (no duplicate).
 */

import type { CameraFrame, Piece } from '../core/types';
import { SHARE_KEY, isWatchHash, sharePayloadOf, watchFrameOf, withoutWatch } from './share';

/**
 * What a URL fragment names; `watch` (M17): opened to watch (a watch link); `frame`: the video
 * frame an example's watch link names.
 */
export type Address =
  | { kind: 'example'; id: string; watch?: true; frame?: CameraFrame }
  | { kind: 'share'; payload: string; watch?: true }
  | { kind: 'none' };

/**
 * Reads a fragment (`#kite-day`, `#p=…`, with or without `#`; either with the watch flag,
 * `#w&…`). `isExample` checks an id.
 */
export function parseAddress(hash: string, isExample: (id: string) => boolean): Address {
  const watch = isWatchHash(hash);
  const flag = watch ? ({ watch: true } as const) : {};
  const rest = watch ? withoutWatch(hash) : hash;
  const payload = sharePayloadOf(rest);
  if (payload !== null) return { kind: 'share', payload, ...flag };
  const name = rest.startsWith('#') ? rest.slice(1) : rest;
  if (/^[a-z0-9][a-z0-9-]*$/.test(name) && isExample(name)) {
    const frame = watch ? watchFrameOf(hash) : undefined;
    return { kind: 'example', id: name, ...flag, ...(frame ? { frame } : {}) };
  }
  return { kind: 'none' };
}

export const exampleHash = (id: string): string => `#${id}`;
export const shareHash = (payload: string): string => `#${SHARE_KEY}=${payload}`;

/** The URL in the address bar for this piece, per tab: its fragment and its My pieces entry. */
export interface AddressRecord {
  hash: string;
  entry: string | null;
}

export const ADDRESS_KEY = 'algorhythms.address';

/** The record, or null when absent or unreadable. */
export function readRecord(storage: Pick<Storage, 'getItem'> | undefined): AddressRecord | null {
  try {
    const v = JSON.parse(storage?.getItem(ADDRESS_KEY) ?? 'null') as unknown;
    if (!v || typeof v !== 'object') return null;
    const { hash, entry } = v as Record<string, unknown>;
    if (typeof hash !== 'string') return null;
    return { hash, entry: typeof entry === 'string' ? entry : null };
  } catch {
    return null;
  }
}

export function writeRecord(
  storage: Pick<Storage, 'setItem'> | undefined,
  rec: AddressRecord,
): void {
  try {
    storage?.setItem(ADDRESS_KEY, JSON.stringify(rec));
  } catch {
    /* storage unavailable */
  }
}

/** The record when `hash` is the URL this tab last wrote (a reload of our own URL), else null. */
export function ownRecord(hash: string, rec: AddressRecord | null): AddressRecord | null {
  return rec !== null && hash !== '' && rec.hash === hash ? rec : null;
}

export interface AddressDeps {
  encode(piece: Piece): Promise<string>;
  /** Puts `hash` in the address bar (replaceState). */
  write(hash: string): void;
  /** The address bar's fragment now. */
  current(): string;
  remember(rec: AddressRecord): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  idle(fn: () => void): void;
  /** Debounce after an edit, ms. @default 400 */
  delayMs?: number;
}

/** Keeps the address bar on the open piece. */
export class AddressBar {
  /** The fragment this bar last wrote or adopted. */
  last = '';
  private entry: string | null = null;
  private gen = 0;
  private timer: unknown = null;
  private readonly delay: number;

  constructor(private readonly d: AddressDeps) {
    this.delay = d.delayMs ?? 400;
  }

  /**
   * A piece was opened. `example`: an unedited bundled example; `fromUrl`: it came from the
   * address bar's own fragment, which already names it.
   */
  loaded(piece: Piece, o: { example?: string; fromUrl?: boolean; entry: string | null }): void {
    this.cancel();
    this.entry = o.entry;
    if (o.example !== undefined) {
      this.put(exampleHash(o.example));
    } else if (o.fromUrl) {
      const cur = this.d.current();
      const clean = isWatchHash(cur) ? withoutWatch(cur) : cur;
      if (clean !== cur) this.put(clean);
      else {
        this.last = cur;
        this.d.remember({ hash: this.last, entry: this.entry });
      }
    } else {
      this.schedule(piece, 0);
    }
  }

  /** The open piece was edited: re-encode after the debounce. */
  edited(piece: Piece, entry: string | null): void {
    this.entry = entry;
    this.schedule(piece, this.delay);
  }

  /** The open piece got (or lost) its My pieces entry. */
  entryChanged(entry: string | null): void {
    if (entry === this.entry) return;
    this.entry = entry;
    if (this.last !== '') this.d.remember({ hash: this.last, entry });
  }

  /** True when `hash` is the fragment this bar wrote (a `hashchange` to ignore). */
  isOwn(hash: string): boolean {
    return hash === this.last;
  }

  private put(hash: string): void {
    this.last = hash;
    if (this.d.current() !== hash) this.d.write(hash);
    this.d.remember({ hash, entry: this.entry });
  }

  private schedule(piece: Piece, ms: number): void {
    this.cancel();
    const gen = this.gen;
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      this.d.idle(() => {
        if (gen !== this.gen) return;
        this.d.encode(piece).then(
          (payload) => {
            if (gen === this.gen) this.put(shareHash(payload));
          },
          () => undefined,
        );
      });
    }, ms);
  }

  private cancel(): void {
    this.gen++;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }
}
