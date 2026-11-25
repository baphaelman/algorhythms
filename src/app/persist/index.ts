/**
 * My pieces, wired to the player (PLAN.md §11.4): autosave from `usePlayer.subscribe`, the dialog's
 * state, persistent-storage status, and the menu's New, Save as file, Link to a file and the
 * dialog's Download all.
 */

import { create } from 'zustand';
import { newPiece } from '../../core/defaults';
import { parsePiece, serializePiece } from '../../core/schema';
import type { Piece } from '../../core/types';
import { downloadBlob } from '../download';
import { select } from '../editor/history';
import { PIECE_KEY_ID, requestPieceKeyFocus } from '../editor/piece-key';
import { likeTheVideo } from '../editor/video-template';
import { jsonEqual } from '../../core/schema';
import { shareablePiece } from '../share';
import { loadInfo, loadPiece, pushNotice, runOpen, setLinkedEntry, usePlayer } from '../store';
import { Autosaver } from './autosave';
import { idbLibrary } from './idb';
import {
  libraryZip,
  memoryLibrary,
  pieceFileName,
  type Library,
  type LibraryEntry,
  type LinkedFile,
} from './library';

/** Persistent storage: not asked yet, granted, refused, or no API. */
export type PersistStatus = 'unknown' | 'granted' | 'denied' | 'unsupported';

interface PersistUi {
  open: boolean;
  entries: LibraryEntry[];
  status: PersistStatus;
  /** The entry the open piece saves to. */
  current: string | null;
}

export const usePersist = create<PersistUi>()(() => ({
  open: false,
  entries: [],
  status: 'unknown',
  current: null,
}));

/** The File System Access save picker exists (Chromium). */
export function canLinkFiles(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

function serialize(piece: Piece, nowMs: number): string {
  return serializePiece({
    ...piece,
    meta: { ...piece.meta, modified: new Date(nowMs).toISOString() },
  });
}

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

async function writeFile(entry: LibraryEntry): Promise<void> {
  const f = entry.file;
  if (!f) return;
  const perm = (await f.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  if (perm !== 'granted') return; // asked for again when the entry is reopened from My pieces
  const w = await f.createWritable();
  await w.write(entry.json);
  await w.close();
}

let library: Library = memoryLibrary();
let saver: Autosaver | null = null;
let opening: string | null = null;
let warned = false;

function onError(e: unknown): void {
  if (warned) return;
  warned = true;
  pushNotice('warning', 'Your pieces could not be saved in this browser', [
    e instanceof Error ? e.message : String(e),
    'Use Save as file to keep your work.',
  ]);
}

function requestPersist(): void {
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage?.persist) {
    usePersist.setState({ status: 'unsupported' });
    return;
  }
  storage.persist().then(
    (granted) => usePersist.setState({ status: granted ? 'granted' : 'denied' }),
    () => usePersist.setState({ status: 'denied' }),
  );
}

function syncCurrent(): void {
  const current = saver?.current ?? null;
  if (usePersist.getState().current !== current) usePersist.setState({ current });
}

/** Reloads the dialog's list. */
export async function refreshPieces(): Promise<void> {
  try {
    usePersist.setState({ entries: await library.list() });
  } catch (e) {
    onError(e);
  }
}

/**
 * Starts autosave. `lib` replaces the IndexedDB library (tests). Safe to call more than once.
 */
export function startPersistence(lib?: Library): Autosaver {
  if (saver) return saver;
  library = lib ?? (typeof indexedDB === 'undefined' ? memoryLibrary() : idbLibrary());
  const s = new Autosaver({
    library,
    serialize,
    now: () => Date.now(),
    newId,
    onFirstSave: requestPersist,
    onSaved: () => {
      if (usePersist.getState().open) void refreshPieces();
    },
    writeFile: (entry) =>
      writeFile(entry).catch((e: unknown) => {
        pushNotice('warning', `Could not write ${entry.file?.name ?? 'the linked file'}`, [
          e instanceof Error ? e.message : String(e),
        ]);
      }),
    onError,
  });
  saver = s;
  setLinkedEntry((id, linked) => withEntryPicture(library, id, linked));
  let seen = loadInfo().count;
  usePlayer.subscribe((state, prev) => {
    const info = loadInfo();
    if (info.count !== seen) {
      seen = info.count;
      s.loaded(state.piece, info.source, opening ?? info.entryId);
      opening = null;
    } else if (state.piece !== prev.piece) {
      s.edited(state.piece);
    } else {
      return;
    }
    syncCurrent();
  });
  void navigator.storage?.persisted?.().then(
    (p) => {
      if (p) usePersist.setState({ status: 'granted' });
    },
    () => undefined,
  );
  const flush = (): void => void s.flush();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  return s;
}

/**
 * `linked` (a reload of this tab's link, which never carries a poster picture) with the picture
 * of its My pieces entry, when the entry is the same piece apart from that (and its metadata).
 */
async function withEntryPicture(lib: Library, id: string, linked: Piece): Promise<Piece> {
  try {
    const e = await lib.get(id);
    if (!e) return linked;
    const r = parsePiece(JSON.parse(e.json));
    const picture = r.ok ? r.piece.poster?.picture : undefined;
    if (!r.ok || !picture) return linked;
    const same = jsonEqual({ ...shareablePiece(r.piece), meta: linked.meta }, linked);
    return same ? { ...linked, poster: { ...linked.poster, picture } } : linked;
  } catch {
    return linked;
  }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export function openMyPieces(): void {
  usePersist.setState({ open: true });
  void (saver ? saver.flush() : Promise.resolve()).then(refreshPieces);
}

export function closeMyPieces(): void {
  usePersist.setState({ open: false });
}

/** Opens an entry; later edits keep saving to it. Call from a click (file permission prompt). */
export function openEntry(entry: LibraryEntry): boolean {
  void entry.file?.requestPermission?.({ mode: 'readwrite' }).catch(() => undefined);
  let json: unknown;
  try {
    json = JSON.parse(entry.json);
  } catch (e) {
    pushNotice('error', `Could not open ${entry.title}`, [
      e instanceof Error ? e.message : String(e),
    ]);
    return false;
  }
  const r = parsePiece(json);
  if (!r.ok) {
    pushNotice('error', `Could not open ${entry.title}`, r.errors.slice(0, 8));
    return false;
  }
  const { piece, warnings } = r;
  runOpen(() => {
    opening = entry.id;
    loadPiece(piece, {
      source: 'library',
      notices: warnings.length
        ? [{ kind: 'warning', title: `${entry.title} opened with warnings`, lines: warnings }]
        : [],
    });
    opening = null;
  });
  return true;
}

/** Deletes an entry from My pieces. */
export async function deleteEntry(id: string): Promise<void> {
  saver?.forget(id);
  syncCurrent();
  try {
    await library.delete(id);
  } catch (e) {
    onError(e);
  }
  await refreshPieces();
}

/**
 * Opens the empty template (`newPiece`: 12 voices, no moments, A dorian, glass) as a new entry,
 * with the piece key selected and its Tonic focused, so the first choice is the key.
 */
export function newPieceNow(): void {
  runOpen(() => {
    loadNewPiece();
    select([PIECE_KEY_ID]);
    requestPieceKeyFocus();
  });
}

/** New → "Like the video" (PLAN.md §6.4): the video's template, as a new piece. */
export function newVideoPieceNow(): void {
  runOpen(() => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    loadPiece(likeTheVideo({ seed, now: new Date().toISOString() }), { source: 'new' });
  });
}

/** Loads the empty template at once (Compose for me asks the naming question itself). */
export function loadNewPiece(): void {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  loadPiece(newPiece({ seed, now: new Date().toISOString() }), { source: 'new' });
}

async function markFileSaved(ids: readonly string[], at: number): Promise<void> {
  for (const id of ids) {
    const e = await library.get(id);
    if (e) await library.put({ ...e, fileSavedAt: Math.max(at, e.updated) });
  }
}

/** Downloads the open piece as `<title>.algorhythms.json` and marks its entry saved to a file. */
export async function saveAsFile(): Promise<void> {
  const piece = usePlayer.getState().piece;
  const now = Date.now();
  downloadBlob(
    new Blob([serialize(piece, now)], { type: 'application/json' }),
    pieceFileName(piece.meta.title),
  );
  if (!saver?.current) return;
  try {
    await saver.flush();
    await markFileSaved([saver.current], now);
  } catch (e) {
    onError(e);
  }
  await refreshPieces();
}

/** Downloads every entry as a zip of `.algorhythms.json` files and marks them saved to a file. */
export async function downloadAll(): Promise<number> {
  try {
    await saver?.flush();
    const entries = await library.list();
    if (entries.length === 0) return 0;
    const zip = await libraryZip(entries);
    const now = Date.now();
    downloadBlob(
      new Blob([zip as BlobPart], { type: 'application/zip' }),
      'algorhythms-pieces.zip',
    );
    await markFileSaved(
      entries.map((e) => e.id),
      now,
    );
    await refreshPieces();
    return entries.length;
  } catch (e) {
    pushNotice('error', 'Could not download your pieces', [
      e instanceof Error ? e.message : String(e),
    ]);
    return 0;
  }
}

/**
 * Chromium: asks for a file (call from a click), then saves the open piece to My pieces and links
 * it, so every autosave also writes the file.
 */
export async function linkToFile(): Promise<boolean> {
  const pick = (globalThis as { showSaveFilePicker?: (o: unknown) => Promise<LinkedFile> })
    .showSaveFilePicker;
  if (!pick || !saver) return false;
  const piece = usePlayer.getState().piece;
  let file: LinkedFile;
  try {
    file = await pick.call(globalThis, {
      suggestedName: pieceFileName(piece.meta.title),
      types: [{ description: 'AlgoRhythms piece', accept: { 'application/json': ['.json'] } }],
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return false;
    pushNotice('error', 'Could not link a file', [e instanceof Error ? e.message : String(e)]);
    return false;
  }
  try {
    const id = await saver.adopt(usePlayer.getState().piece);
    syncCurrent();
    const entry = await library.get(id);
    if (!entry) return false;
    const linked = { ...entry, file, fileSavedAt: undefined };
    await library.put(linked);
    await writeFile(linked);
    await refreshPieces();
    return true;
  } catch (e) {
    pushNotice('error', `Could not write ${file.name}`, [
      e instanceof Error ? e.message : String(e),
    ]);
    return false;
  }
}
