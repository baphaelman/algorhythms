/**
 * Autosave rules (PLAN.md §11.4), DOM-free:
 * - a piece enters My pieces at its first edit, or straight away when made by Generate or New;
 *   opening an example, a file or a link saves nothing until it is edited;
 * - saves are debounced (500 ms) and serialized; a load flushes the previous piece's pending save;
 * - reopening an entry keeps editing that entry.
 */

import type { Piece } from '../../core/types';
import type { Library, LibraryEntry } from './library';

/** Where a loaded piece came from; `other` is an example, a file, a link or anything else. */
export type PieceSource = 'generated' | 'new' | 'library' | 'other';

export interface AutosaveDeps {
  library: Library;
  /** The piece as file text, with `meta.modified` set to `nowMs`. */
  serialize(piece: Piece, nowMs: number): string;
  now(): number;
  newId(): string;
  /** Debounce, ms. @default 500 */
  delayMs?: number;
  /** Called once, after the first save of this session (requests persistent storage). */
  onFirstSave?(): void;
  /** After every save. */
  onSaved?(entry: LibraryEntry): void;
  /** Writes a saved entry to its linked file. */
  writeFile?(entry: LibraryEntry): Promise<void>;
  onError?(e: unknown): void;
}

export class Autosaver {
  /** The entry the open piece saves to; null until it has one. */
  current: string | null = null;
  private pending: { id: string; piece: Piece } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private savedOnce = false;
  private readonly deleted = new Set<string>();
  private readonly delay: number;

  constructor(private readonly d: AutosaveDeps) {
    this.delay = d.delayMs ?? 500;
  }

  /** A piece was opened. `entryId` is the entry it was opened from (`source` 'library'). */
  loaded(piece: Piece, source: PieceSource, entryId?: string): void {
    void this.flush();
    if (source === 'library' && entryId) {
      this.current = entryId;
    } else if (source === 'generated' || source === 'new') {
      this.current = this.d.newId();
      this.schedule(piece);
    } else {
      this.current = null;
    }
  }

  /** The open piece was edited. */
  edited(piece: Piece): void {
    this.current ??= this.d.newId();
    this.schedule(piece);
  }

  /** Gives the open piece an entry now (Save as file, Link to a file), saving it. */
  async adopt(piece: Piece): Promise<string> {
    this.current ??= this.d.newId();
    this.schedule(piece);
    await this.flush();
    return this.current;
  }

  /** An entry was deleted: drop its pending save; the open piece starts a new entry if edited. */
  forget(id: string): void {
    this.deleted.add(id);
    if (this.pending?.id === id) {
      this.cancelTimer();
      this.pending = null;
    }
    if (this.current === id) this.current = null;
  }

  /** Writes any pending save now; resolves when every save so far is stored. */
  flush(): Promise<void> {
    this.cancelTimer();
    const p = this.pending;
    this.pending = null;
    if (p) this.chain = this.chain.then(() => this.write(p.id, p.piece));
    return this.chain;
  }

  /** True while a save is waiting for the debounce. */
  get dirty(): boolean {
    return this.pending !== null;
  }

  private schedule(piece: Piece): void {
    if (!this.current) return;
    if (this.pending && this.pending.id !== this.current) void this.flush();
    this.pending = { id: this.current, piece };
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async write(id: string, piece: Piece): Promise<void> {
    if (this.deleted.has(id)) return;
    try {
      const now = this.d.now();
      const prev = await this.d.library.get(id);
      const entry: LibraryEntry = {
        ...prev,
        id,
        title: piece.meta.title,
        created: prev?.created ?? now,
        updated: now,
        json: this.d.serialize(piece, now),
      };
      await this.d.library.put(entry);
      if (!this.savedOnce) {
        this.savedOnce = true;
        this.d.onFirstSave?.();
      }
      if (entry.file && this.d.writeFile) await this.d.writeFile(entry);
      this.d.onSaved?.(entry);
    } catch (e) {
      this.d.onError?.(e);
    }
  }
}
