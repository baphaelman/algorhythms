/**
 * The poster's Rows group (PLAN.md §15 M14, the owner's notes): Rows are Equal (the Rows slider)
 * or By sections, where each labelled moment starts a row. By sections shows the Organize list:
 * the sections in order, each one small line: its time, its row label (edited in place; default:
 * the section's label; A / B / A′ / B′ …), a revert icon and a "New row" switch. Both live in the piece's poster, each change one undo step.
 */

import { useId, useState } from 'react';
import { posterLength } from '../../render/poster';
import { posterSectionItems } from '../../render/poster-layout';
import { setRowSection, setRowsBy } from '../../render/poster-edit';
import { sectionOf, type ExportForm } from '../export-options';
import { editPoster } from '../poster-sync';
import { usePlayer } from '../store';
import { Radios, Switch } from './export-controls';
import { RowsField } from './ExportFields';
import { GroupSwitch } from './PosterDetails';
import { videoContext } from './export-state';
import './rows-background.css';

const MODES = [
  { id: 'equal', label: 'Equal' },
  { id: 'sections', label: 'By sections' },
] as const;

export function RowsGroup({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  const id = useId();
  const by = usePlayer((s) => (s.piece.poster?.rowsBy === 'sections' ? 'sections' : 'equal'));
  return (
    <div className="ws-rows" data-testid="rows-group">
      <Radios
        legend="Rows"
        name={`${id}-rowsby`}
        value={by}
        options={MODES}
        disabled={disabled}
        testId="rows-by"
        onChange={(v) => editPoster((d) => setRowsBy(d, v), 'Rows')}
      />
      {by === 'equal' ? (
        <RowsField form={form} disabled={disabled} />
      ) : (
        <Organize form={form} disabled={disabled} />
      )}
      {by === 'sections' && (
        <GroupSwitch group="rowNames" label="Row labels" details="rowNames" disabled={disabled} />
      )}
      <GroupSwitch group="rowLabels" label="Row times" details="rowLabels" disabled={disabled} />
    </div>
  );
}

type Item = ReturnType<typeof posterSectionItems>[number];

/** One section's line: time, the row label in effect (edited in place), revert, New row. */
function OrganizeItem({ it, i, disabled }: { it: Item; i: number; disabled: boolean }) {
  const name = it.section || 'Start';
  // What the field shows while you type; saved on Enter or blur, Escape puts the label back.
  const [typed, setDraft] = useState<string | null>(null);
  const draft = typed ?? it.label;
  const commit = (text: string) => {
    const label = text.trim() === '' ? undefined : text;
    if (label !== it.label)
      editPoster((d) => setRowSection(d, it.id, { label }, it.section), 'Row label');
    setDraft(null);
  };
  return (
    <li
      key={it.id}
      data-testid="organize-item"
      data-id={it.id}
      data-starts={it.starts ? 'yes' : 'no'}
    >
      <span className="ws-organize-time">{posterLength(it.t)}</span>
      {it.newRow ? (
        <input
          type="text"
          aria-label={`Row label for ${name}`}
          placeholder={it.section || 'Row label'}
          maxLength={200}
          spellCheck={false}
          disabled={disabled}
          value={draft}
          data-testid={`organize-label-${i}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(e.currentTarget.value);
            } else if (e.key === 'Escape' && typed !== null) {
              // Cancels the edit only; a second Escape leaves the field.
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
      ) : (
        <span className="ws-organize-name">{name}</span>
      )}
      {it.newRow && it.label !== it.section ? (
        <button
          type="button"
          className="ws-organize-reset"
          disabled={disabled}
          aria-label="Default label"
          title={`Back to “${name}”`}
          data-testid={`organize-label-reset-${i}`}
          onClick={() => editPoster((d) => setRowSection(d, it.id, { label: undefined }), 'Rows')}
        >
          <span aria-hidden="true">↺</span>
        </button>
      ) : (
        <span className="ws-organize-gap" />
      )}
      {it.canJoin ? (
        <Switch
          label="New row"
          className="ws-organize-switch"
          checked={it.newRow}
          disabled={disabled}
          testId={`organize-newrow-${i}`}
          hint={
            it.newRow && !it.starts
              ? 'Joins the row before when off: at most 8 rows, none under 2 seconds.'
              : undefined
          }
          onChange={(on) => editPoster((d) => setRowSection(d, it.id, { join: !on }), 'Rows')}
        />
      ) : (
        <span />
      )}
    </li>
  );
}

/** The sections in order, one small line each. */
function Organize({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const section = sectionOf(form, videoContext());
  const items = posterSectionItems(compiled, piece, piece.poster, section ? { section } : {});
  if (items.length <= 1 && items[0]?.id === 'start') {
    return (
      <p className="look-note" data-testid="organize-empty">
        No labelled moments here: label a moment to start a row at it.
      </p>
    );
  }
  return (
    <ol className="ws-organize" aria-label="Organize rows" data-testid="organize">
      {items.map((it, i) => (
        <OrganizeItem key={it.id} it={it} i={i} disabled={disabled} />
      ))}
    </ol>
  );
}
