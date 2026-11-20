import { addAtPlayhead, PALETTE } from '../editor/shortcuts';
import './palette.css';

/** The moment palette (PLAN.md §11.3): each button adds that moment at the playhead. */
export function Palette() {
  return (
    <div className="palette" role="toolbar" aria-label="Add moment" data-testid="palette">
      <span className="palette-label">Add</span>
      {PALETTE.map((e) => (
        <button
          key={e.type}
          type="button"
          data-moment={e.type}
          title={`${e.hint} (${e.key})`}
          aria-keyshortcuts={e.key}
          onClick={() => addAtPlayhead(e.type)}
        >
          <span className="palette-icon" aria-hidden="true">
            {e.icon}
          </span>
          {e.name}
        </button>
      ))}
    </div>
  );
}
