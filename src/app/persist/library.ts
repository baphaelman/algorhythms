/**
 * My pieces (PLAN.md §11.4): the stored entries and the storage interface. DOM-free, so unit tests
 * use `memoryLibrary()`; the browser uses `idbLibrary()` (./idb.ts).
 */

import { sanitizeFileName } from '../export-options';
import { isIos, type NavigatorLike } from '../platform';

/** A writable file on disk (File System Access API, Chromium). */
export interface LinkedFile {
  readonly name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** One piece in My pieces. */
export interface LibraryEntry {
  /** Library id (not part of the piece). */
  id: string;
  /** `meta.title` at the last save. */
  title: string;
  /** First and last save, ms since the epoch. */
  created: number;
  updated: number;
  /** The piece, as `serializePiece` text. */
  json: string;
  /** When the piece was last downloaded as a file (Save as file, Download all). */
  fileSavedAt?: number;
  /** A linked file that autosave also writes (Chromium). */
  file?: LinkedFile;
}

/** The storage behind My pieces. */
export interface Library {
  /** All entries, most recently edited first. */
  list(): Promise<LibraryEntry[]>;
  get(id: string): Promise<LibraryEntry | undefined>;
  put(entry: LibraryEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Most recently edited first. */
export function byUpdated(entries: LibraryEntry[]): LibraryEntry[] {
  return entries.sort((a, b) => b.updated - a.updated);
}

/** An in-memory library (tests; the fallback when IndexedDB is unavailable). */
export function memoryLibrary(): Library {
  const rows = new Map<string, LibraryEntry>();
  return {
    list: () => Promise.resolve(byUpdated([...rows.values()].map((e) => ({ ...e })))),
    get: (id) => {
      const e = rows.get(id);
      return Promise.resolve(e && { ...e });
    },
    put: (entry) => {
      rows.set(entry.id, { ...entry });
      return Promise.resolve();
    },
    delete: (id) => {
      rows.delete(id);
      return Promise.resolve();
    },
  };
}

/** What My pieces says about an entry's file. */
export type FileState = 'linked' | 'saved' | 'changed' | 'none';

export function fileState(e: LibraryEntry): FileState {
  if (e.file) return 'linked';
  if (e.fileSavedAt === undefined) return 'none';
  return e.updated > e.fileSavedAt ? 'changed' : 'saved';
}

/** `<title>.algorhythms.json`, sanitized. */
export function pieceFileName(title: string): string {
  return `${sanitizeFileName(title)}.algorhythms.json`;
}

/** File names for a zip: `pieceFileName`, with `-2`, `-3`… added to repeats. */
export function zipNames(titles: readonly string[]): string[] {
  const used = new Set<string>();
  return titles.map((t) => {
    const stem = sanitizeFileName(t);
    let name = `${stem}.algorhythms.json`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}.algorhythms.json`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** A zip of every entry as `.algorhythms.json` (fflate is loaded on demand). */
export async function libraryZip(entries: readonly LibraryEntry[]): Promise<Uint8Array> {
  const { strToU8, zipSync } = await import('fflate');
  const names = zipNames(entries.map((e) => e.title));
  const files: Record<string, Uint8Array> = {};
  entries.forEach((e, i) => {
    files[names[i]] = strToU8(e.json);
  });
  return zipSync(files, { level: 6 });
}

/** Safari (and every iOS browser) may clear script storage after 7 days without a visit. */
export function evictsAfterAWeek(nav: NavigatorLike): boolean {
  if (isIos(nav)) return true;
  return /Safari\//.test(nav.userAgent) && !/Chrom(e|ium)|Edg\/|OPR\/|Android/.test(nav.userAgent);
}
