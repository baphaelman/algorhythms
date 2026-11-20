import { useEffect, useId, useRef, useState } from 'react';
import { EXAMPLES } from '../examples';
import { openExample, openFile, usePlayer } from '../store';

/** The ⋯ menu: examples, open a file, placeholders for Generate and Export, and help. */
export function Menu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const title = usePlayer((s) => s.piece.meta.title);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="menu" ref={root}>
      <input
        ref={fileInput}
        type="file"
        className="visually-hidden"
        accept=".json,.algorhythms.json,application/json"
        aria-label="Open a piece from a file"
        data-testid="file-input"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void openFile(file);
        }}
      />
      <button
        ref={trigger}
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="menu-button"
        onClick={() => setOpen(!open)}
      >
        Menu
      </button>
      {open && (
        <div
          className="menu-panel"
          id={panelId}
          role="group"
          aria-label="Menu"
          data-testid="menu-panel"
        >
          <p className="brand">
            <strong>AlgoRhythms</strong> <small>pitch-line music</small>
          </p>
          <h2>Examples</h2>
          <ul className="examples" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <li key={ex.id}>
                <button
                  type="button"
                  data-testid={`example-${ex.id}`}
                  aria-current={ex.title === title ? 'true' : undefined}
                  onClick={() => {
                    openExample(ex.json);
                    close();
                  }}
                >
                  <span>{ex.title}</span>
                  <small>{ex.voices} voices</small>
                </button>
              </li>
            ))}
          </ul>
          <h2>Pieces</h2>
          <ul>
            <li>
              <button
                type="button"
                data-testid="open-file"
                onClick={() => {
                  setOpen(false);
                  fileInput.current?.click();
                }}
              >
                Open file…
              </button>
            </li>
            <li>
              <button type="button" disabled aria-disabled="true">
                Generate <small>coming soon</small>
              </button>
            </li>
            <li>
              <button type="button" disabled aria-disabled="true">
                Export <small>coming soon</small>
              </button>
            </li>
          </ul>
          <h2>Help</h2>
          <dl className="shortcuts">
            <dt>
              <kbd>Space</kbd>
            </dt>
            <dd>Play or pause</dd>
            <dt>
              <kbd>←</kbd> <kbd>→</kbd>
            </dt>
            <dd>Move 5 s (Shift: 15 s)</dd>
            <dt>
              <kbd>−</kbd> <kbd>=</kbd>
            </dt>
            <dd>Widen or narrow the window</dd>
            <dt>Drag</dt>
            <dd>Pan while paused</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
