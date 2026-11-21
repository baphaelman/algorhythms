/**
 * The Sound drawer (PLAN.md §11.3): pick a timbre and edit it (partials, stretch, brightness,
 * FM, noise, accent, articulation, vibrato), save it as a preset file, or load one into notes.
 * Wide layout only. Edits apply live through the store's recompile and hot-swap; a slider drag is
 * one undo entry, a keyboard step one each (editor/timbre-edit.ts). Editing a built-in stores an
 * edited copy in the piece under its name; Revert puts the built-in's values back.
 */

import { useRef, useState, type ReactNode } from 'react';
import {
  parseTimbrePreset,
  serializeTimbrePreset,
  timbrePresetFileName,
} from '../../core/timbre-preset';
import { BUILTIN_TIMBRES } from '../../core/timbres';
import type { Timbre } from '../../core/types';
import { downloadBlob } from '../download';
import { edit } from '../editor/history';
import {
  addPartial,
  beginTimbreDrag,
  dragTimbre,
  duplicateTimbre,
  editedName,
  endTimbreDrag,
  formatValue,
  isCustom,
  isModified,
  loadPreset,
  MAX_PARTIALS,
  PARTIAL_CONTROL,
  positionOf,
  removePartial,
  revertTimbre,
  selectTimbre,
  setAt,
  setFmOn,
  setHarmonic,
  setNoiseOn,
  setStrike,
  SLIDER_STEPS,
  STRETCH_PARTIALS,
  strikeOf,
  TIMBRE_CONTROLS,
  timbreIn,
  timbreRecipe,
  timbreUsers,
  toggleSoundDrawer,
  useSoundDrawer,
  valueAt,
  valueOf,
  type LoadTarget,
  type Strike,
  type TimbreControl,
  type TimbreFn,
} from '../editor/timbre-edit';
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
 * A timbre slider: a pointer drag is one undo entry (coalesced to a frame), a keyboard step one
 * entry. `vertical` draws it upright (partials).
 */
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
  const { ctl, value, name, label, testId, disabled, vertical, fn } = props;
  const dragging = useRef(false);
  const shown = value ?? 0;
  const text = formatValue(ctl, value);
  return (
    <input
      type="range"
      className={vertical ? 'sd-vertical' : undefined}
      min={0}
      max={SLIDER_STEPS}
      step={1}
      value={positionOf(ctl, shown)}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={text}
      aria-orientation={vertical ? 'vertical' : undefined}
      data-testid={testId}
      onPointerDown={() => {
        dragging.current = true;
        beginTimbreDrag(label);
        window.addEventListener(
          'pointerup',
          () => {
            dragging.current = false;
            endTimbreDrag();
          },
          { once: true },
        );
      }}
      onChange={(e) => {
        const recipe = timbreRecipe(name, fn(valueOf(ctl, Number(e.target.value))));
        if (dragging.current) dragTimbre(recipe);
        else edit(recipe, label);
      }}
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
  const value = valueAt(timbre, ctl.path);
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

/** The drawer itself; renders nothing while closed. Mount it in the wide layout only. */
export function SoundDrawer() {
  const open = useSoundDrawer((s) => s.open);
  const chosen = useSoundDrawer((s) => s.name);
  const piece = usePlayer((s) => s.piece);
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState('users');
  if (!open) return null;
  const name = editedName(piece, chosen);
  const timbre = timbreIn(piece, name);
  const users = timbreUsers(piece, name);
  const modified = isModified(piece, name);
  const builtin = name in BUILTIN_TIMBRES;

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
          {users.length === 0
            ? 'No notes use it'
            : `${users.length} ${users.length === 1 ? 'note uses' : 'notes use'} it`}
        </span>
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
          <button
            type="button"
            data-testid="preset-load"
            onClick={() => fileInput.current?.click()}
          >
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
        <button
          type="button"
          className="vd-close"
          aria-label="Close sound drawer"
          onClick={() => toggleSoundDrawer(false)}
        >
          ×
        </button>
      </header>
      <div className="sd-body">
        <Partials timbre={timbre} name={name} />
        <Section title="Shape" section="shape" timbre={timbre} name={name} />
        <Section
          title="FM"
          section="fm"
          timbre={timbre}
          name={name}
          toggle={{ on: timbre.fm !== undefined, set: setFmOn }}
        />
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
      </div>
    </section>
  );
}
