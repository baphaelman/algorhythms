import { useEffect, useId, useRef } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_FORM,
  checkForm,
  generateFromRequest,
  newSeed,
  type FieldErrors,
  type GenerateForm,
} from '../generate-options';
import { useEditor } from '../editor/history';
import { loadPiece, pushNotice } from '../store';
import { GenerateFields } from './GenerateFields';

interface GenerateUi {
  open: boolean;
  form: GenerateForm;
  errors: FieldErrors;
  /** Showing "Replace the current piece?" instead of the form. */
  confirming: boolean;
}

/** The panel's state. It outlives the dialog, so reopening it keeps the last choices. */
const useGenerateUi = create<GenerateUi>()(() => ({
  open: false,
  form: { ...DEFAULT_FORM, seed: String(newSeed()) },
  errors: {},
  confirming: false,
}));

/** Opens the Generate dialog (the ⋯ menu's Generate item calls this). */
export function openGenerate(): void {
  useGenerateUi.setState({ open: true, errors: {}, confirming: false });
}

function closeGenerate(): void {
  useGenerateUi.setState({ open: false, confirming: false });
}

function patch(p: Partial<GenerateForm>): void {
  useGenerateUi.setState((s) => ({ form: { ...s.form, ...p } }));
}

/**
 * Validates the form, generates, and opens the piece. Returns whether it did. An edited piece
 * (undo history is cleared by every load) is not replaced until the user confirms; autosave
 * (§11.4) has already put it in My pieces, so nothing is lost.
 */
export function runGenerate(confirmed = false): boolean {
  const { form } = useGenerateUi.getState();
  const check = checkForm(form, new Date().toISOString());
  if (!check.ok) {
    useGenerateUi.setState({ errors: check.errors });
    return false;
  }
  if (!confirmed && useEditor.getState().canUndo) {
    useGenerateUi.setState({ confirming: true, errors: {} });
    return false;
  }
  try {
    loadPiece(generateFromRequest(check.request), { source: 'generated' });
  } catch (e) {
    pushNotice('error', 'Could not generate a piece', [e instanceof Error ? e.message : String(e)]);
    return false;
  }
  useGenerateUi.setState({ open: false, errors: {}, confirming: false });
  return true;
}

/**
 * The Generate dialog (PLAN.md §11.3): seed, mode, length, voices and walk density. A native modal
 * `<dialog>`, so focus is trapped, Escape closes it and focus returns to what opened it.
 */
export function GeneratePanel() {
  const open = useGenerateUi((s) => s.open);
  const form = useGenerateUi((s) => s.form);
  const errors = useGenerateUi((s) => s.errors);
  const confirming = useGenerateUi((s) => s.confirming);
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
      {open && confirming && (
        <div role="alertdialog" aria-labelledby={`${id}-confirm`} data-testid="generate-confirm">
          <h2 id={`${id}-confirm`}>Replace the current piece?</h2>
          <p className="dialog-note">
            Your edits are saved in My pieces, so you can open this piece again later.
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              data-testid="generate-confirm-cancel"
              onClick={() => useGenerateUi.setState({ confirming: false })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              data-testid="generate-confirm-replace"
              onClick={() => runGenerate(true)}
            >
              Replace
            </button>
          </div>
        </div>
      )}
      {open && !confirming && (
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
            Composes a new piece from a seed. The same seed and settings always give the same piece.
          </p>

          <GenerateFields
            id={id}
            form={form}
            errors={errors}
            testPrefix="generate"
            onChange={(p) => {
              patch(p);
              if (p.seed !== undefined && errors.seed) useGenerateUi.setState({ errors: {} });
            }}
          />

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
