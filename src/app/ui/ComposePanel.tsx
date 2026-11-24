import { useId } from 'react';
import { closeCompose, composeAgain, stopCompose, useCompose } from '../compose';
import { usePlayer } from '../store';
import './compose.css';

/**
 * The Compose for me side panel (PLAN.md §11.3 "Compose in New piece", "Compose builds in play
 * order", M12): the build's progress and Stop; afterwards "Compose again" reopens the setup
 * (./ComposeSetup.tsx). It takes the inspector's column while open (it closes on the
 * user's own edit); in the player layout it sits under the score.
 */
export function ComposePanel() {
  const id = useId();
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
              ? `Done: ${moments} moments.`
              : `Stopped: ${moments} ${moments === 1 ? 'moment' : 'moments'}.`}
        </p>
      </div>
      <div className="compose-actions">
        {building ? (
          <button type="button" data-testid="compose-stop" onClick={stopCompose}>
            Stop
          </button>
        ) : (
          <>
            <button type="button" data-testid="compose-again" onClick={composeAgain}>
              Compose again
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
    </aside>
  );
}
