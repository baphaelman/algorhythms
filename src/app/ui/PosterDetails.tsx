/**
 * A switch's details in the poster workspace's right panel (PLAN.md §15 M14, the owner's notes:
 * "dropdown on toggle"): a small disclosure beside a switch whose thing has a style opens that
 * group's style controls in place, below it. They are the selection panel's controls
 * (`GroupStyleFields`) with the same doc writes; the switch stays the group's Visible. Which
 * details are open is remembered per viewer (../poster-details).
 */

import type { PosterGroup, PosterLabelGroup, PosterLineGroup } from '../../core/types';
import { setGroupStyle } from '../../render/poster-edit';
import { DETAILS, toggleDetails, useDetails, type DetailsId } from '../poster-details';
import { GROUP_NAMES } from '../poster-select';
import { editPoster } from '../poster-sync';
import { useWorkspace } from '../poster-workspace';
import { usePlayer } from '../store';
import { Switch } from './export-controls';
import { GroupStyleFields, groupVisible } from './PosterEditing';

const panelId = (id: DetailsId) => `details-${id}-panel`;

/** The disclosure beside a switch: opens its group's style below. */
export function DetailsButton({ id, disabled }: { id: DetailsId; disabled?: boolean }) {
  const open = useDetails((s) => s.open.includes(id));
  const { name } = DETAILS[id];
  return (
    <button
      type="button"
      className="ws-details-btn"
      aria-expanded={open}
      aria-controls={open ? panelId(id) : undefined}
      aria-label={`${name}: style`}
      title={open ? 'Hide the style' : 'Style'}
      disabled={disabled}
      data-testid={`details-${id}`}
      onClick={() => toggleDetails(id)}
    >
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
  );
}

/** The style controls a disclosure shows (nothing while it is closed). */
export function DetailsPanel({ id }: { id: DetailsId }) {
  const open = useDetails((s) => s.open.includes(id));
  const layout = useWorkspace((s) => s.layout);
  const doc = usePlayer((s) => s.piece.poster);
  if (!open || !layout) return null;
  const { name, groups } = DETAILS[id];
  return (
    <div
      id={panelId(id)}
      className="ws-details"
      role="group"
      aria-label={`${name} style`}
      data-testid={`details-panel-${id}`}
    >
      {groups.map((g: PosterGroup) => (
        <div key={g} className="ws-details-group">
          {groups.length > 1 && <h4>{GROUP_NAMES[g]}</h4>}
          <GroupStyleFields
            group={g}
            layout={layout}
            doc={doc}
            testPrefix={`det-${g}`}
            showVisible={false}
          />
        </div>
      ))}
    </div>
  );
}

const showGroup = (g: PosterGroup, on: boolean) =>
  editPoster((d) => setGroupStyle(d, g, { visible: on }), on ? 'Show' : 'Hide');

/** A group's Visible switch with its details beside it. */
export function GroupSwitch({
  group,
  label,
  details,
  disabled,
}: {
  group: PosterGroup;
  label: string;
  details: DetailsId;
  disabled?: boolean;
}) {
  const layout = useWorkspace((s) => s.layout);
  if (!layout) return null;
  return (
    <>
      <div className="look-switch-row">
        <Switch
          label={label}
          checked={groupVisible(layout, group)}
          disabled={disabled}
          testId={`show-${group}`}
          onChange={(on) => showGroup(group, on)}
        />
        <DetailsButton id={details} disabled={disabled} />
      </div>
      <DetailsPanel id={details} />
    </>
  );
}

type SplitLabels = PosterLabelGroup & DetailsId;
type SplitLines = PosterLineGroup & DetailsId;

const SPLIT: readonly { name: string; labels: SplitLabels; lines: SplitLines }[] = [
  { name: 'Sections', labels: 'sectionLabels', lines: 'sectionLines' },
  { name: 'Moments', labels: 'momentLabels', lines: 'momentLines' },
  { name: 'Guides', labels: 'guideLabels', lines: 'guideLines' },
];

/** Labels and their lines, switched apart, for sections, moments and guides; each with details. */
export function LabelLineToggles({ disabled }: { disabled: boolean }) {
  const layout = useWorkspace((s) => s.layout);
  if (!layout) return null;
  return (
    <fieldset className="field ws-split" disabled={disabled} data-testid="label-line-toggles">
      <legend>Labels and lines</legend>
      {SPLIT.map((r) => (
        <div key={r.name} className="ws-split-block">
          <div className="ws-split-row">
            <span>{r.name}</span>
            {[r.labels, r.lines].map((g) => (
              <span key={g} className="look-switch-row">
                <Switch
                  label={g === r.labels ? 'Labels' : 'Lines'}
                  checked={groupVisible(layout, g)}
                  testId={`show-${g}`}
                  onChange={(on) => showGroup(g, on)}
                />
                <DetailsButton id={g} />
              </span>
            ))}
          </div>
          <DetailsPanel id={r.labels} />
          <DetailsPanel id={r.lines} />
        </div>
      ))}
    </fieldset>
  );
}
