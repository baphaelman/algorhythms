import { useEffect, useId, useRef, useState } from 'react';
import { saveName, skipName, useNaming } from '../naming';

/**
 * The "name it before moving on" popup (PLAN.md §11.4). A native modal `<dialog>`, so focus is
 * trapped, Escape skips and focus returns to what opened it. Enter saves; Space types.
 */
export function NamePrompt() {
  const open = useNaming((s) => s.open);
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const id = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setText('');
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="dialog name-prompt"
      aria-labelledby={`${id}-title`}
      data-testid="name-prompt"
      onClose={() => {
        // Escape closes the dialog natively: that is Skip.
        if (useNaming.getState().open) skipName();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) skipName();
      }}
    >
      {open && (
        <form
          method="dialog"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            saveName(text);
          }}
        >
          <h2 id={`${id}-title`}>Name this piece?</h2>
          <p className="dialog-note">
            It is saved in My pieces under the name you give it. The other piece opens either way.
          </p>
          <div className="field">
            <label htmlFor={`${id}-name`}>Title</label>
            <input
              id={`${id}-name`}
              type="text"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="Untitled"
              value={text}
              data-testid="name-prompt-input"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="dialog-actions">
            <button type="button" data-testid="name-prompt-skip" onClick={skipName}>
              Skip
            </button>
            <button type="submit" className="primary" data-testid="name-prompt-save">
              Save name
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
