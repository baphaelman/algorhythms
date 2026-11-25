/**
 * The poster's Rows group (PLAN.md §15 M14, the owner's notes): Rows are Equal (the Rows slider)
 * or By sections, where each labelled moment starts a row. By sections shows the Organize list:
 * the sections in order, each with a "New row" switch and its row label (default: the section's
 * label; A / B / A′ / B′ …). Both live in the piece's poster, each change one undo step.
 */

import { useId } from 'react';
import { posterLength } from '../../render/poster';
import { posterSectionItems } from '../../render/poster-layout';
import { setRowSection, setRowsBy } from '../../render/poster-edit';
import { sectionOf, type ExportForm } from '../export-options';
import { editPoster, editPosterRun } from '../poster-sync';
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

/** The sections in order, each with its New row switch and row label. */
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
      {items.map((it, i) => {
        const name = it.section || 'Start';
        return (
          <li
            key={it.id}
            data-testid="organize-item"
            data-id={it.id}
            data-starts={it.starts ? 'yes' : 'no'}
          >
            <span className="ws-organize-head">
              <span className="ws-organize-time">{posterLength(it.t)}</span>
              <span className="ws-organize-name">{name}</span>
            </span>
            {it.canJoin && (
              <Switch
                label="New row"
                checked={it.newRow}
                disabled={disabled}
                testId={`organize-newrow-${i}`}
                onChange={(on) => editPoster((d) => setRowSection(d, it.id, { join: !on }), 'Rows')}
              />
            )}
            {it.newRow && (
              <div className="field-row">
                <input
                  type="text"
                  aria-label={`Row label for ${name}`}
                  placeholder={it.section || 'Row label'}
                  maxLength={200}
                  spellCheck={false}
                  disabled={disabled}
                  value={it.label}
                  data-testid={`organize-label-${i}`}
                  onChange={(e) =>
                    editPosterRun(
                      `rowlabel:${it.id}`,
                      (d) => setRowSection(d, it.id, { label: e.target.value }, it.section),
                      'Row label',
                    )
                  }
                />
                {it.label !== it.section && (
                  <button
                    type="button"
                    className="swatch-reset"
                    disabled={disabled}
                    aria-label={`${name}: row label back to the section's`}
                    data-testid={`organize-label-reset-${i}`}
                    onClick={() =>
                      editPoster((d) => setRowSection(d, it.id, { label: undefined }), 'Rows')
                    }
                  >
                    Default
                  </button>
                )}
              </div>
            )}
            {it.newRow && !it.starts && (
              <small className="look-note">
                Joins the row before: at most 8 rows, none under 2 seconds.
              </small>
            )}
          </li>
        );
      })}
    </ol>
  );
}
