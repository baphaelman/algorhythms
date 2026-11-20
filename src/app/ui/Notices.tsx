import { useMemo } from 'react';
import { needsSilentModeHint } from '../platform';
import { dismissNotice, usePlayer } from '../store';

/** Messages from loading files and links (errors and warnings), each dismissible. */
export function Notices() {
  const notices = usePlayer((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="notices" data-testid="notices">
      {notices.map((n) => (
        <section
          key={n.id}
          className={`notice ${n.kind}`}
          role={n.kind === 'error' ? 'alert' : 'status'}
          data-kind={n.kind}
        >
          <div className="notice-text">
            <strong>{n.title}</strong>
            {n.lines.length > 0 && (
              <ul>
                {n.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            aria-label={`Dismiss: ${n.title}`}
            onClick={() => dismissNotice(n.id)}
          >
            Dismiss
          </button>
        </section>
      ))}
    </div>
  );
}

/** One line for iOS browsers without `navigator.audioSession`: the silent switch mutes the page. */
export function SilentHint() {
  const show = useMemo(() => needsSilentModeHint(navigator), []);
  if (!show) return null;
  return (
    <p className="hint" data-testid="silent-hint">
      Turn off silent mode to hear sound.
    </p>
  );
}
