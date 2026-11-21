/**
 * Note point fields (§11.3, revision 6): per change (revision 7: a grouped "Shift" has several)
 * `from → to` as note names with ▲/▼ on `to` (one scale step in the key), the chord before → after
 * (compiled harmony), "Keep lines in order" (`order`) and "Return after" (`back`).
 */

import { noteChanges } from '../../../core/moments/note';
import type { Key, NoteMoment } from '../../../core/types';
import { noteLabel } from '../../../render';
import { stepNote, updateMoment } from '../../editor/actions';
import { DEFAULT_BACK, noteHarmony } from '../../editor/note-points';
import { usePlayer } from '../../store';
import { CheckField, NumberField, Row, fieldSetter } from './controls';

export function NoteFields({ m, keyAt }: { m: NoteMoment; keyAt: Key }) {
  const compiled = usePlayer((s) => s.compiled);
  const { before, after } = noteHarmony(compiled, m);
  const list = noteChanges(m);
  const back = fieldSetter<number>(m.id, 'Edit return', (_x, v) => ({ back: v }));
  return (
    <>
      {list.map((c, i) => {
        const from = noteLabel(c.from, keyAt);
        const to = noteLabel(c.to, keyAt);
        return (
          <Row key={i} label={list.length > 1 ? `Note ${i + 1}` : 'Note'}>
            <span className="insp-note-move" data-testid="insp-note-move">
              <span data-testid="insp-note-from">{from}</span> →{' '}
              <span data-testid="insp-note-to">{to}</span>
            </span>
            <button
              type="button"
              className="step-move"
              data-testid="insp-note-up"
              aria-label={`Up a scale step: ${to}`}
              onClick={() => stepNote(m.id, 1, i)}
            >
              ▲
            </button>
            <button
              type="button"
              className="step-move"
              data-testid="insp-note-down"
              aria-label={`Down a scale step: ${to}`}
              onClick={() => stepNote(m.id, -1, i)}
            >
              ▼
            </button>
          </Row>
        );
      })}
      <Row label="Chord">
        <span data-testid="insp-note-chord">
          <span data-testid="insp-note-chord-before">{before ?? '—'}</span> →{' '}
          <span data-testid="insp-note-chord-after">{after ?? '—'}</span>
        </span>
      </Row>
      <CheckField
        label="Keep lines in order"
        checked={m.order === true}
        testId="insp-note-order"
        onChange={(on) =>
          updateMoment(
            m.id,
            { order: on ? true : undefined },
            on ? 'Keep lines in order' : 'Let lines cross',
          )
        }
      />
      <CheckField
        label="Return after"
        checked={m.back !== undefined}
        testId="insp-note-return"
        onChange={(on) =>
          updateMoment(
            m.id,
            { back: on ? DEFAULT_BACK : undefined },
            on ? 'Return note' : 'Keep note',
          )
        }
      />
      {m.back !== undefined && (
        <NumberField
          label="Return after"
          unit="s"
          value={m.back}
          set={back}
          min={0}
          max={120}
          step={0.1}
          slider={{ min: 0, max: Math.max(8, Math.ceil(m.back)) }}
          testId="insp-note-back"
        />
      )}
    </>
  );
}
