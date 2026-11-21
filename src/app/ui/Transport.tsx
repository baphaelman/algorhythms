import { useCallback, useEffect, useRef } from 'react';
import { live } from '../dom';
import { clampLoop } from '../ruler';
import { scrubEnd, scrubTo, toggleLoop, togglePlay, usePlayer } from '../store';

/** Play/pause, the time readout, the meter and the key and voice status. */
export function Transport({
  children,
  history,
}: {
  children?: React.ReactNode;
  /** Shown after Loop: the editor's Undo and Redo. */
  history?: React.ReactNode;
}) {
  const status = usePlayer((s) => s.transport.status);
  const title = usePlayer((s) => s.piece.meta.title);
  const playing = status === 'playing';
  const loopOn = usePlayer((s) => s.piece.view.loop?.on !== false);
  const hasLoop = usePlayer((s) => clampLoop(s.piece.view.loop, s.compiled.duration) !== null);
  const looping = hasLoop && loopOn;

  const time = useCallback((el: HTMLElement | null) => (live.time = el), []);
  const duration = useCallback((el: HTMLElement | null) => (live.duration = el), []);
  const keyStatus = useCallback((el: HTMLElement | null) => (live.status = el), []);
  const meter = useCallback((el: HTMLElement | null) => (live.meter = el), []);

  return (
    <header className="transport" data-region="transport">
      <button
        type="button"
        className="primary play"
        data-testid="play"
        aria-keyshortcuts="Space"
        onClick={togglePlay}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        className="loop-toggle"
        data-testid="loop-toggle"
        aria-pressed={looping}
        aria-keyshortcuts="\"
        disabled={!hasLoop}
        title={
          hasLoop
            ? 'Loop the region (\\)'
            : 'Loop: drag on the top strip of the ruler to set a region first'
        }
        onClick={() => toggleLoop()}
      >
        Loop
      </button>
      {history}
      <div className="readout" role="timer" aria-label="Playback time">
        <span ref={time} data-testid="time" />
        <span className="sep"> / </span>
        <span ref={duration} data-testid="duration" />
      </div>
      <div className="meter" aria-hidden="true">
        <div className="meter-bar" ref={meter} />
      </div>
      <div className="keyvoices" ref={keyStatus} data-testid="keyvoices" />
      <h1 className="visually-hidden">AlgoRhythms</h1>
      <p className="title" data-testid="title" title={title}>
        {title}
      </p>
      {children}
    </header>
  );
}

/** The position slider under the score. Silent while dragging; resumes on release. */
export function Scrubber() {
  const input = useRef<HTMLInputElement | null>(null);
  const ref = useCallback((el: HTMLInputElement | null) => {
    input.current = el;
    live.scrub = el;
  }, []);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onInput = (): void => scrubTo(parseFloat(el.value));
    const onChange = (): void => scrubEnd(parseFloat(el.value));
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    return () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onChange);
    };
  }, []);

  return (
    <div className="scrub">
      <input
        ref={ref}
        type="range"
        min={0}
        max={1}
        step={0.01}
        defaultValue={0}
        data-testid="scrubber"
        aria-label="Position in the piece"
      />
    </div>
  );
}
