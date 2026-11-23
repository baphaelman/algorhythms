/**
 * The inspector (PLAN.md §11.2, §11.3): the right-hand column that edits the selected moment.
 * One selected: header, type form, common fields, seed and diagnostics. Several: count and shared
 * actions. None: a hint. Every change goes through the M4b editor actions (undoable).
 */

import { Fragment, useEffect, useRef } from 'react';
import type { Moment, MomentId, Piece } from '../../core/types';
import { deleteMoments, freezeMoments, setPieceKey, updateMoment } from '../editor/actions';
import { canFreeze, isFrozen } from '../editor/freeze';
import { rowOf } from '../editor/rows';
import { PALETTE } from '../editor/shortcuts';
import { isPieceKey, pieceKeyMoment, takePieceKeyFocus } from '../editor/piece-key';
import {
  beginGesture,
  cancelGesture,
  edit,
  endGesture,
  updateGesture,
  useEditor,
} from '../editor/history';
import { DEFAULT_BPM, DEFAULT_METER } from '../../render';
import { atPatch, patchMoment } from '../editor/ops';
import { usePlayer } from '../store';
import { NumberField, TextField, fieldSetter, type Setter } from './inspector/controls';
import { GlideFields, PartField, SeedField, TargetField } from './inspector/CommonFields';
import { partScope } from '../../core/parts';
import { scopeLabel } from '../editor/parts';
import { formatTime, keyAt } from './inspector/fields';
import { KeyFields, TypeFields } from './inspector/TypeFields';
import { Overrides } from './inspector/Overrides';
import './inspector.css';

/** The heading: the block's row (§6.4); note and pin are dots. */
const TYPE_NAMES: Record<Moment['type'], string> = {
  chord: 'Chord',
  unison: 'Chord',
  split: 'Chord',
  merge: 'Chord',
  shift: 'Chord',
  spread: 'Chord',
  progression: 'Chord',
  walk: 'Texture',
  pulse: 'Texture',
  note: 'Note',
  pin: 'Pin',
  key: 'Key',
  level: 'Level',
  tune: 'Melody',
  timbre: 'Sound',
};

/** The Freeze button's tooltip (§11.3). */
const FREEZE_HINT =
  'Replace the result with fixed notes, so edits to earlier moments no longer change it';

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
  // The piece key at 0:00 alone (M4.5-39); with other moments it is left out of the group.
  const pieceKey = selection.length === 1 && isPieceKey(selection[0]);

  return (
    <aside
      className="slot inspector"
      data-slot="inspector"
      aria-label="Inspector"
      data-testid="inspector"
    >
      {pieceKey && <PieceKey piece={piece} />}
      {selected.length === 0 && !pieceKey && <Empty />}
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
      <p data-testid="insp-empty-keys">
        Select a block to edit it, or add one:{' '}
        {PALETTE.map((e, i) => (
          <Fragment key={e.type}>
            {i > 0 && ', '}
            <kbd>{e.key}</kbd> {e.name.toLowerCase()}
          </Fragment>
        ))}
        .
      </p>
      <BarFields />
    </div>
  );
}

/** Why the piece key can't be deleted (the disabled button's tooltip). */
const PIECE_KEY_LOCKED = "The piece's key can't be deleted or moved; edit it here";

/** The piece's key as the key moment at 0:00: editable, never moved, copied or deleted. */
function PieceKey({ piece }: { piece: Piece }) {
  const m = pieceKeyMoment(piece);
  const root = useRef<HTMLDivElement>(null);
  // New > Empty: prompt for the key (no deps: checked after every render, consumed once).
  useEffect(() => {
    if (takePieceKeyFocus())
      root.current?.querySelector<HTMLElement>('[data-testid="insp-tonic"]')?.focus();
  });
  return (
    <div
      ref={root}
      className="insp-one"
      data-moment-id={m.id}
      data-moment-type="key"
      data-piece-key=""
    >
      <header className="insp-head">
        <h2>
          Key <span className="insp-at">@ {formatTime(0)}</span>
        </h2>
      </header>
      <p className="insp-note">The piece's key, until the first key change.</p>
      <KeyFields m={m} write={setPieceKey} />
      <div className="insp-actions">
        <button
          type="button"
          className="danger"
          disabled
          title={PIECE_KEY_LOCKED}
          data-testid="insp-delete"
        >
          Delete moment
        </button>
      </div>
    </div>
  );
}

function Many({ moments }: { moments: Moment[] }) {
  const ids = moments.map((m) => m.id);
  const allMuted = moments.every((m) => m.muted);
  const freezable = moments.filter((m) => canFreeze(m) && !isFrozen(m)).map((m) => m.id);
  return (
    <div className="insp-many" data-testid="insp-many">
      <h2>{moments.length} moments selected</h2>
      <div className="insp-actions">
        <button type="button" onClick={() => setMuted(ids, !allMuted)}>
          {allMuted ? 'Unmute all' : 'Mute all'}
        </button>
        {freezable.length > 0 && (
          <button
            type="button"
            data-testid="insp-freeze"
            title={FREEZE_HINT}
            onClick={() => freezeMoments(freezable)}
          >
            Freeze {freezable.length}
          </button>
        )}
        <button
          type="button"
          className="danger"
          data-testid="insp-delete"
          onClick={() => deleteMoments(ids)}
        >
          Delete
        </button>
      </div>
      <p className="insp-note">
        ⌘/Ctrl+C, X and V copy, cut and paste them at the playhead; ←/→ on a selected lane moment
        nudges them all.
      </p>
    </div>
  );
}

function One({ m, piece }: { m: Moment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  // A region (walk, pulse) moves whole: its `until` follows.
  const at = fieldSetter<number>(m.id, 'Move moment', (x, v) => atPatch(x, v));
  const diags = compiled.diagnostics.filter((d) => d.momentId === m.id);
  const key = keyAt(compiled, m.at, piece.key);
  // A pulse or a timbre change moves no pitch: no transition; a pulse's seed matters only for
  // random order.
  const pitched =
    m.type !== 'key' && m.type !== 'level' && m.type !== 'pulse' && m.type !== 'timbre';
  // A tune draws nothing at random (one line, no jitter): no seed either.
  const seeded = (pitched && m.type !== 'tune') || (m.type === 'pulse' && m.mode === 'random');
  const scope = partScope(m.target);

  return (
    <div className="insp-one" data-moment-id={m.id} data-moment-type={m.type}>
      <header className="insp-head">
        <h2>
          {TYPE_NAMES[m.type]} <span className="insp-at">@ {formatTime(m.at)}</span>
          {scope !== null && (
            <span className="insp-head-part" data-testid="insp-head-part">
              {' '}
              · {scopeLabel(scope)}
            </span>
          )}
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
      {m.type !== 'key' && <PartField m={m} piece={piece} />}

      <TypeFields m={m} ctx={{ piece, keyAt: key }} />
      <Overrides m={m} piece={piece} keyAt={key} />

      {m.type !== 'key' && <TargetField m={m} piece={piece} />}
      {/* A Chords block shows its Transition under Arrive → Custom. */}
      {pitched && rowOf(m.type) !== 'chords' && <GlideFields m={m} piece={piece} />}
      {seeded && <SeedField m={m} piece={piece} />}

      <div className="insp-actions">
        {canFreeze(m) && !isFrozen(m) && (
          <button
            type="button"
            data-testid="insp-freeze"
            title={FREEZE_HINT}
            onClick={() => freezeMoments([m.id])}
          >
            Freeze
          </button>
        )}
        <button
          type="button"
          className="danger"
          data-testid="insp-delete"
          onClick={() => deleteMoments([m.id])}
        >
          Delete moment
        </button>
      </div>
    </div>
  );
}
