import { useEffect, useSyncExternalStore } from 'react';
import { attachKeys } from './canvas-input';
import { useCompose } from './compose';
import './naming';
import { startPersistence } from './persist';
import { startPlayer } from './store';
import { ComposePanel } from './ui/ComposePanel';
import { ExportDialog } from './ui/ExportDialog';
import { GeneratePanel } from './ui/GeneratePanel';
import { Inspector } from './ui/Inspector';
import { Lane } from './ui/Lane';
import { Menu } from './ui/Menu';
import { MyPieces } from './ui/MyPieces';
import { NamePrompt } from './ui/NamePrompt';
import { Notices, SilentHint } from './ui/Notices';
import { LoopRegion } from './ui/LoopRegion';
import { Playhead } from './ui/Playhead';
import { Ruler } from './ui/Ruler';
import { ScoreView } from './ui/ScoreView';
import { Scrubber, Transport } from './ui/Transport';
import { UndoRedo } from './ui/UndoRedo';
import { ViewBar } from './ui/ViewBar';
import { VoicesDrawer } from './ui/VoicesDrawer';

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
 * The player and editor (PLAN.md §11.1–§11.5). The editor layout puts the ruler, score and lane
 * rows in one `.timeline` box under a single DOM playhead; screens under 900 px get the player
 * only (score and scrubber, the canvas drawing the playhead).
 */
export function App() {
  const wide = useWide();
  const composing = useCompose((s) => s.open);

  useEffect(() => {
    startPersistence();
    startPlayer();
    return attachKeys();
  }, []);

  return (
    <div className="app" data-layout={wide ? 'full' : 'player'}>
      <Transport history={wide && <UndoRedo />}>
        <Menu />
      </Transport>
      <GeneratePanel />
      <ExportDialog />
      <MyPieces />
      <NamePrompt />
      <SilentHint />
      <Notices />
      <main className="workspace">
        {/* Everything on the shared time axis (§10); the editor's one playhead spans it all. */}
        <div className="timeline" data-testid="timeline">
          {wide && <Ruler />}
          <ScoreView editor={wide} />
          {wide && <Lane />}
          {wide && <LoopRegion />}
          {wide && <Playhead />}
        </div>
        {!wide && <Scrubber />}
        <ViewBar />
        {composing ? <ComposePanel /> : wide && <Inspector />}
      </main>
      {wide && <VoicesDrawer />}
    </div>
  );
}
