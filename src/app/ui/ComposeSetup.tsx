import { useEffect, useId, useRef, useState } from 'react';
import { PROGRESSIONS } from '../../core/compose-brief';
import { closeSetup, runCompose, setComposeAnswers, useCompose } from '../compose';
import {
  KEY_SCALES,
  LENGTHS,
  MOODS,
  PARTS,
  SHAPES,
  SURPRISE,
  TEMPO_MAX,
  TEMPO_MIN,
  TONICS,
  shownAnswers,
  type ComposeAnswers,
  type StartAnswer,
} from '../compose-setup';
import './compose.css';

const SURPRISE_LABEL = 'Surprise me';

interface ChipsProps<T> {
  name: string;
  label: string;
  testId: string;
  options: readonly { id: T; label: string }[];
  value: T | typeof SURPRISE;
  onChange: (v: T | typeof SURPRISE) => void;
}

/** One question as a row of radio chips, Surprise me first. */
function Chips<T extends string | number>({
  name,
  label,
  testId,
  options,
  value,
  onChange,
}: ChipsProps<T>) {
  const all: { id: T | typeof SURPRISE; label: string }[] = [
    { id: SURPRISE, label: SURPRISE_LABEL },
    ...options,
  ];
  return (
    <fieldset className="setup-q" data-testid={testId}>
      <legend>{label}</legend>
      <div className="chips">
        {all.map((o) => (
          <label key={String(o.id)} className={value === o.id ? 'on' : undefined}>
            <input
              type="radio"
              name={name}
              value={String(o.id)}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function startValue(s: StartAnswer): string {
  return typeof s === 'string' ? s : `p:${s.progression}`;
}

function parseStart(v: string): StartAnswer {
  if (v.startsWith('p:')) return { progression: v.slice(2) };
  return v === 'none' || v === 'melody' ? v : SURPRISE;
}

/**
 * Compose for me's setup screen (PLAN.md §11.3 "Compose for me, directed", M12): five questions,
 * each Surprise me by default, and More (key and scale, tempo). A native modal `<dialog>`: focus
 * is trapped, Escape closes it, Compose has the focus (Enter composes).
 */
export function ComposeSetup() {
  const open = useCompose((s) => s.setup);
  const answers = useCompose((s) => s.answers);
  const hasMelody = useCompose((s) => s.hasMelody);
  const a = shownAnswers(answers, hasMelody);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Compose has the focus: with every answer kept, Enter composes.
      d.querySelector<HTMLButtonElement>('[data-testid="compose-run"]')?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="dialog compose-setup"
      aria-labelledby={`${id}-title`}
      data-testid="compose-setup"
      onClose={closeSetup}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSetup();
      }}
    >
      {open && (
        <form
          method="dialog"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            runCompose();
          }}
          onKeyDown={(e) => {
            // Enter on a chip composes too (radios and checkboxes don't submit by themselves).
            const t = e.target as HTMLInputElement;
            if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type !== 'number') {
              e.preventDefault();
              runCompose();
            }
          }}
        >
          <h2 id={`${id}-title`}>Compose for me</h2>
          <Chips
            name={`${id}-mood`}
            label="Mood"
            testId="compose-mood"
            options={MOODS}
            value={a.mood}
            onChange={(mood) => setComposeAnswers({ mood })}
          />
          <Chips
            name={`${id}-length`}
            label="Length"
            testId="compose-length"
            options={LENGTHS}
            value={a.length}
            onChange={(length) => setComposeAnswers({ length })}
          />
          <Chips
            name={`${id}-shape`}
            label="Shape"
            testId="compose-shape"
            options={SHAPES}
            value={a.shape}
            onChange={(shape) => setComposeAnswers({ shape })}
          />
          <fieldset className="setup-q" data-testid="compose-parts">
            <legend>Parts</legend>
            <div className="chips">
              <label className={a.parts === SURPRISE ? 'on' : undefined}>
                <input
                  type="checkbox"
                  checked={a.parts === SURPRISE}
                  onChange={() => setComposeAnswers({ parts: SURPRISE })}
                />
                <span>{SURPRISE_LABEL}</span>
              </label>
              {PARTS.map((p) => {
                const on = a.parts !== SURPRISE && a.parts.includes(p.id);
                return (
                  <label key={p.id} className={on ? 'on' : undefined}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const now = a.parts === SURPRISE ? [] : a.parts;
                        const next = on ? now.filter((x) => x !== p.id) : [...now, p.id];
                        setComposeAnswers({ parts: next.length > 0 ? next : SURPRISE });
                      }}
                    />
                    <span>{p.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="setup-q">
            <label htmlFor={`${id}-start`}>Start from</label>
            <select
              id={`${id}-start`}
              data-testid="compose-start"
              value={startValue(a.start)}
              onChange={(e) => setComposeAnswers({ start: parseStart(e.target.value) })}
            >
              <option value={SURPRISE}>{SURPRISE_LABEL}</option>
              <option value="none">Nothing</option>
              {hasMelody && <option value="melody">The open piece&rsquo;s melody</option>}
              <optgroup label="Chord progression">
                {PROGRESSIONS.map((p) => (
                  <option key={p.name} value={`p:${p.name}`}>
                    {p.name} ({p.nick})
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <More id={id} a={a} />
          <div className="dialog-actions">
            <button type="button" onClick={closeSetup}>
              Cancel
            </button>
            <button type="submit" className="primary" data-testid="compose-run">
              Compose
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** More (collapsed): key and scale, tempo. It starts open when it holds an answer. */
function More({ id, a }: { id: string; a: ComposeAnswers }) {
  const [startOpen] = useState(() => a.tonic !== SURPRISE || a.tempo !== SURPRISE);
  // The typed text: a tempo out of range (mid-typing) counts as Surprise but stays shown.
  const [tempo, setTempo] = useState(() => (a.tempo === SURPRISE ? '' : String(a.tempo)));
  return (
    <details className="setup-more" data-testid="compose-more" open={startOpen}>
      <summary>More</summary>
      <div className="setup-more-grid">
        <label htmlFor={`${id}-key`}>Key</label>
        <div className="setup-key">
          <select
            id={`${id}-key`}
            data-testid="compose-key"
            value={String(a.tonic)}
            onChange={(e) =>
              setComposeAnswers({
                tonic: e.target.value === SURPRISE ? SURPRISE : Number(e.target.value),
              })
            }
          >
            <option value={SURPRISE}>{SURPRISE_LABEL}</option>
            {TONICS.map((t, i) => (
              <option key={t} value={i}>
                {t}
              </option>
            ))}
          </select>
          <select
            aria-label="Scale"
            data-testid="compose-scale"
            value={a.scale}
            disabled={a.tonic === SURPRISE}
            onChange={(e) => setComposeAnswers({ scale: e.target.value })}
          >
            {KEY_SCALES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <label htmlFor={`${id}-tempo`}>Tempo</label>
        <div className="setup-tempo">
          <input
            id={`${id}-tempo`}
            type="number"
            inputMode="numeric"
            min={TEMPO_MIN}
            max={TEMPO_MAX}
            step={1}
            placeholder="From the mood"
            data-testid="compose-tempo"
            value={tempo}
            onChange={(e) => {
              setTempo(e.target.value);
              const v = Number(e.target.value);
              setComposeAnswers({
                tempo:
                  e.target.value !== '' && v >= TEMPO_MIN && v <= TEMPO_MAX
                    ? Math.round(v)
                    : SURPRISE,
              });
            }}
          />
          <span>bpm</span>
        </div>
      </div>
    </details>
  );
}
