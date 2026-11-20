import { sliderToWindow, windowToSlider } from '../../render';
import { formatWindow } from '../platform';
import { setColors, setHud, setTheme, setWindow, usePlayer, type ThemePref } from '../store';

const COLORS = [
  ['ink', 'Ink'],
  ['voice', 'Per voice'],
  ['pitch', 'By pitch'],
] as const;

const THEMES: readonly (readonly [ThemePref, string])[] = [
  ['system', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/** The window slider (log scale), line colours, HUD and theme. */
export function ViewBar() {
  const win = usePlayer((s) => s.view.window);
  const duration = usePlayer((s) => s.compiled.duration);
  const colors = usePlayer((s) => s.view.colors);
  const hud = usePlayer((s) => s.view.hud);
  const theme = usePlayer((s) => s.view.theme);

  return (
    <div className="viewbar" data-region="view">
      <label className="ctl">
        <span>Window</span>
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(windowToSlider(win, duration) * 1000)}
          data-testid="window-slider"
          aria-valuetext={formatWindow(win)}
          onChange={(e) => setWindow(sliderToWindow(Number(e.target.value) / 1000, duration))}
        />
        <output data-testid="window-out">{formatWindow(win)}</output>
      </label>

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

      <p className="keys">
        <kbd>Space</kbd> plays and pauses. Pinch, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>-scroll or{' '}
        <kbd>−</kbd> <kbd>=</kbd> changes the window. Drag to pan while paused.
      </p>
    </div>
  );
}
