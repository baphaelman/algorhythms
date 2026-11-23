import { Fragment, useEffect, useId, useRef } from 'react';
import type { Suggestion } from '../../core/suggest';
import {
  addSuggestion,
  appendMoment,
  suggestionKey,
  useSuggestions,
  watchSuggestions,
} from '../editor/suggestions';
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
 * Next-move suggestions, "Next" (PLAN.md §11.3, revisions 6–7, 14): up to four cards appended at
 * the end of the piece's last moment (core/suggest.ts). In a key with chord theory, one card per
 * chord job: "<Chord> · <Job> (<numeral>)", the best fit marked ★, a short reason in the
 * tooltip. Otherwise the composer's moves with their icons. Its own group, styled
 * apart from the "Add" palette. Click appends one (one undo entry) and selects it; hovering for
 * 300 ms previews it silently on the score (../preview.ts).
 */
export function Suggestions() {
  const items = useSuggestions((s) => s.items);
  const t = useSuggestions((s) => s.t);
  const uid = useId();
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
      startMomentPreview(s.moment, s.label, appendMoment);
    }, PREVIEW_DELAY_MS);
  };

  return (
    <div
      className="palette suggestions"
      role="toolbar"
      aria-label="Suggested next moments, added at the end"
      data-testid="suggestions"
      data-t={Number.isFinite(t) ? t : undefined}
    >
      <span
        className="palette-label"
        aria-hidden="true"
        title={`Next, appended at the end${Number.isFinite(t) ? ` (${clock(t)})` : ''}`}
      >
        Next{' '}
        <span className="visually-hidden">at end{Number.isFinite(t) ? ` ${clock(t)}` : ''}</span>
      </span>
      {items.length === 0 && <span className="suggest-none">nothing sounding at the end</span>}
      {items.map((s, i) => {
        const desc = `${uid}-d${i}`;
        // A theory card: "G7", " · " (narrow spaces), "Tension", then the numeral set smaller "(V7)".
        const num = s.job ? /^(.*?) · (.*) \(([^)]+)\)$/.exec(s.label) : null;
        return (
          <Fragment key={suggestionKey(t, i, s)}>
            <button
              type="button"
              data-suggestion={i}
              data-kind={s.kind}
              data-job={s.job}
              data-best={s.best || undefined}
              data-label={s.label}
              title={`${s.best ? 'Best fit. ' : ''}${s.tooltip}`}
              aria-describedby={desc}
              onPointerEnter={() => hover(s)}
              onPointerLeave={cancelHover}
              onClick={() => {
                cancelHover();
                addSuggestion(s);
              }}
            >
              {!s.job && (
                <span className="palette-icon" aria-hidden="true">
                  {ICON[s.kind]}
                </span>
              )}
              {num ? (
                <>
                  <span>
                    {num[1]}
                    <span className="suggest-sep"> · </span>
                    {num[2]}
                  </span>{' '}
                  <span className="suggest-num">({num[3]})</span>
                </>
              ) : (
                s.label
              )}
              {s.best && (
                <span className="suggest-best" aria-hidden="true">
                  ★
                </span>
              )}
            </button>
            <span id={desc} className="visually-hidden">
              {s.best ? 'Best fit. ' : ''}
              {s.tooltip}. Appends at {clock(s.moment.at)}.
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
