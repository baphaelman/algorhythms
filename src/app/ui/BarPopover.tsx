import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * A view-bar button that opens a small panel above it (build-log "Compact view bar"). Escape
 * (focus returns to the button) or a press outside closes it. The panel stays in the DOM while
 * closed (`hidden`), so `aria-controls` always resolves.
 */
export function BarPopover(props: {
  /** The button's visible text. */
  label: ReactNode;
  /** The button's accessible name when `label` is not enough (e.g. "?"). */
  ariaLabel?: string;
  title: string;
  /** The panel's accessible name. */
  panelLabel: string;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Capture phase, before the document-level editor keys; preventDefault marks the Escape used.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div className={`vb-pop ${props.className ?? ''}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="vb-pop-button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={props.ariaLabel}
        title={props.title}
        data-testid={props.testId}
        onClick={() => setOpen(!open)}
      >
        {props.label}
      </button>
      <div
        className="vb-pop-panel"
        id={panelId}
        role="group"
        aria-label={props.panelLabel}
        data-testid={`${props.testId}-panel`}
        hidden={!open}
      >
        {props.children}
      </div>
    </div>
  );
}
