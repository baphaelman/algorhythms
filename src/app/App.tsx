import { useEffect, useSyncExternalStore } from 'react';
import { attachKeys } from './canvas-input';
import { startPlayer } from './store';
import { ExportDialog } from './ui/ExportDialog';
import { GeneratePanel } from './ui/GeneratePanel';
import { Inspector } from './ui/Inspector';
import { Menu } from './ui/Menu';
import { Notices, SilentHint } from './ui/Notices';
import { ScoreView } from './ui/ScoreView';
import { Scrubber, Transport } from './ui/Transport';
import { ViewBar } from './ui/ViewBar';

/** Width from which the editor layout is used (PLAN.md §11.5); narrower screens get the player only. */
export const EDITOR_MIN_WIDTH = 900;

const WIDE = `(min-width: ${EDITOR_MIN_WIDTH}px)`;

function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const q = matchMedia(WIDE);
      q.addEventListener('change', notify);
      return () => q.removeEventListener('change', notify);
    },
    () => matchMedia(WIDE).matches,
    () => true,
  );
}

/**
 * The player (PLAN.md §11.1–§11.5). Layout leaves room for the editor (M4): a moment-lane slot
 * under the score and an inspector column, both empty and hidden until the editor fills them. On
 * screens under 900 px only the player parts are rendered.
 */
export function App() {
  const wide = useWide();

  useEffect(() => {
    startPlayer();
    return attachKeys();
  }, []);

  return (
    <div className="app" data-layout={wide ? 'full' : 'player'}>
      <Transport>
        <Menu />
      </Transport>
      <GeneratePanel />
      <ExportDialog />
      <SilentHint />
      <Notices />
      <main className="workspace">
        <ScoreView />
        {wide && <div className="slot lane" data-slot="lane" hidden />}
        <Scrubber />
        <ViewBar />
        {wide && <Inspector />}
      </main>
    </div>
  );
}
