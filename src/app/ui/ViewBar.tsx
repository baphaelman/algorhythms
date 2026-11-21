import type { FollowMode } from '../../core/types';
import { MIN_WINDOW, sliderToWindow, windowToSlider } from '../../render';
import { formatWindow } from '../platform';
import { Palette } from './Palette';
import { Suggestions } from './Suggestions';
import {
  fitWindow,
  setColors,
  setFollow,
  setHud,
  setTheme,
  setWindow,
  usePlayer,
  zoomBy,
  type ThemePref,
} from '../store';
import { setKeepOrder, useLineOrder } from '../editor/line-order';
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

/** Zoom (log slider, −/+, Fit), Follow, line colours, HUD and theme (PLAN.md §10, §11.2). */
export function ViewBar() {
  const win = usePlayer((s) => s.view.window);
  const duration = usePlayer((s) => s.compiled.duration);
  const colors = usePlayer((s) => s.view.colors);
  const hud = usePlayer((s) => s.view.hud);
  const theme = usePlayer((s) => s.view.theme);
  const follow = usePlayer((s) => s.view.follow);
  const keepOrder = useLineOrder((s) => s.keep);
  const fit = win >= Math.max(MIN_WINDOW, duration) - 1e-6;

  return (
    <div className="viewbar" data-region="view">
      <Palette />
      <Suggestions />
      <div className="ctl zoom" role="group" aria-label="Zoom">
        <span>Zoom</span>
        <button
          type="button"
          className="zoom-step"
          aria-label="Zoom out"
          title="Zoom out (−)"
          data-testid="zoom-out"
          disabled={fit}
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

      <VoicesToggle />

      <p className="keys">
        <kbd>Space</kbd> plays and pauses. Pinch, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>-scroll or{' '}
        <kbd>−</kbd> <kbd>=</kbd> zooms. Scroll sideways or drag to pan (editor: middle-drag or{' '}
        <kbd>Space</kbd>-drag; a plain drag selects dots); panning while playing turns Follow off.
      </p>
    </div>
  );
}
