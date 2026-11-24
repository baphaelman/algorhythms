import { useEffect, useRef } from 'react';
import type { FollowMode } from '../../core/types';
import { MIN_WINDOW, sliderToWindow, windowRange, windowToSlider } from '../../render';
import { formatWindow } from '../platform';
import { Palette } from './Palette';
import { Suggestions } from './Suggestions';
import { BarPopover } from './BarPopover';
import {
  fitWindow,
  setCameraPath,
  setColors,
  setFollow,
  setHud,
  setSnapBeats,
  setTheme,
  setWindow,
  usePlayer,
  zoomBy,
  type ThemePref,
} from '../store';
import { setKeepOrder, useLineOrder } from '../editor/line-order';
import { refreshSuggestions } from '../editor/suggestions';
import { beatStep } from '../editor/snap';
import { LiveToggle } from './LiveDrawer';
import { SoundToggle } from './SoundDrawer';
import { VoicesToggle } from './VoicesDrawer';

const COLORS = [
  ['ink', 'Ink'],
  ['pitch', 'By pitch'],
  ['custom', 'Custom'],
] as const;

const FOLLOW: readonly (readonly [FollowMode, string, string])[] = [
  ['smooth', 'Smooth', 'The view scrolls with the playhead at 35 %'],
  ['page', 'Page', 'The view turns a page as the playhead nears the right edge'],
  ['off', 'Off', 'The view never moves by itself'],
];

const THEMES: readonly (readonly [ThemePref, string])[] = [
  ['system', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/**
 * The bar under the lanes (PLAN.md §10, §11.2), compact (build-log "Compact view bar"): Add and
 * Next on one row when they fit; then Zoom, Follow, Camera, Snap, the drawer toggles, and the "View ▾"
 * (line colours, theme, HUD, line order) and "?" (help) popovers.
 */
export function ViewBar() {
  const win = usePlayer((s) => s.view.window);
  const duration = usePlayer((s) => s.compiled.duration);
  const colors = usePlayer((s) => s.view.colors);
  const hud = usePlayer((s) => s.view.hud);
  const theme = usePlayer((s) => s.view.theme);
  const follow = usePlayer((s) => s.view.follow);
  const cameraPath = usePlayer((s) => s.view.cameraPath);
  const keepOrder = useLineOrder((s) => s.keep);
  const view = usePlayer((s) => s.piece.view);
  // "Snap to beats" shows when the piece has a tempo, on unless the piece turned it off.
  const hasTempo = beatStep({ gridBpm: view.gridBpm }) !== null;
  const snapBeats = hasTempo && view.snapBeats !== false;
  // The window can open past the piece (open-ended canvas); Fit is the whole piece exactly.
  const fit = Math.abs(win - Math.max(MIN_WINDOW, duration)) < 1e-6;
  const widest = win >= windowRange(duration)[1] - 1e-6;

  // Its height (it wraps) goes into the workspace's minimum (styles.css `--viewbar-h`).
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    const app = el?.closest<HTMLElement>('.app');
    if (!el || !app) return;
    const set = (): void => app.style.setProperty('--viewbar-h', `${el.offsetHeight}px`);
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => {
      ro.disconnect();
      app.style.removeProperty('--viewbar-h');
    };
  }, []);

  return (
    <div ref={bar} className="viewbar" data-region="view">
      <div className="vb-make">
        <Palette />
        <Suggestions />
      </div>
      <div className="vb-row">
        <div className="ctl zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="zoom-step"
            aria-label="Zoom out"
            title="Zoom out (−)"
            data-testid="zoom-out"
            disabled={widest}
            onClick={() => zoomBy(1.25)}
          >
            −
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(windowToSlider(win, duration) * 1000)}
            data-testid="window-slider"
            aria-label="Visible window"
            aria-valuetext={formatWindow(win)}
            title="Visible window"
            onChange={(e) => setWindow(sliderToWindow(Number(e.target.value) / 1000, duration))}
          />
          <button
            type="button"
            className="zoom-step"
            aria-label="Zoom in"
            title="Zoom in (=)"
            data-testid="zoom-in"
            disabled={win <= MIN_WINDOW + 1e-6}
            onClick={() => zoomBy(0.8)}
          >
            +
          </button>
          <output data-testid="window-out">{formatWindow(win)}</output>
          <button
            type="button"
            aria-pressed={fit}
            data-testid="zoom-fit"
            title="Show the whole piece"
            onClick={fitWindow}
          >
            Fit
          </button>
        </div>

        <div className="ctl" role="group" aria-label="Follow">
          <span>Follow</span>
          <div className="seg">
            {FOLLOW.map(([value, label, title]) => (
              <button
                key={value}
                type="button"
                aria-pressed={follow === value}
                data-follow={value}
                title={title}
                onClick={() => setFollow(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="toggle camera-path-toggle"
          aria-pressed={cameraPath}
          data-testid="camera-path-toggle"
          title="While playing, the view moves as the video's camera will (Export → Camera). Panning or zooming turns it off."
          onClick={() => setCameraPath(!cameraPath)}
        >
          Camera
        </button>

        {hasTempo && (
          <button
            type="button"
            className="toggle snap-beats-toggle"
            aria-pressed={snapBeats}
            data-testid="snap-beats-toggle"
            title="Adding and dragging moments, dots and notes snap to beats (Alt: free)"
            onClick={() => {
              setSnapBeats(!snapBeats);
              refreshSuggestions(true);
            }}
          >
            Snap<span className="vb-long"> to beats</span>
          </button>
        )}

        <div className="vb-end">
          <VoicesToggle />
          <SoundToggle />
          <LiveToggle />
          <BarPopover
            label="View ▾"
            title="Line colours, theme, HUD, line order"
            panelLabel="View options"
            testId="view-options"
          >
            <div className="ctl" role="group" aria-label="Line colour">
              <span>Lines</span>
              <div className="seg">
                {COLORS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={colors === value}
                    data-color={value}
                    onClick={() => setColors(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="ctl" role="group" aria-label="Theme">
              <span>Theme</span>
              <div className="seg">
                {THEMES.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={theme === value}
                    data-theme-choice={value}
                    onClick={() => setTheme(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="vb-pop-toggles">
              <button
                type="button"
                className="toggle"
                aria-pressed={hud}
                data-testid="hud-toggle"
                title="Heads-up display"
                onClick={() => setHud(!hud)}
              >
                HUD
              </button>

              <button
                type="button"
                className="toggle keep-order-toggle"
                aria-pressed={keepOrder}
                data-testid="keep-order-toggle"
                title="Hand edits (dragged dots, note points, chord notes) keep lines from crossing"
                onClick={() => setKeepOrder(!keepOrder)}
              >
                Keep lines in order
              </button>
            </div>
          </BarPopover>
          <BarPopover
            label="?"
            ariaLabel="Help"
            title="Playing, zooming and panning"
            panelLabel="Help"
            testId="view-help"
            className="vb-help"
          >
            <p className="keys">
              <kbd>Space</kbd> plays and pauses. Pinch, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>-scroll or{' '}
              <kbd>−</kbd> <kbd>=</kbd> zooms. Scroll sideways or drag to pan (editor: middle-drag
              or <kbd>Space</kbd>-drag; a plain drag selects dots); panning while playing turns
              Follow off. More keys: Menu → Help.
            </p>
          </BarPopover>
        </div>
      </div>
    </div>
  );
}
