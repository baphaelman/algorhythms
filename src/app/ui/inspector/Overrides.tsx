/**
 * A moment's per-voice overrides (§11.3 "Every dot is draggable", revision 6): one row per voice
 * (its note and/or arrival, written by dragging a dot), each with ×, and Clear for all.
 */

import type { Key, Moment, Piece } from '../../../core/types';
import { noteLabel } from '../../../render';
import { clearOverride, clearOverrides } from '../../editor/actions';

export function Overrides({ m, piece, keyAt }: { m: Moment; piece: Piece; keyAt: Key }) {
  const list = m.overrides ?? [];
  if (list.length === 0) return null;
  return (
    <fieldset className="insp-group" data-testid="insp-overrides">
      <legend>
        Overrides
        <button
          type="button"
          className="link"
          data-testid="insp-overrides-clear"
          onClick={() => clearOverrides(m.id)}
        >
          Clear
        </button>
      </legend>
      <ul className="insp-note-list">
        {list.map((o) => {
          const v = piece.voices[o.voice];
          const name = v?.name ?? v?.id ?? `#${o.voice}`;
          const parts: string[] = [];
          if (o.pitch !== undefined) parts.push(noteLabel(o.pitch, keyAt));
          if (o.end !== undefined) parts.push(`arrives +${o.end.toFixed(2)} s`);
          return (
            <li key={o.voice} data-testid="insp-override" data-voice={o.voice}>
              <span className="note-name">
                {name}: {parts.join(', ')}
              </span>
              <button
                type="button"
                className="step-move"
                aria-label={`Clear the override of ${name}`}
                onClick={() => clearOverride(m.id, o.voice)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
