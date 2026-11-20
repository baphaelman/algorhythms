import { useEffect, useRef } from 'react';
import type { Suggestion } from '../../core/suggest';
import { addSuggestion, useSuggestions, watchSuggestions } from '../editor/suggestions';
import { PREVIEW_DELAY_MS, startMomentPreview, stopPreview } from '../preview';
import './palette.css';

const ICON: Record<Suggestion['kind'], string> = {
  open: '◆',
  chord: '◆',
  split: '⑂',
  walk: '▭',
  thin: '⋎',
  collapse: '◇',
  level: '◢',
};

/** `m:ss.s` for a tooltip. */
function clock(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/**
 * Next-move suggestions (PLAN.md §11.3, revision 6): 3–4 moves after the selected moment (or at
 * the playhead), from the Generate composer's grammar (core/suggest.ts). Click adds one (one undo
 * entry) and selects it; hovering for 300 ms previews it (../preview.ts).
 */
export function Suggestions() {
  const items = useSuggestions((s) => s.items);
  const t = useSuggestions((s) => s.t);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stop = watchSuggestions();
    return () => {
      stop();
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    };
  }, []);

  const cancelHover = (): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    stopPreview();
  };
  const hover = (s: Suggestion): void => {
    cancelHover();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      startMomentPreview(s.moment, s.label);
    }, PREVIEW_DELAY_MS);
  };

  return (
    <div
      className="palette suggestions"
      role="toolbar"
      aria-label="Suggested next moments"
      data-testid="suggestions"
      data-t={Number.isFinite(t) ? t : undefined}
    >
      <span className="palette-label">Next</span>
      {items.length === 0 && <span className="suggest-none">nothing sounding here</span>}
      {items.map((s, i) => (
        <button
          key={`${t}:${s.label}`}
          type="button"
          data-suggestion={i}
          data-kind={s.kind}
          data-label={s.label}
          title={`Add at ${clock(s.moment.at)} (hover to hear)`}
          onPointerEnter={() => hover(s)}
          onPointerLeave={cancelHover}
          onClick={() => {
            cancelHover();
            addSuggestion(s);
          }}
        >
          <span className="palette-icon" aria-hidden="true">
            {ICON[s.kind]}
          </span>
          {s.label}
        </button>
      ))}
    </div>
  );
}
