import { useEffect, useId, useRef, useState } from 'react';
import {
  closeMyPieces,
  deleteEntry,
  downloadAll,
  openEntry,
  usePersist,
  type PersistStatus,
} from '../persist';
import { evictsAfterAWeek, fileState, type FileState, type LibraryEntry } from '../persist/library';

const STATUS: Record<PersistStatus, string> = {
  unknown: 'Pieces are kept in this browser. Persistent storage is requested when you first save.',
  granted: 'Persistent storage granted: the browser will not clear these pieces to free space.',
  denied:
    'Persistent storage was not granted: the browser may clear these pieces if space runs low.',
  unsupported: 'This browser cannot promise to keep these pieces; it may clear them.',
};

const FILE: Record<FileState, string> = {
  none: 'not saved to a file',
  changed: 'changed since saved to a file',
  saved: 'saved to a file',
  linked: 'linked to a file',
};

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Row({ entry, current }: { entry: LibraryEntry; current: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const state = fileState(entry);
  return (
    <li data-testid="my-piece" aria-current={current ? 'true' : undefined}>
      <button
        type="button"
        className="piece-open"
        data-testid="my-piece-open"
        onClick={() => {
          if (openEntry(entry)) closeMyPieces();
        }}
      >
        <span className="piece-title">{entry.title}</span>
        <small>
          {when(entry.updated)}
          {' · '}
          <span className={state === 'none' || state === 'changed' ? 'piece-unsaved' : undefined}>
            {state === 'linked' && entry.file ? `linked to ${entry.file.name}` : FILE[state]}
          </span>
        </small>
      </button>
      {confirming ? (
        <span className="piece-confirm" role="group" aria-label={`Delete ${entry.title}?`}>
          <button
            type="button"
            className="danger"
            data-testid="my-piece-delete-confirm"
            onClick={() => void deleteEntry(entry.id)}
          >
            Delete
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Delete ${entry.title}`}
          data-testid="my-piece-delete"
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      )}
    </li>
  );
}

/** My pieces (PLAN.md §11.4): the autosaved pieces, with the eviction safeguards. */
export function MyPieces() {
  const open = usePersist((s) => s.open);
  const entries = usePersist((s) => s.entries);
  const status = usePersist((s) => s.status);
  const current = usePersist((s) => s.current);
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setMessage('');
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const unsaved = entries.filter((e) => fileState(e) === 'none' || fileState(e) === 'changed');

  return (
    <dialog
      ref={dialog}
      className="dialog my-pieces"
      aria-labelledby={`${id}-title`}
      data-testid="my-pieces"
      onClose={closeMyPieces}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeMyPieces();
      }}
    >
      {open && (
        <>
          <h2 id={`${id}-title`}>My pieces</h2>
          <p className="dialog-note" data-testid="persist-status" data-state={status}>
            {STATUS[status]}
          </p>
          {evictsAfterAWeek(navigator) && (
            <p className="dialog-note" data-testid="safari-note">
              Safari may delete these pieces if you don&apos;t visit this site for a week. Download
              them to keep them.
            </p>
          )}
          {entries.length === 0 ? (
            <p className="dialog-note" data-testid="my-pieces-empty">
              Nothing saved yet. A piece is saved here once you edit it, or make one with New or
              Generate.
            </p>
          ) : (
            <ul className="piece-list" aria-label="Saved pieces">
              {entries.map((e) => (
                <Row key={e.id} entry={e} current={e.id === current} />
              ))}
            </ul>
          )}
          {message && (
            <p className="dialog-note" aria-live="polite" data-testid="my-pieces-message">
              {message}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" data-testid="my-pieces-close" onClick={closeMyPieces}>
              Close
            </button>
            <button
              type="button"
              className="primary"
              disabled={entries.length === 0}
              data-testid="download-all"
              onClick={() => {
                void downloadAll().then((n) => {
                  if (n > 0)
                    setMessage(`Downloaded ${n} ${n === 1 ? 'piece' : 'pieces'} as a zip.`);
                });
              }}
            >
              Download all{unsaved.length > 0 ? ` (${unsaved.length} not in a file)` : ''}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
