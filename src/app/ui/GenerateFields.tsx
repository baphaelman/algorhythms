import {
  GENERATE_MODES,
  LENGTH_MAX,
  LENGTH_MIN,
  LENGTH_STEP,
  VOICES_MAX,
  VOICES_MIN,
  formatLength,
  newSeed,
  type FieldErrors,
  type GenerateForm,
} from '../generate-options';

interface Props {
  /** A unique id prefix for the labels. */
  id: string;
  form: GenerateForm;
  errors: FieldErrors;
  /** Test ids are `<testPrefix>-seed`, `-new-seed`, `-mode`, `-length`, `-natural`, `-voices`, `-density`. */
  testPrefix: string;
  onChange: (patch: Partial<GenerateForm>) => void;
}

/**
 * Generate's inputs (PLAN.md §11.3): seed, mode, length, notes and walk density. Shared by the
 * Generate dialog and the Compose for me panel.
 */
export function GenerateFields({ id, form, errors, testPrefix: tp, onChange }: Props) {
  return (
    <>
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
            data-testid={`${tp}-seed`}
            onChange={(e) => onChange({ seed: e.target.value })}
          />
          <button
            type="button"
            data-testid={`${tp}-new-seed`}
            onClick={() => onChange({ seed: String(newSeed()) })}
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
        <div className="seg radios" data-testid={`${tp}-mode`}>
          {GENERATE_MODES.map((m) => (
            <label key={m.id} className={form.mode === m.id ? 'on' : undefined}>
              <input
                type="radio"
                name={`${id}-mode`}
                value={m.id}
                checked={form.mode === m.id}
                onChange={() => onChange({ mode: m.id })}
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
            data-testid={`${tp}-length`}
            onChange={(e) => onChange({ length: Number(e.target.value) })}
          />
          <output htmlFor={`${id}-length`}>
            {form.naturalLength ? 'about 2:30' : formatLength(form.length)}
          </output>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={form.naturalLength}
            data-testid={`${tp}-natural`}
            onChange={(e) => onChange({ naturalLength: e.target.checked })}
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
        <label htmlFor={`${id}-voices`}>Notes</label>
        <div className="field-row">
          <input
            id={`${id}-voices`}
            type="range"
            min={VOICES_MIN}
            max={VOICES_MAX}
            step={1}
            value={form.voices}
            data-testid={`${tp}-voices`}
            onChange={(e) => onChange({ voices: Number(e.target.value) })}
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
            data-testid={`${tp}-density`}
            onChange={(e) => onChange({ density: Number(e.target.value) / 100 })}
          />
          <output htmlFor={`${id}-density`}>{Math.round(form.density * 100)}%</output>
        </div>
        <small>How often a note steps in the walking section.</small>
        {errors.density && (
          <small className="field-error" role="alert">
            {errors.density}
          </small>
        )}
      </div>
    </>
  );
}
