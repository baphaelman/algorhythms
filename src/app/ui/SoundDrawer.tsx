/**
 * The Sound drawer (PLAN.md §11.3): pick a timbre and edit it (partials, stretch, brightness,
 * FM, strike partials, noise, accent, articulation, vibrato), save it as a preset file, or load
 * one into notes; and the piece's master FX (editor/mix-edit.ts).
 * Wide layout only. Edits apply live through the store's recompile and hot-swap; a slider drag is
 * one undo entry, a keyboard step one each (editor/timbre-edit.ts). Editing a built-in stores an
 * edited copy in the piece under its name; Revert puts the built-in's values back. The piece's own
 * timbres can be renamed (notes and timbre moments follow) and deleted when no note uses them.
 */

import { Fragment, useRef, useState, type ReactNode } from 'react';
import {
  parseTimbrePreset,
  serializeTimbrePreset,
  timbrePresetFileName,
} from '../../core/timbre-preset';
import { BUILTIN_TIMBRES } from '../../core/timbres';
import type { MixSettings, Timbre, ViewSettings } from '../../core/types';
import { downloadBlob } from '../download';
import { edit, type Recipe } from '../editor/history';
import {
  DELAY_TIME,
  delayTimeAt,
  formatDelay,
  formatMix,
  isSectionDefault,
  MIX_CONTROLS,
  mixValue,
  normaliseOf,
  resetSection,
  setMixAt,
  setNormalise,
  setPanAuto,
  type MixControl,
  type MixSection,
} from '../editor/mix-edit';
import {
  addPartial,
  addStrikePartial,
  beginTimbreDrag,
  deleteTimbre,
  dragTimbre,
  duplicateTimbre,
  editedName,
  endTimbreDrag,
  formatValue,
  isCustom,
  isModified,
  loadPreset,
  MAX_PARTIALS,
  MAX_STRIKE_PARTIALS,
  PARTIAL_CONTROL,
  positionOf,
  removePartial,
  removeStrikePartial,
  roundFor,
  renameTimbre,
  revertTimbre,
  selectSoundTab,
  selectTimbre,
  setAt,
  setFmOn,
  setHarmonic,
  setNoiseOn,
  setStrike,
  setStrikePartial,
  SLIDER_STEPS,
  STRETCH_PARTIALS,
  STRIKE_CONTROLS,
  strikeOf,
  TIMBRE_CONTROLS,
  timbreIn,
  timbreMoments,
  timbreRecipe,
  timbreRenameError,
  timbreUsers,
  toggleSoundDrawer,
  useSoundDrawer,
  valueAt,
  valueOf,
  type LoadTarget,
  type SliderControl,
  type SoundTab,
  type Strike,
  type StrikeField,
  type TimbreControl,
  type TimbreFn,
} from '../editor/timbre-edit';
import { hasParts } from '../editor/parts';
import { timbreOptions } from '../editor/voices';
import { pushNotice, usePlayer } from '../store';
import { useVoicesDrawer } from './VoicesDrawer';
import './sound.css';

// One bottom drawer at a time: opening Notes closes Sound and the other way round.
useVoicesDrawer.subscribe((s, prev) => {
  if (s.open && !prev.open) toggleSoundDrawer(false);
});
useSoundDrawer.subscribe((s, prev) => {
  if (s.open && !prev.open) useVoicesDrawer.setState({ open: false });
});

/** The view-bar button that opens the drawer (hidden in the narrow player layout by CSS). */
export function SoundToggle() {
  const open = useSoundDrawer((s) => s.open);
  return (
    <button
      type="button"
      className="toggle sound-toggle"
      aria-pressed={open}
      aria-controls="sound-drawer"
      data-testid="sound-toggle"
      onClick={() => toggleSoundDrawer()}
    >
      Sound
    </button>
  );
}

/**
 * A range input (positions 0..SLIDER_STEPS) whose pointer drag is one undo entry (coalesced to a
 * frame) and whose keyboard step is one entry. `recipeAt` gets the position and whether Alt is
 * held (free values where a slider snaps). `vertical` draws it upright (partials).
 */
function GestureRange(props: {
  position: number;
  text: string;
  label: string;
  testId: string;
  disabled?: boolean;
  vertical?: boolean;
  recipeAt: (pos: number, alt: boolean) => Recipe;
}) {
  const { position, text, label, testId, disabled, vertical, recipeAt } = props;
  const dragging = useRef(false);
  const alt = useRef(false);
  return (
    <input
      type="range"
      className={vertical ? 'sd-vertical' : undefined}
      min={0}
      max={SLIDER_STEPS}
      step={1}
      value={position}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={text}
      aria-orientation={vertical ? 'vertical' : undefined}
      data-testid={testId}
      onKeyDown={(e) => {
        alt.current = e.altKey;
      }}
      onPointerDown={(e) => {
        dragging.current = true;
        alt.current = e.altKey;
        beginTimbreDrag(label);
        const move = (ev: PointerEvent): void => {
          alt.current = ev.altKey;
        };
        window.addEventListener('pointermove', move);
        window.addEventListener(
          'pointerup',
          () => {
            dragging.current = false;
            window.removeEventListener('pointermove', move);
            endTimbreDrag();
          },
          { once: true },
        );
      }}
      onChange={(e) => {
        const recipe = recipeAt(Number(e.target.value), alt.current);
        if (dragging.current) dragTimbre(recipe);
        else edit(recipe, label);
      }}
    />
  );
}

/** A timbre slider on control `ctl`; `fn` makes the edit from the new value. */
function Slider(props: {
  ctl: TimbreControl;
  value: number | undefined;
  name: string;
  label: string;
  testId: string;
  disabled?: boolean;
  vertical?: boolean;
  fn: (x: number) => TimbreFn;
}) {
  const { ctl, value, name, fn, ...rest } = props;
  return (
    <GestureRange
      {...rest}
      position={positionOf(ctl, value ?? 0)}
      text={formatValue(ctl, value)}
      recipeAt={(pos) => timbreRecipe(name, fn(valueOf(ctl, pos)))}
    />
  );
}

function Row({
  ctl,
  timbre,
  name,
  disabled,
}: {
  ctl: TimbreControl;
  timbre: Timbre;
  name: string;
  disabled?: boolean;
}) {
  const value = valueAt(timbre, ctl.path) ?? ctl.fallback;
  return (
    <label className="sd-row">
      <span className="sd-label">{ctl.label}</span>
      <Slider
        ctl={ctl}
        value={value}
        name={name}
        label={ctl.label}
        testId={`ts-${ctl.id}`}
        disabled={disabled}
        fn={(x) => setAt(ctl.path, x)}
      />
      <output className="sd-out" data-testid={`ts-${ctl.id}-out`}>
        {formatValue(ctl, value ?? (disabled ? undefined : 0))}
      </output>
    </label>
  );
}

function Section({
  title,
  section,
  timbre,
  name,
  toggle,
  children,
}: {
  title: string;
  section: TimbreControl['section'];
  timbre: Timbre;
  name: string;
  /** An on/off switch for an optional section (FM, noise). */
  toggle?: { on: boolean; set: (on: boolean) => TimbreFn };
  children?: ReactNode;
}) {
  const off = toggle !== undefined && !toggle.on;
  return (
    <fieldset className="sd-section" data-section={section}>
      <legend>
        {toggle ? (
          <label className="sd-switch">
            <input
              type="checkbox"
              checked={toggle.on}
              data-testid={`ts-${section}-on`}
              onChange={(e) =>
                edit(timbreRecipe(name, toggle.set(e.target.checked)), `${title} on/off`)
              }
            />
            {title}
          </label>
        ) : (
          title
        )}
      </legend>
      {TIMBRE_CONTROLS.filter((c) => c.section === section).map((c) => (
        <Row key={c.id} ctl={c} timbre={timbre} name={name} disabled={off} />
      ))}
      {children}
    </fieldset>
  );
}

function Partials({ timbre, name }: { timbre: Timbre; name: string }) {
  const h = timbre.harmonics;
  const stretched = timbre.stretch !== 0;
  return (
    <fieldset className="sd-section sd-partials" data-section="partials">
      <legend>Partials</legend>
      <div className="sd-bars" role="group" aria-label="Partial amplitudes">
        {h.map((a, i) => (
          <span
            key={i}
            className={`sd-bar${stretched && i >= STRETCH_PARTIALS ? ' sd-unused' : ''}`}
            title={
              stretched && i >= STRETCH_PARTIALS
                ? 'Not played: stretched timbres play 16'
                : undefined
            }
          >
            <Slider
              ctl={PARTIAL_CONTROL}
              value={a}
              name={name}
              label={`Partial ${i + 1}`}
              testId={`harmonic-${i + 1}`}
              vertical
              fn={(x) => setHarmonic(i, x)}
            />
            <span className="sd-bar-n" aria-hidden="true">
              {i + 1}
            </span>
          </span>
        ))}
      </div>
      <div className="sd-bar-buttons">
        <button
          type="button"
          className="sd-mini"
          aria-label="Remove the top partial"
          data-testid="partial-remove"
          disabled={h.length <= 1}
          onClick={() => edit(timbreRecipe(name, removePartial), 'Remove partial')}
        >
          −
        </button>
        <span className="sd-count">{h.length}</span>
        <button
          type="button"
          className="sd-mini"
          aria-label="Add a partial"
          data-testid="partial-add"
          disabled={h.length >= MAX_PARTIALS}
          onClick={() => edit(timbreRecipe(name, addPartial), 'Add partial')}
        >
          +
        </button>
      </div>
    </fieldset>
  );
}

/**
 * A decimal number field that commits on Enter, blur or a stepper/arrow step (clamped and rounded
 * to `ctl`), not on every keystroke. Escape reverts; an outside change drops a typed draft.
 */
function DecimalField(props: {
  ctl: SliderControl;
  value: number;
  label: string;
  testId: string;
  onCommit: (x: number) => void;
}) {
  const { ctl, value, label, testId, onCommit } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(null);
  }
  const commit = (text: string): void => {
    setDraft(null);
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) onCommit(roundFor(ctl, n));
  };
  return (
    <input
      type="number"
      className="sd-num"
      inputMode="decimal"
      min={ctl.min}
      max={ctl.max}
      step={ctl.step}
      aria-label={label}
      data-testid={testId}
      value={draft ?? String(value)}
      onChange={(e) => {
        // Steppers and arrow keys fire a plain `input` event (no inputType): commit at once.
        if (!(e.nativeEvent as InputEvent).inputType) commit(e.target.value);
        else setDraft(e.target.value);
      }}
      onBlur={() => {
        if (draft !== null) commit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && draft !== null) commit(draft);
        else if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

const STRIKE_FIELDS: readonly StrikeField[] = ['ratio', 'amp', 'decay'];

/**
 * Struck partials (bell redesign): sines that sound only after a strike, each decaying to 1 % over
 * its own time. A collapsed list of ratio, level and decay; add/remove, up to 16.
 */
function StrikePartials({ timbre, name }: { timbre: Timbre; name: string }) {
  const list = timbre.strikePartials ?? [];
  return (
    <details className="sd-section sd-strike" data-section="strike" data-testid="strike-partials">
      <summary>
        Strike partials <span className="sd-count">{list.length}</span>
      </summary>
      <div className="sd-strike-list" role="group" aria-label="Strike partials">
        {list.length > 0 && (
          <>
            <span className="sd-strike-h">Ratio</span>
            <span className="sd-strike-h">Level</span>
            <span className="sd-strike-h">Decay (s)</span>
            <span />
          </>
        )}
        {list.map((sp, i) => (
          <Fragment key={i}>
            {STRIKE_FIELDS.map((f) => (
              <DecimalField
                key={f}
                ctl={STRIKE_CONTROLS[f]}
                value={sp[f]}
                label={`Strike partial ${i + 1} ${STRIKE_CONTROLS[f].label.toLowerCase()}`}
                testId={`strike-${i + 1}-${f}`}
                onCommit={(x) =>
                  edit(timbreRecipe(name, setStrikePartial(i, f, x)), 'Strike partial')
                }
              />
            ))}
            <button
              type="button"
              className="sd-mini"
              aria-label={`Remove strike partial ${i + 1}`}
              data-testid={`strike-${i + 1}-remove`}
              onClick={() =>
                edit(timbreRecipe(name, removeStrikePartial(i)), 'Remove strike partial')
              }
            >
              ×
            </button>
          </Fragment>
        ))}
      </div>
      <div className="sd-bar-buttons">
        <button
          type="button"
          className="sd-mini"
          data-testid="strike-add"
          disabled={list.length >= MAX_STRIKE_PARTIALS}
          onClick={() => edit(timbreRecipe(name, addStrikePartial), 'Add strike partial')}
        >
          + Add
        </button>
        <span className="sd-hint">After each strike only; decay to 1 %.</span>
      </div>
    </details>
  );
}

const MIX_SECTIONS: readonly (readonly [MixSection, string])[] = [
  ['reverb', 'Reverb'],
  ['delay', 'Delay'],
  ['sends', 'Sends'],
  ['tone', 'Tone'],
];

/** A master slider; the delay time shows beats with a tempo and snaps with Snap to beats. */
function MixRow({
  ctl,
  title,
  mix,
  view,
}: {
  ctl: MixControl;
  title: string;
  mix: MixSettings;
  view: ViewSettings;
}) {
  const value = mixValue(mix, ctl.path);
  const isDelay = ctl === DELAY_TIME;
  const text = isDelay ? formatDelay(value, view) : formatMix(ctl, value);
  const label = ctl.section === 'sends' ? ctl.label : `${title} ${ctl.label.toLowerCase()}`;
  return (
    <label className="sd-row">
      <span className="sd-label">{ctl.label}</span>
      <GestureRange
        position={positionOf(ctl, value)}
        text={text}
        label={label}
        testId={`mx-${ctl.id}`}
        recipeAt={(pos, alt) =>
          setMixAt(ctl.path, isDelay ? delayTimeAt(pos, view, alt) : valueOf(ctl, pos))
        }
      />
      <output className="sd-out" data-testid={`mx-${ctl.id}-out`}>
        {text}
      </output>
    </label>
  );
}

/**
 * Master FX (§8.6): reverb, delay, default sends and auto pan, tone; each with a Reset to the
 * defaults. Applies to the whole piece; heard live (the engine smooths every change).
 */
function Master({ mix, view, parts }: { mix: MixSettings; view: ViewSettings; parts: boolean }) {
  return (
    <>
      <p className="sd-hint sd-group" data-testid="master">
        The whole piece's effects, after every note. The limiter is always on (ceiling{' '}
        <span data-testid="mx-limiter">{mix.limiter.ceilingDb} dBFS</span>).
      </p>
      {parts && (
        <fieldset className="sd-section" data-section="mix-level">
          <legend>Level</legend>
          <label className="sd-row">
            <span className="sd-label">Level normalisation</span>
            <select
              aria-label="Level normalisation"
              data-testid="mx-normalise"
              value={normaliseOf(mix)}
              onChange={(e) =>
                edit(setNormalise(e.target.value as 'all' | 'part'), 'Level normalisation')
              }
            >
              <option value="part">by part</option>
              <option value="all">whole mix</option>
            </select>
            <span />
          </label>
          <p className="sd-hint sd-wide">
            By part: a part joining doesn't lower the others. Whole mix: every line shares one
            level.
          </p>
        </fieldset>
      )}
      {MIX_SECTIONS.map(([section, title]) => (
        <fieldset key={section} className="sd-section" data-section={`mix-${section}`}>
          <legend>
            {title}
            <button
              type="button"
              className="sd-reset"
              data-testid={`mx-${section}-reset`}
              disabled={isSectionDefault(mix, section)}
              title={`Put the default ${title.toLowerCase()} settings back`}
              onClick={() => edit(resetSection(section), `Reset ${title.toLowerCase()}`)}
            >
              Reset
            </button>
          </legend>
          {MIX_CONTROLS.filter((c) => c.section === section).map((c) => (
            <MixRow key={c.id} ctl={c} title={title} mix={mix} view={view} />
          ))}
          {section === 'sends' && (
            <label className="sd-row">
              <span className="sd-label">Auto pan</span>
              <select
                aria-label="Auto pan"
                data-testid="mx-pan-auto"
                value={mix.panAuto}
                onChange={(e) =>
                  edit(setPanAuto(e.target.value as MixSettings['panAuto']), 'Auto pan')
                }
              >
                <option value="index">by note</option>
                <option value="pitch">by pitch</option>
              </select>
              <span />
            </label>
          )}
          {section === 'sends' && (
            <p className="sd-hint sd-wide">Notes can override these in the Notes drawer.</p>
          )}
        </fieldset>
      ))}
    </>
  );
}

const SOUND_TABS: readonly (readonly [SoundTab, string])[] = [
  ['timbre', 'Timbre'],
  ['master', 'Master'],
];

const STRIKES: readonly (readonly [Strike, string])[] = [
  ['auto', 'Auto'],
  ['crisp', 'Crisp'],
  ['soft', 'Soft'],
];

function encodeTarget(t: LoadTarget): string {
  return typeof t === 'object' ? `voice:${t.voice}` : t;
}
function decodeTarget(s: string): LoadTarget {
  return s.startsWith('voice:') ? { voice: s.slice(6) } : (s as LoadTarget);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Who uses the timbre: its notes, and the timbre changes (M6) to it. */
function usersText(notes: number, changes: number): string {
  const n = notes === 0 ? 'No notes use it' : `${plural(notes, 'note uses', 'notes use')} it`;
  return changes === 0 ? n : `${n} · ${plural(changes, 'timbre change', 'timbre changes')}`;
}

/**
 * Renames the piece's own timbre `name`: a button that opens a name field. Enter commits (a
 * refused name shows why), Escape cancels, leaving the field commits a valid name. One undo entry;
 * the notes and timbre moments using it follow.
 */
function RenameTimbre({ name }: { name: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => {
    setDraft(null);
    setError(null);
  };
  const commit = (onBlur: boolean): void => {
    if (draft === null) return;
    const err = timbreRenameError(usePlayer.getState().piece, name, draft);
    if (err) {
      if (onBlur) close();
      else setError(err);
      return;
    }
    const next = draft.trim();
    close();
    if (next !== name && edit((p) => renameTimbre(p, name, next), 'Rename timbre')) {
      selectTimbre(next);
    }
  };
  if (draft === null) {
    return (
      <button
        type="button"
        data-testid="sound-rename"
        title="Rename this timbre (its notes and timbre changes follow)"
        onClick={() => setDraft(name)}
      >
        Rename
      </button>
    );
  }
  return (
    <input
      type="text"
      className="sd-name"
      aria-label={`New name for ${name}`}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      data-testid="sound-name"
      spellCheck={false}
      autoComplete="off"
      // The field opens on a click of Rename, to be typed in at once.
      autoFocus
      value={draft}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setDraft(e.target.value);
        setError(null);
      }}
      onBlur={() => commit(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(false);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    />
  );
}

/** The drawer itself; renders nothing while closed. Mount it in the wide layout only. */
export function SoundDrawer() {
  const open = useSoundDrawer((s) => s.open);
  const chosen = useSoundDrawer((s) => s.name);
  const tab = useSoundDrawer((s) => s.tab);
  const piece = usePlayer((s) => s.piece);
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState('users');
  if (!open) return null;
  const name = editedName(piece, chosen);
  const timbre = timbreIn(piece, name);

  const save = (): void => {
    downloadBlob(
      new Blob([serializeTimbrePreset(name, timbre)], { type: 'application/json' }),
      timbrePresetFileName(name),
    );
  };
  const load = async (file: File): Promise<void> => {
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      pushNotice('error', `Could not read ${file.name}`, [
        e instanceof Error ? e.message : String(e),
      ]);
      return;
    }
    const r = parseTimbrePreset(text);
    if (!r.ok) {
      pushNotice('error', `Could not load ${file.name}`, r.errors);
      return;
    }
    const p = usePlayer.getState().piece;
    const out = loadPreset(
      p,
      r,
      decodeTarget(target),
      editedName(p, useSoundDrawer.getState().name),
    );
    edit(() => out.piece, 'Load preset');
    selectTimbre(out.name);
    if (r.warnings.length > 0)
      pushNotice('warning', `${file.name} loaded with warnings`, r.warnings);
  };

  return (
    <section
      id="sound-drawer"
      className="sound-drawer"
      aria-label="Sound"
      data-testid="sound-drawer"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          toggleSoundDrawer(false);
        }
      }}
    >
      <input
        ref={fileInput}
        type="file"
        className="visually-hidden"
        accept=".json,application/json"
        aria-label="Load a timbre preset file"
        data-testid="preset-file-input"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void load(file);
        }}
      />
      <header className="vd-head sd-head">
        <h2>Sound</h2>
        <span className="sd-tabs" role="tablist" aria-label="Sound drawer">
          {SOUND_TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`sound-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="sound-panel"
              data-testid={`sound-tab-${t}`}
              onClick={() => selectSoundTab(t)}
            >
              {label}
            </button>
          ))}
        </span>
        {tab === 'timbre' && (
          <TimbreHead
            name={name}
            target={target}
            setTarget={setTarget}
            openFile={() => fileInput.current?.click()}
            save={save}
          />
        )}
        <button
          type="button"
          className="vd-close"
          aria-label="Close sound drawer"
          onClick={() => toggleSoundDrawer(false)}
        >
          ×
        </button>
      </header>
      {tab === 'master' ? (
        <div
          className="sd-body"
          id="sound-panel"
          role="tabpanel"
          aria-labelledby="sound-tab-master"
        >
          <Master mix={piece.mix} view={piece.view} parts={hasParts(piece)} />
        </div>
      ) : (
        <div
          className="sd-body"
          id="sound-panel"
          role="tabpanel"
          aria-labelledby="sound-tab-timbre"
        >
          <TimbreBody timbre={timbre} name={name} />
        </div>
      )}
    </section>
  );
}

/** The timbre tab's header controls: which timbre, who uses it, rename/delete/revert, presets. */
function TimbreHead({
  name,
  target,
  setTarget,
  openFile,
  save,
}: {
  name: string;
  target: string;
  setTarget: (t: string) => void;
  openFile: () => void;
  save: () => void;
}) {
  const piece = usePlayer((s) => s.piece);
  const users = timbreUsers(piece, name);
  const changes = timbreMoments(piece, name).length;
  const modified = isModified(piece, name);
  const builtin = name in BUILTIN_TIMBRES;
  const custom = isCustom(piece, name);
  return (
    <>
      <label className="ctl">
        <span>Timbre</span>
        <select
          aria-label="Timbre to edit"
          data-testid="sound-timbre"
          value={name}
          onChange={(e) => selectTimbre(e.target.value)}
        >
          {timbreOptions(piece, name).map((t) => (
            <option key={t} value={t}>
              {t}
              {isModified(piece, t) ? ' (edited)' : isCustom(piece, t) ? ' (piece)' : ''}
            </option>
          ))}
        </select>
      </label>
      <span className="sd-users" data-testid="sound-users">
        {usersText(users.length, changes)}
      </span>
      {custom && <RenameTimbre key={name} name={name} />}
      {custom && (
        <button
          type="button"
          className="danger"
          data-testid="sound-delete"
          disabled={users.length > 0}
          title={
            users.length > 0
              ? `${plural(users.length, 'note uses', 'notes use')} it: give them another timbre first`
              : changes > 0
                ? `Delete it; ${plural(changes, 'timbre change', 'timbre changes')} will name a missing timbre`
                : 'Delete this timbre from the piece'
          }
          onClick={() => edit((p) => deleteTimbre(p, name), 'Delete timbre')}
        >
          Delete
        </button>
      )}
      {builtin && (
        <button
          type="button"
          data-testid="sound-revert"
          disabled={!modified}
          title={`Put the built-in ${name}'s values back`}
          onClick={() => edit((p) => revertTimbre(p, name), 'Revert timbre')}
        >
          Revert
        </button>
      )}
      <button
        type="button"
        data-testid="sound-duplicate"
        title="A copy under a new name, to edit separately"
        onClick={() => {
          const out = duplicateTimbre(usePlayer.getState().piece, name);
          if (edit(() => out.piece, 'Duplicate timbre')) selectTimbre(out.name);
        }}
      >
        Duplicate
      </button>
      <button type="button" data-testid="preset-save" onClick={save}>
        Save preset
      </button>
      <span className="sd-load">
        <button type="button" data-testid="preset-load" onClick={openFile}>
          Load preset
        </button>
        <label className="ctl">
          <span>into</span>
          <select
            aria-label="Notes that get the loaded preset"
            data-testid="preset-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="users">notes using {name}</option>
            <option value="all">all notes</option>
            {piece.voices.map((v) => (
              <option key={v.id} value={encodeTarget({ voice: v.id })}>
                {v.name ? `${v.name} (${v.id})` : v.id}
              </option>
            ))}
            <option value="none">no notes (add to piece)</option>
          </select>
        </label>
      </span>
    </>
  );
}

/** The timbre tab: partials and the timbre's sections. */
function TimbreBody({ timbre, name }: { timbre: Timbre; name: string }) {
  return (
    <>
      <Partials timbre={timbre} name={name} />
      <Section title="Shape" section="shape" timbre={timbre} name={name} />
      <Section
        title="FM"
        section="fm"
        timbre={timbre}
        name={name}
        toggle={{ on: timbre.fm !== undefined, set: setFmOn }}
      />
      <StrikePartials timbre={timbre} name={name} />
      <Section
        title="Noise"
        section="noise"
        timbre={timbre}
        name={name}
        toggle={{ on: timbre.noise !== undefined, set: setNoiseOn }}
      />
      <Section title="Articulation" section="articulation" timbre={timbre} name={name}>
        <label className="sd-row">
          <span className="sd-label">Strike</span>
          <select
            aria-label="Strike"
            data-testid="ts-strike"
            value={strikeOf(timbre)}
            onChange={(e) =>
              edit(timbreRecipe(name, setStrike(e.target.value as Strike)), 'Strike')
            }
          >
            {STRIKES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </Section>
      <Section title="Vibrato" section="vibrato" timbre={timbre} name={name} />
    </>
  );
}
