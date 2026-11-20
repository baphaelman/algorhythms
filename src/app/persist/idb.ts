/** My pieces in IndexedDB: database `algorhythms`, object store `pieces` keyed by `id`. */

import { byUpdated, type Library, type LibraryEntry } from './library';

const DB = 'algorhythms';
const STORE = 'pieces';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) {
        r.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB could not open'));
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

/** The IndexedDB library. Throws (from the first call) where IndexedDB is unavailable. */
export function idbLibrary(): Library {
  let db: Promise<IDBDatabase> | null = null;
  const run = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    db ??= openDb();
    const d = await db.catch((e: unknown) => {
      db = null;
      throw e;
    });
    const tx = d.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    done.catch(() => undefined); // a failed request rejects first; `done` is awaited only after
    const result = await req(fn(tx.objectStore(STORE)));
    await done;
    return result;
  };
  return {
    list: async () =>
      byUpdated(await run('readonly', (s) => s.getAll() as IDBRequest<LibraryEntry[]>)),
    get: (id) => run('readonly', (s) => s.get(id) as IDBRequest<LibraryEntry | undefined>),
    put: async (entry) => {
      await run('readwrite', (s) => s.put(entry));
    },
    delete: async (id) => {
      await run('readwrite', (s) => s.delete(id));
    },
  };
}
