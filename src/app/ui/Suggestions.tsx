import { Fragment, useEffect, useId } from 'react';
import type { Suggestion } from '../../core/suggest';
import {
  addSuggestion,
  appendMoment,
  suggestionKey,
  useSuggestions,
  watchSuggestions,
} from '../editor/suggestions';
import { startMomentPreview } from '../preview';
import { keyboardFocus, useCardHover } from './card-hover';
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
 * chord job: "<Chord> · <Job>", the best fit marked ★; the numeral and a short reason go in the
 * tooltip and the description. Otherwise the composer's moves with their icons. Its own group, styled
 * apart from the "Add" palette. Click appends one (one undo entry) and selects it; hovering (or
 * keyboard-focusing) one for 250 ms previews it on the score (../preview.ts) and plays it (M13,
 * ../hover-sound.ts). A card that isn't a theory card names its result ("→ Dm7").
 */
export function Suggestions() {
  const items = useSuggestions((s) => s.items);
  const t = useSuggestions((s) => s.t);
  const results = useSuggestions((s) => s.results);
  const uid = useId();
  const { hover: hoverCard, cancel: cancelHover } = useCardHover();

  useEffect(() => watchSuggestions(), []);

  const hover = (s: Suggestion): void =>
    hoverCard(() => startMomentPreview(s.moment, s.label, appendMoment));

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
        // A theory card: "G7", " · " (narrow spaces), "Tension"; its numeral "V7" in the tooltip.
        const num = s.job ? /^(.*?) · (.*) \(([^)]+)\)$/.exec(s.label) : null;
        const about = `${num ? `${num[3]}. ` : ''}${s.best ? 'Best fit. ' : ''}${s.tooltip}`;
        const result = results[i] || undefined;
        return (
          <Fragment key={suggestionKey(t, i, s)}>
            <button
              type="button"
              data-suggestion={i}
              data-kind={s.kind}
              data-job={s.job}
              data-best={s.best || undefined}
              data-label={s.label}
              data-result={result}
              title={about}
              aria-describedby={desc}
              onPointerEnter={() => hover(s)}
              onPointerLeave={cancelHover}
              onFocus={(ev) => {
                if (keyboardFocus(ev.currentTarget)) hover(s);
              }}
              onBlur={cancelHover}
              onClick={() => {
                cancelHover();
                addSuggestion(s);
              }}
            >
              <span className="card-text">
                <span className="card-name">
                  {!s.job && (
                    <span className="palette-icon" aria-hidden="true">
                      {ICON[s.kind]}
                    </span>
                  )}
                  {num ? (
                    <span>
                      {num[1]}
                      <span className="suggest-sep"> · </span>
                      {num[2]}
                    </span>
                  ) : (
                    s.label
                  )}
                  {s.best && (
                    <span className="suggest-best" aria-hidden="true">
                      ★
                    </span>
                  )}
                </span>
                {result && <span className="card-result">{result}</span>}
              </span>
            </button>
            <span id={desc} className="visually-hidden">
              {about}. Appends at {clock(s.moment.at)}.
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
