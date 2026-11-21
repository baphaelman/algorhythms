import { useId } from 'react';
import {
  closeCompose,
  finish,
  restartCompose,
  setComposeInput,
  stopCompose,
  useCompose,
} from '../compose';
import { usePlayer } from '../store';
import { GenerateFields } from './GenerateFields';
import './compose.css';

/**
 * The Compose for me side panel (PLAN.md §11.3 "Compose in New piece"): Generate's inputs, live
 * (a change restarts the build), the build's progress, Skip and Stop. It takes the inspector's
 * column while open; in the player layout it sits under the score.
 */
export function ComposePanel() {
  const id = useId();
  const form = useCompose((s) => s.form);
  const errors = useCompose((s) => s.errors);
  const status = useCompose((s) => s.status);
  const step = useCompose((s) => s.step);
  const total = useCompose((s) => s.total);
  const activity = useCompose((s) => s.activity);
  const moments = usePlayer((s) => s.piece.moments.length);
  const building = status === 'building';

  return (
    <aside
      className="slot compose dialog"
      aria-labelledby={`${id}-title`}
      data-testid="compose-panel"
      data-status={status}
    >
      <h2 id={`${id}-title`}>Compose for me</h2>
      <div className="compose-progress" aria-live="polite" data-testid="compose-status">
        <progress value={step} max={Math.max(1, total)} aria-label="Composing" />
        <p>
          {building
            ? `${activity} · ${moments} ${moments === 1 ? 'moment' : 'moments'}`
            : status === 'done'
              ? `Done: ${moments} moments. Edit it like any piece.`
              : `Stopped after ${step} of ${total} steps: ${moments} ${moments === 1 ? 'moment' : 'moments'}.`}
        </p>
      </div>
      <div className="compose-actions">
        {building ? (
          <>
            <button type="button" data-testid="compose-stop" onClick={stopCompose}>
              Stop
            </button>
            <button type="button" className="primary" data-testid="compose-skip" onClick={finish}>
              Skip
            </button>
          </>
        ) : (
          <>
            <button type="button" data-testid="compose-again" onClick={restartCompose}>
              Build again
            </button>
            <button
              type="button"
              className="primary"
              data-testid="compose-close"
              onClick={closeCompose}
            >
              Done
            </button>
          </>
        )}
      </div>
      <p className="compose-note">Change anything below and the composer starts over from it.</p>
      <GenerateFields
        id={id}
        form={form}
        errors={errors}
        testPrefix="compose"
        onChange={setComposeInput}
      />
    </aside>
  );
}
