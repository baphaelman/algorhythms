import { useEffect, useId, useRef } from 'react';
import { create } from 'zustand';
import { saveAsFile } from '../persist';
import { LONG_LINK_CHARS, encodeShareLink } from '../share';
import { usePlayer } from '../store';

interface ShareUi {
  open: boolean;
  /** The link for the piece as it was when the dialog opened ('' while it is being made). */
  link: string;
  error: string;
  copied: boolean;
}

const useShareUi = create<ShareUi>()(() => ({ open: false, link: '', error: '', copied: false }));

/** Opens the Share dialog with a link to the open piece (the menu's "Share link…" calls this). */
export function openShare(): void {
  const piece = usePlayer.getState().piece;
  useShareUi.setState({ open: true, link: '', error: '', copied: false });
  encodeShareLink(piece).then(
    (link) => useShareUi.setState({ link }),
    (e: unknown) => useShareUi.setState({ error: e instanceof Error ? e.message : String(e) }),
  );
}

function closeShare(): void {
  useShareUi.setState({ open: false });
}

/**
 * The Share dialog (PLAN.md §11.4): the piece's `#p=` link, ready to copy. A link longer than
 * about 2,000 characters gets a warning, since some chat apps cut long links, and offers the
 * piece as a file instead.
 */
export function ShareDialog() {
  const { open, link, error, copied } = useShareUi();
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const long = link.length > LONG_LINK_CHARS;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (link) field.current?.select();
  }, [link]);

  const copy = (): void => {
    field.current?.select();
    navigator.clipboard.writeText(link).then(
      () => useShareUi.setState({ copied: true }),
      () => useShareUi.setState({ error: 'Copying was blocked: select the link and copy it.' }),
    );
  };

  return (
    <dialog
      ref={dialog}
      className="dialog share"
      aria-labelledby={`${id}-title`}
      data-testid="share-dialog"
      onClose={closeShare}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeShare();
      }}
    >
      {open && (
        <>
          <h2 id={`${id}-title`}>Share link</h2>
          <p className="dialog-note">
            The whole piece is in the link, and nothing is uploaded. Later edits need a new link.
          </p>
          <div className="field">
            <label htmlFor={`${id}-link`}>Link</label>
            <textarea
              id={`${id}-link`}
              ref={field}
              readOnly
              rows={4}
              spellCheck={false}
              value={link}
              placeholder={error ? '' : 'Making the link…'}
              data-testid="share-link"
              onFocus={(e) => e.currentTarget.select()}
            />
            {link && (
              <small data-testid="share-length">
                {link.length.toLocaleString('en')} characters
              </small>
            )}
            {error && <small className="field-error">{error}</small>}
          </div>
          {long && (
            <p className="share-long" role="status" data-testid="share-long">
              This link is longer than {LONG_LINK_CHARS.toLocaleString('en')} characters, and some
              chat apps cut long links. A file is safer.
            </p>
          )}
          <div className="dialog-actions">
            {long && (
              <button
                type="button"
                data-testid="share-save-file"
                onClick={() => {
                  closeShare();
                  void saveAsFile();
                }}
              >
                Save as file…
              </button>
            )}
            <button type="button" data-testid="share-close" onClick={closeShare}>
              Close
            </button>
            <button
              type="button"
              className="primary"
              data-testid="share-copy"
              disabled={!link}
              onClick={copy}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
