/**
 * The Look panel's Colours group (PLAN.md §12 "Exports you can shape" → Colours): schemes,
 * background, lines and a swatch per element. Each swatch is the browser's colour picker with a
 * hex field beside it; a one-line warning shows when HUD text or labels have under 3:1 contrast
 * with the background. Pure view: the dialog passes the form and the patch functions.
 */

import { useId, useState, type KeyboardEvent } from 'react';
import { mixHex, toHex } from '../../render/colours';
import { tokensOf } from '../../render/palettes';
import type { ThemeTokens } from '../../render/types';
import {
  BACKGROUND_MODES,
  BUILTIN_SCHEMES,
  DEFAULT_COLOURS,
  ELEMENT_SWATCHES,
  LINE_MODES,
  contrastWarning,
  deleteScheme,
  parseHex,
  partSwatch,
  partsOf,
  pitchEnds,
  saveScheme,
  schemeOf,
  swatchValue,
  type BackgroundMode,
  type ColourScheme,
  type ColoursForm,
} from '../export-colours';
import type { LookForm } from '../export-options';
import { GradientFields, PictureFields } from './BackgroundFields';
import type { LookKind } from '../look-controls';
import { usePlayer } from '../store';

/** Segmented buttons (radios) in the Look grid, as the Look's own segments. */
export function Segs<T extends string>({
  label,
  testId,
  value,
  options,
  onChange,
}: {
  label: string;
  testId: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <>
      <span className="look-label" id={`${id}-label`}>
        {label}
      </span>
      <div
        className="seg radios look-seg"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        data-testid={testId}
        data-value={value}
      >
        {options.map((o) => (
          <label key={o.id} className={value === o.id ? 'on' : undefined}>
            <input
              type="radio"
              name={`${id}-r`}
              value={o.id}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

/**
 * One colour: a label, the colour picker, its hex (typed: applied once valid, Enter or blur;
 * Escape reverts) and, when set, a button back to the default.
 */
export function Swatch({
  label,
  value,
  set,
  testId,
  hint,
  onChange,
}: {
  label: string;
  /** The shown colour, #rrggbb. */
  value: string;
  /** False while the swatch draws its default. */
  set: boolean;
  testId: string;
  hint?: string;
  onChange: (hex: string | null) => void;
}) {
  const id = useId();
  // The typed text, kept while it belongs to the shown colour (a new colour resets it).
  const [draft, setDraft] = useState({ of: value, text: value });
  const text = draft.of === value ? draft.text : value;
  const setText = (t: string) => setDraft({ of: value, text: t });
  const commit = () => {
    const h = parseHex(text);
    if (h && h !== value) onChange(h);
    else setText(value);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && text !== value) {
      e.preventDefault();
      e.stopPropagation();
      setText(value);
    }
  };
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="field-row swatch" data-testid={testId} data-set={set ? 'yes' : 'no'}>
        <input
          id={id}
          type="color"
          value={value}
          data-testid={`${testId}-pick`}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
        <input
          type="text"
          className="swatch-hex"
          aria-label={`${label} hex`}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          value={text}
          data-testid={`${testId}-hex`}
          onChange={(e) => {
            setText(e.target.value);
            const h = parseHex(e.target.value);
            if (h && e.target.value.trim().length >= 7 && h !== value) onChange(h);
          }}
          onBlur={commit}
          onKeyDown={onKey}
        />
        {set ? (
          <button
            type="button"
            className="swatch-reset"
            aria-label={`${label}: back to the default`}
            data-testid={`${testId}-reset`}
            onClick={() => onChange(null)}
          >
            Default
          </button>
        ) : (
          hint && <small className="swatch-hint">{hint}</small>
        )}
      </div>
    </>
  );
}

const hex = (c: string) => toHex(c) ?? '#000000';

/** The scheme picker: Theme, the built-ins, the saved ones (each deletable), Custom. */
function Schemes({
  colours,
  saved,
  onApply,
  onSaved,
}: {
  colours: ColoursForm;
  saved: readonly ColourScheme[];
  onApply: (c: ColoursForm) => void;
  onSaved: (list: ColourScheme[]) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const active = schemeOf(colours, saved);
  const button = (key: string, label: string, c: ColoursForm, testId: string) => (
    <button
      key={key}
      type="button"
      className={active === key ? 'scheme on' : 'scheme'}
      aria-pressed={active === key}
      data-testid={testId}
      onClick={() => onApply(c)}
    >
      {label}
    </button>
  );
  const save = () => {
    const n = name.trim();
    if (!n) return;
    onSaved(saveScheme(saved, n, colours));
    setName('');
  };
  return (
    <>
      <span className="look-label" id={`${id}-label`}>
        Scheme
      </span>
      <div
        className="schemes"
        role="group"
        aria-labelledby={`${id}-label`}
        data-testid="colours-scheme"
        data-value={active}
      >
        {button('theme', 'Theme', DEFAULT_COLOURS, 'scheme-theme')}
        {BUILTIN_SCHEMES.map((s) => button(s.id, s.name, s.colours, `scheme-${s.id}`))}
        {saved.map((s) => (
          <span key={`saved:${s.name}`} className="scheme-saved">
            {button(`saved:${s.name}`, s.name, s.colours, `scheme-saved-${s.name}`)}
            <button
              type="button"
              className="scheme-delete"
              aria-label={`Delete scheme ${s.name}`}
              data-testid={`scheme-delete-${s.name}`}
              onClick={() => onSaved(deleteScheme(saved, s.name))}
            >
              ×
            </button>
          </span>
        ))}
        {active === 'custom' && (
          <span className="scheme on custom" data-testid="scheme-custom">
            Custom
          </span>
        )}
      </div>
      <label htmlFor={`${id}-name`}>Save as</label>
      <div className="field-row scheme-save">
        <input
          id={`${id}-name`}
          type="text"
          placeholder="Scheme name"
          maxLength={40}
          value={name}
          data-testid="colours-scheme-name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
        />
        <button
          type="button"
          disabled={!name.trim()}
          data-testid="colours-scheme-save"
          onClick={save}
        >
          Save
        </button>
      </div>
    </>
  );
}

export function ColoursGroup({
  look,
  kind,
  dark,
  saved,
  onLook,
  onSaved,
}: {
  look: LookForm;
  kind: LookKind;
  /** The theme the export draws with. */
  dark: boolean;
  saved: readonly ColourScheme[];
  onLook: (p: Partial<LookForm>) => void;
  onSaved: (list: ColourScheme[]) => void;
}) {
  const id = useId();
  const c = look.colours;
  const t: ThemeTokens = tokensOf(dark ? 'dark' : 'light');
  const voices = usePlayer((s) => s.piece.voices);
  const set = (p: Partial<ColoursForm>) => onLook({ colours: { ...c, ...p } });
  const transparent = kind === 'poster' && look.transparent;
  const bgMode: BackgroundMode = transparent ? 'transparent' : c.background;
  const modes = BACKGROUND_MODES.filter((m) => kind === 'poster' || m.id !== 'transparent');
  const [lo, hi] = pitchEnds(dark);
  const parts = partsOf(voices.map((v) => v.part));
  const warning = contrastWarning(c, t, transparent);

  return (
    <div className="colours" role="group" aria-labelledby={`${id}-title`} data-testid="colours">
      <h3 className="colours-title" id={`${id}-title`}>
        Colours
      </h3>
      <div className="look-grid">
        <Schemes
          colours={c}
          saved={saved}
          onApply={(colours) => onLook({ colours, transparent: false })}
          onSaved={onSaved}
        />
        <Segs
          label="Background"
          testId="look-bg"
          value={bgMode}
          options={modes}
          onChange={(m) =>
            m === 'transparent'
              ? onLook({ transparent: true })
              : onLook({ transparent: false, colours: { ...c, background: m } })
          }
        />
        {bgMode === 'solid' && (
          <Swatch
            label="Background colour"
            testId="swatch-bg"
            value={c.bg ?? hex(t.paper)}
            set={c.bg !== null}
            onChange={(bg) => set({ bg })}
          />
        )}
        {bgMode === 'gradient' && <GradientFields c={c} t={t} set={set} />}
        {kind === 'poster' && <PictureFields />}
        <Segs
          label="Lines"
          testId="look-colors"
          value={c.lines}
          options={LINE_MODES}
          onChange={(lines) => set({ lines })}
        />
        {c.lines === 'pitch' && (
          <>
            <Swatch
              label="Low notes"
              testId="swatch-low"
              value={c.low ?? lo}
              set={c.low !== null}
              onChange={(low) => set({ low })}
            />
            <Swatch
              label="Middle"
              testId="swatch-mid"
              value={c.mid ?? mixHex(c.low ?? lo, c.high ?? hi, 0.5)}
              set={c.mid !== null}
              hint="optional"
              onChange={(mid) => set({ mid })}
            />
            <Swatch
              label="High notes"
              testId="swatch-high"
              value={c.high ?? hi}
              set={c.high !== null}
              onChange={(high) => set({ high })}
            />
          </>
        )}
        {c.lines === 'part' &&
          parts.map((p, k) => (
            <Swatch
              key={p}
              label={p ? `Part ${p}` : parts.length > 1 ? 'No part' : 'All lines'}
              testId={`swatch-part-${k}`}
              value={partSwatch(c, parts, p, dark)}
              set={c.parts[p] !== undefined}
              onChange={(v) => {
                const next = { ...c.parts };
                if (v) next[p] = v;
                else delete next[p];
                set({ parts: next });
              }}
            />
          ))}
        {c.lines === 'one' && (
          <Swatch
            label="Line colour"
            testId="swatch-one"
            value={c.one ?? hex(t.ink)}
            set={c.one !== null}
            onChange={(one) => set({ one })}
          />
        )}
        {c.lines !== 'app' && (
          <small className="look-note">Colours set in the notes drawer still apply.</small>
        )}
        {ELEMENT_SWATCHES.map((s) => (
          <Swatch
            key={s.key}
            label={s.label}
            testId={`swatch-${s.key}`}
            value={swatchValue(c, s.key, t)}
            set={c[s.key] !== null}
            {...(s.hint ? { hint: s.hint } : {})}
            onChange={(v) => set({ [s.key]: v })}
          />
        ))}
      </div>
      {warning && (
        <p className="colours-warning" role="status" data-testid="colours-warning">
          {warning}
        </p>
      )}
    </div>
  );
}
