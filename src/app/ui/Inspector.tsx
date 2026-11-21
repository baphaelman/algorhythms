/**
 * The inspector (PLAN.md §11.2, §11.3): the right-hand column that edits the selected moment.
 * One selected: header, type form, common fields, seed and diagnostics. Several: count and shared
 * actions. None: a hint. Every change goes through the M4b editor actions (undoable).
 */

import type { Moment, MomentId, Piece } from '../../core/types';
import { deleteMoments, updateMoment } from '../editor/actions';
import {
  beginGesture,
  cancelGesture,
  edit,
  endGesture,
  updateGesture,
  useEditor,
} from '../editor/history';
import { DEFAULT_BPM, DEFAULT_METER } from '../../render';
import { patchMoment } from '../editor/ops';
import { usePlayer } from '../store';
import { NumberField, TextField, fieldSetter, type Setter } from './inspector/controls';
import { GlideFields, SeedField, TargetField } from './inspector/CommonFields';
import { formatTime, keyAt } from './inspector/fields';
import { TypeFields } from './inspector/TypeFields';
import { Overrides } from './inspector/Overrides';
import './inspector.css';

const TYPE_NAMES: Record<Moment['type'], string> = {
  chord: 'Chord',
  unison: 'Unison',
  split: 'Split',
  merge: 'Merge',
  shift: 'Shift',
  spread: 'Spread',
  walk: 'Walk',
  note: 'Note',
  pin: 'Pin',
  key: 'Key change',
  level: 'Level',
};

/** Sets `muted` on every moment in `ids` as one undo entry. */
function setMuted(ids: readonly MomentId[], muted: boolean): void {
  edit(
    (p) => ids.reduce((acc, id) => patchMoment(acc, id, { muted: muted ? true : undefined }), p),
    muted ? 'Mute moments' : 'Unmute moments',
  );
}

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const piece = usePlayer((s) => s.piece);
  const selected = selection
    .map((id) => piece.moments.find((m) => m.id === id))
    .filter((m): m is Moment => !!m);

  return (
    <aside
      className="slot inspector"
      data-slot="inspector"
      aria-label="Inspector"
      data-testid="inspector"
    >
      {selected.length === 0 && <Empty />}
      {selected.length === 1 && <One key={selected[0].id} m={selected[0]} piece={piece} />}
      {selected.length > 1 && <Many moments={selected} />}
    </aside>
  );
}

/** True while a view-field drag is open (module-level: setters are rebuilt per render). */
let open = false;

/** A setter for a piece view field (one undo entry per commit or drag). */
function viewSetter(field: 'gridBpm' | 'meter', label: string): Setter<number> {
  const patch = (p: Piece, v: number): Piece =>
    p.view[field] === v ? p : { ...p, view: { ...p.view, [field]: v } };
  return {
    commit: (v) => void edit((p) => patch(p, v), label),
    begin() {
      open = true;
      beginGesture(label);
    },
    drag(v) {
      if (!open) this.begin();
      updateGesture((p) => patch(p, v));
    },
    end(cancel = false) {
      if (!open) return;
      open = false;
      if (cancel) cancelGesture();
      else endGesture();
    },
  };
}

/** Tempo and meter of the drawn bar grid (§11.3 revision 7; drawn, not snapped to). */
function BarFields() {
  const view = usePlayer((s) => s.piece.view);
  return (
    <fieldset className="insp-group" data-testid="insp-bars">
      <legend>Bars</legend>
      <NumberField
        label="Tempo"
        value={view.gridBpm ?? DEFAULT_BPM}
        set={viewSetter('gridBpm', 'Change tempo')}
        min={20}
        max={300}
        step={1}
        unit="bpm"
        testId="insp-bpm"
      />
      <NumberField
        label="Beats per bar"
        value={view.meter ?? DEFAULT_METER}
        set={viewSetter('meter', 'Change meter')}
        min={1}
        max={32}
        step={1}
        integer
        testId="insp-meter"
      />
    </fieldset>
  );
}

function Empty() {
  return (
    <div className="insp-empty">
      <h2>No moment selected</h2>
      <p>
        Select a moment on the lane to edit it here, or add one at the playhead with a key:{' '}
        <kbd>C</kbd> chord, <kbd>U</kbd> unison, <kbd>S</kbd> split, <kbd>M</kbd> merge,{' '}
        <kbd>T</kbd> shift, <kbd>P</kbd> spread, <kbd>W</kbd> walk, <kbd>I</kbd> pin, <kbd>K</kbd>{' '}
        key, <kbd>L</kbd> level.
      </p>
      <BarFields />
    </div>
  );
}

function Many({ moments }: { moments: Moment[] }) {
  const ids = moments.map((m) => m.id);
  const allMuted = moments.every((m) => m.muted);
  return (
    <div className="insp-many">
      <h2>{moments.length} moments selected</h2>
      <div className="insp-actions">
        <button type="button" onClick={() => setMuted(ids, !allMuted)}>
          {allMuted ? 'Unmute all' : 'Mute all'}
        </button>
        <button type="button" className="danger" onClick={() => deleteMoments(ids)}>
          Delete
        </button>
      </div>
    </div>
  );
}

function One({ m, piece }: { m: Moment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const at = fieldSetter<number>(m.id, 'Move moment', (_x, v) => ({ at: v }));
  const diags = compiled.diagnostics.filter((d) => d.momentId === m.id);
  const key = keyAt(compiled, m.at, piece.key);
  const pitched = m.type !== 'key' && m.type !== 'level';

  return (
    <div className="insp-one" data-moment-id={m.id} data-moment-type={m.type}>
      <header className="insp-head">
        <h2>
          {TYPE_NAMES[m.type]} <span className="insp-at">@ {formatTime(m.at)}</span>
        </h2>
        <label className="insp-check">
          <input
            type="checkbox"
            checked={!!m.muted}
            data-testid="insp-mute"
            onChange={(e) =>
              updateMoment(
                m.id,
                { muted: e.target.checked ? true : undefined },
                e.target.checked ? 'Mute moment' : 'Unmute moment',
              )
            }
          />
          Muted
        </label>
      </header>

      {diags.length > 0 && (
        <ul className="insp-diags" data-testid="insp-diags" aria-label="Messages for this moment">
          {diags.map((d, i) => (
            <li key={i} className={d.level} data-code={d.code}>
              <span className="sr-only">{d.level}: </span>
              {d.message}
            </li>
          ))}
        </ul>
      )}

      <TextField
        label="Label"
        value={m.label ?? ''}
        placeholder="(none)"
        testId="insp-label"
        parse={() => ({ ok: true })}
        onCommit={(t) =>
          updateMoment(m.id, { label: t.trim() === '' ? undefined : t.trim() }, 'Rename moment')
        }
      />
      <NumberField
        label="Time"
        unit="s"
        value={m.at}
        set={at}
        min={0}
        step={0.1}
        testId="insp-at"
      />

      <TypeFields m={m} ctx={{ piece, keyAt: key }} />
      <Overrides m={m} piece={piece} keyAt={key} />

      {m.type !== 'key' && <TargetField m={m} piece={piece} />}
      {pitched && <GlideFields m={m} piece={piece} />}
      {pitched && <SeedField m={m} piece={piece} />}

      <div className="insp-actions">
        <button type="button" className="danger" onClick={() => deleteMoments([m.id])}>
          Delete moment
        </button>
      </div>
    </div>
  );
}
