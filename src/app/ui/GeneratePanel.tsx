import { useEffect, useId, useRef } from 'react';
import { create } from 'zustand';
import { checkSeed, generateFromBrief, newSeed } from '../generate-options';
import { loadPiece, pushNotice, runOpen } from '../store';

interface GenerateUi {
  open: boolean;
  seed: string;
  error: string | null;
}

/** The panel's state. It outlives the dialog, so reopening it keeps the last seed. */
const useGenerateUi = create<GenerateUi>()(() => ({
  open: false,
  seed: String(newSeed()),
  error: null,
}));

/** Opens the Generate dialog (the ⋯ menu's Generate item calls this). */
export function openGenerate(): void {
  useGenerateUi.setState({ open: true, error: null });
}

function closeGenerate(): void {
  useGenerateUi.setState({ open: false });
}

/**
 * Composes from the seed with every answer on Surprise me (PLAN.md §15 M12) and opens the finished
 * piece in one load. Returns whether it started to (true also when the "name it" question comes
 * first). Opening never warns: the open piece is autosaved (§11.4); an edited, unnamed one is only
 * offered a name (naming.ts).
 */
export function runGenerate(): boolean {
  const check = checkSeed(useGenerateUi.getState().seed);
  if (!check.ok) {
    useGenerateUi.setState({ error: check.error });
    return false;
  }
  runOpen(() => {
    try {
      loadPiece(generateFromBrief(check.brief, new Date().toISOString()), {
        source: 'generated',
      });
    } catch (e) {
      pushNotice('error', 'Could not generate a piece', [
        e instanceof Error ? e.message : String(e),
      ]);
      return;
    }
    useGenerateUi.setState({ open: false, error: null });
  });
  return true;
}

/**
 * The Generate dialog (PLAN.md §11.3): a seed and Generate. A native modal `<dialog>`, so focus is
 * trapped, Escape closes it and focus returns to what opened it.
 */
export function GeneratePanel() {
  const open = useGenerateUi((s) => s.open);
  const seed = useGenerateUi((s) => s.seed);
  const error = useGenerateUi((s) => s.error);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="dialog generate"
      aria-labelledby={`${id}-title`}
      data-testid="generate-panel"
      onClose={closeGenerate}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) closeGenerate();
      }}
    >
      {open && (
        <form
          method="dialog"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            runGenerate();
          }}
        >
          <h2 id={`${id}-title`}>Generate a piece</h2>
          <p className="dialog-note">
            Composes a surprise piece from a seed. The same seed always gives the same piece; New →
            Compose for me lets you choose what it composes.
          </p>

          <div className="field">
            <label htmlFor={`${id}-seed`}>Seed</label>
            <div className="field-row">
              <input
                id={`${id}-seed`}
                type="text"
                value={seed}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-seed-hint${error ? ` ${id}-seed-err` : ''}`}
                data-testid="generate-seed"
                onChange={(e) => useGenerateUi.setState({ seed: e.target.value, error: null })}
              />
              <button
                type="button"
                data-testid="generate-new-seed"
                onClick={() => useGenerateUi.setState({ seed: String(newSeed()), error: null })}
              >
                New seed
              </button>
            </div>
            <small id={`${id}-seed-hint`}>A number, or any text.</small>
            {error && (
              <small id={`${id}-seed-err`} className="field-error" role="alert">
                {error}
              </small>
            )}
          </div>

          <div className="dialog-actions">
            <button type="button" onClick={closeGenerate}>
              Cancel
            </button>
            <button type="submit" className="primary" data-testid="generate-run">
              Generate
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
