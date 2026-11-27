import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { attachKeys } from './canvas-input';
import { attachFileDrop } from './file-drop';
import { attachLiveKeys } from './live-ui';
import { useCompose } from './compose';
import './naming';
import { attachPinchZoom } from './pinch-zoom';
import { startPersistence } from './persist';
import { startAddressBar } from './address';
import { startPlayer } from './store';
import { ComposePanel } from './ui/ComposePanel';
import { ComposeSetup } from './ui/ComposeSetup';
import { AudioDialog } from './ui/AudioDialog';
import { PosterWorkspace, WorkspaceBar } from './ui/PosterWorkspace';
import { VideoWorkspace } from './ui/VideoWorkspace';
import { startPosterSync } from './poster-sync';
import { startVideoSync } from './video-sync';
import { useExportSurface } from './export-surface';
import { GeneratePanel } from './ui/GeneratePanel';
import { Inspector } from './ui/Inspector';
import { Lane } from './ui/Lane';
import { Menu } from './ui/Menu';
import { MyPieces } from './ui/MyPieces';
import { NamePrompt } from './ui/NamePrompt';
import { ShareDialog } from './ui/ShareDialog';
import { Notices, SilentHint } from './ui/Notices';
import { LoopRegion } from './ui/LoopRegion';
import { Playhead } from './ui/Playhead';
import { Ruler } from './ui/Ruler';
import { ScoreView } from './ui/ScoreView';
import { TouchMenu } from './ui/TouchMenu';
import { Scrubber, Transport } from './ui/Transport';
import { UndoRedo } from './ui/UndoRedo';
import { ViewBar } from './ui/ViewBar';
import { LiveDrawer } from './ui/LiveDrawer';
import { SoundDrawer } from './ui/SoundDrawer';
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

/** The editor's box (px, within `.app`) while the poster workspace covers it. */
interface Frozen {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The player and editor (PLAN.md §11.1–§11.5). The editor layout puts the ruler, score and lane
 * rows in one `.timeline` box under a single DOM playhead; screens under 900 px get the player
 * only (score and scrubber, the canvas drawing the playhead). Export's poster workspace (M14)
 * (and its Video mode, M15) takes the editor's place; the editor stays mounted underneath, hidden, inert and at its size,
 * so its playhead, zoom and scroll are exactly as they were when it returns.
 */
export function App() {
  const wide = useWide();
  const composing = useCompose((s) => s.open);
  const surface = useExportSurface((s) => s.surface);
  // The workspace (Poster or Video) shows in the editor's place.
  const poster = surface === 'poster' || surface === 'video';
  const timeline = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  /** The editor's last box in the flow: where it stays, hidden, while the workspace shows. */
  const box = useRef<Frozen | null>(null);

  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return;
    el.inert = poster;
    if (poster) {
      const b = box.current;
      if (b) {
        el.style.left = `${b.left}px`;
        el.style.top = `${b.top}px`;
        el.style.width = `${b.width}px`;
        el.style.height = `${b.height}px`;
      }
      return () => {
        el.style.left = el.style.top = el.style.width = el.style.height = '';
      };
    }
    const measure = () => {
      box.current = {
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
      };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      removeEventListener('resize', measure);
    };
  }, [poster]);

  useEffect(() => {
    startPersistence();
    startAddressBar();
    startPlayer();
    const detachLive = attachLiveKeys();
    const detach = attachKeys();
    const detachDrop = attachFileDrop();
    return () => {
      detachDrop();
      detach();
      detachLive();
    };
  }, []);

  // A pinch or ⌘/Ctrl-scroll anywhere on the timeline zooms the editor, not the page.
  useEffect(() => attachPinchZoom(timeline.current!), []);

  return (
    <div
      className="app"
      data-layout={wide ? 'full' : 'player'}
      data-mode={poster ? surface : undefined}
    >
      <Transport history={poster ? <WorkspaceBar /> : wide && <UndoRedo />}>
        <Menu />
      </Transport>
      <GeneratePanel />
      <ComposeSetup />
      <AudioDialog />
      <MyPieces />
      <NamePrompt />
      <ShareDialog />
      <SilentHint />
      <Notices />
      {poster && <WorkspaceSync />}
      {surface === 'poster' && <PosterWorkspace />}
      {surface === 'video' && <VideoWorkspace />}
      <main
        ref={main}
        className={poster ? 'workspace frozen' : 'workspace'}
        aria-hidden={poster || undefined}
      >
        {/* Everything on the shared time axis (§10); the editor's one playhead spans it all. */}
        <div ref={timeline} className="timeline" data-testid="timeline">
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
      {wide && !poster && <VoicesDrawer />}
      {wide && !poster && <SoundDrawer />}
      {wide && !poster && <LiveDrawer />}
      {wide && !poster && <TouchMenu />}
    </div>
  );
}

/**
 * While the workspace shows (either mode), the form's poster options and the piece's poster stay
 * in step (./poster-sync): the video plays the poster, and its section is the poster's. In Video,
 * the form's video options and the piece's video record too (./video-sync, M17).
 */
function WorkspaceSync() {
  useLayoutEffect(() => {
    const stopPoster = startPosterSync();
    const stopVideo = startVideoSync();
    return () => {
      stopVideo();
      stopPoster();
    };
  }, []);
  return null;
}
