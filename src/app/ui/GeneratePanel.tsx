import { useEffect, useId, useRef } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_FORM,
  GENERATE_MODES,
  LENGTH_MAX,
  LENGTH_MIN,
  LENGTH_STEP,
  VOICES_MAX,
  VOICES_MIN,
  checkForm,
  formatLength,
  generateFromRequest,
  newSeed,
  type FieldErrors,
  type GenerateForm,
} from '../generate-options';
import { useEditor } from '../editor/history';
import { loadPiece, pushNotice } from '../store';

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

          <div className="field">
            <label htmlFor={`${id}-seed`}>Seed</label>
            <div className="field-row">
              <input
                id={`${id}-seed`}
                type="text"
                value={form.seed}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.seed ? true : undefined}
                aria-describedby={`${id}-seed-hint${errors.seed ? ` ${id}-seed-err` : ''}`}
                data-testid="generate-seed"
                onChange={(e) => {
                  patch({ seed: e.target.value });
                  if (errors.seed) useGenerateUi.setState({ errors: {} });
                }}
              />
              <button
                type="button"
                data-testid="generate-new-seed"
                onClick={() => {
                  patch({ seed: String(newSeed()) });
                  useGenerateUi.setState({ errors: {} });
                }}
              >
                New seed
              </button>
            </div>
            <small id={`${id}-seed-hint`}>A number, or any text.</small>
            {errors.seed && (
              <small id={`${id}-seed-err`} className="field-error" role="alert">
                {errors.seed}
              </small>
            )}
          </div>

          <fieldset className="field">
            <legend>Mode</legend>
            <div className="seg radios" data-testid="generate-mode">
              {GENERATE_MODES.map((m) => (
                <label key={m.id} className={form.mode === m.id ? 'on' : undefined}>
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    value={m.id}
                    checked={form.mode === m.id}
                    onChange={() => patch({ mode: m.id })}
                  />
                  <span>{m.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor={`${id}-length`}>Length</label>
            <div className="field-row">
              <input
                id={`${id}-length`}
                type="range"
                min={LENGTH_MIN}
                max={LENGTH_MAX}
                step={LENGTH_STEP}
                value={form.length}
                disabled={form.naturalLength}
                aria-valuetext={formatLength(form.length)}
                data-testid="generate-length"
                onChange={(e) => patch({ length: Number(e.target.value) })}
              />
              <output htmlFor={`${id}-length`}>
                {form.naturalLength ? 'about 2:30' : formatLength(form.length)}
              </output>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={form.naturalLength}
                data-testid="generate-natural"
                onChange={(e) => patch({ naturalLength: e.target.checked })}
              />
              <span>Natural length (the prototype&rsquo;s proportions)</span>
            </label>
            {errors.length && (
              <small className="field-error" role="alert">
                {errors.length}
              </small>
            )}
          </div>

          <div className="field">
            <label htmlFor={`${id}-voices`}>Voices</label>
            <div className="field-row">
              <input
                id={`${id}-voices`}
                type="range"
                min={VOICES_MIN}
                max={VOICES_MAX}
                step={1}
                value={form.voices}
                data-testid="generate-voices"
                onChange={(e) => patch({ voices: Number(e.target.value) })}
              />
              <output htmlFor={`${id}-voices`}>{form.voices}</output>
            </div>
            {errors.voices && (
              <small className="field-error" role="alert">
                {errors.voices}
              </small>
            )}
          </div>

          <div className="field">
            <label htmlFor={`${id}-density`}>Walk density</label>
            <div className="field-row">
              <input
                id={`${id}-density`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(form.density * 100)}
                aria-valuetext={`${Math.round(form.density * 100)} percent`}
                data-testid="generate-density"
                onChange={(e) => patch({ density: Number(e.target.value) / 100 })}
              />
              <output htmlFor={`${id}-density`}>{Math.round(form.density * 100)}%</output>
            </div>
            <small>How often a voice steps in the walking section.</small>
            {errors.density && (
              <small className="field-error" role="alert">
                {errors.density}
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
