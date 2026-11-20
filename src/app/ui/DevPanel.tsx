import { devEnabled, setAllowCrossings, useDevOptions } from '../dev-options';
import { recompileNow } from '../store';

const SHOW = devEnabled();

/**
 * Temporary developer switches (only with `?dev` in the URL). They are session-only: not stored
 * in the piece, a file or a share link.
 */
export function DevPanel() {
  const allow = useDevOptions((s) => s.allowCrossings);
  if (!SHOW) return null;
  return (
    <aside className="dev-panel" aria-label="Developer options" data-testid="dev-panel">
      <strong>dev</strong>
      <label className="check">
        <input
          type="checkbox"
          checked={allow}
          data-testid="dev-crossings"
          onChange={(e) => {
            setAllowCrossings(e.target.checked);
            recompileNow();
          }}
        />
        <span>Allow line crossings</span>
      </label>
    </aside>
  );
}
