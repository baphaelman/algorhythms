import { useEffect, useRef } from 'react';
import type { MomentType } from '../../core/types';
import { playheadEffect, usePaletteEffects, watchPaletteEffects } from '../editor/palette-effects';
import { addAtPlayhead, PALETTE } from '../editor/shortcuts';
import { startPaletteDrag } from '../palette-drop';
import { PREVIEW_DELAY_MS, startPreview, stopPreview } from '../preview';
import './palette.css';

/**
 * The moment palette (PLAN.md §11.3): a click adds that moment at the playhead; dragging a button
 * onto the score or the lane adds it at the drop time (../palette-drop.ts).
 *
 * Revision 6: a type that would change nothing at the playhead is greyed out with the reason as
 * its tooltip; its click is disabled but it can still be dragged elsewhere. Hovering an enabled
 * one for 300 ms previews it (../preview.ts); leaving stops the preview.
 */
export function Palette() {
  const effects = usePaletteEffects((s) => s.effects);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stop = watchPaletteEffects();
    return () => {
      stop();
      stopPreview();
    };
  }, []);

  const cancelHover = (): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    stopPreview();
  };
  const hover = (type: MomentType): void => {
    cancelHover();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      if (playheadEffect(type).effect) startPreview(type);
    }, PREVIEW_DELAY_MS);
  };

  return (
    <div className="palette" role="toolbar" aria-label="Add moment" data-testid="palette">
      <span className="palette-label">Add</span>
      {PALETTE.map((e) => {
        const ef = effects?.[e.type];
        const off = ef ? !ef.effect : false;
        const reason = ef?.reason ? `No effect here: ${ef.reason}` : 'No effect here';
        return (
          <button
            key={e.type}
            type="button"
            data-moment={e.type}
            data-no-effect={off || undefined}
            aria-disabled={off || undefined}
            title={
              off
                ? `${e.name}: ${reason} (drag to another time)`
                : e.key
                  ? `${e.hint} (${e.key})`
                  : e.hint
            }
            aria-keyshortcuts={e.key}
            draggable
            onDragStart={(ev) => {
              cancelHover();
              startPaletteDrag(ev.nativeEvent, e.type);
            }}
            onPointerEnter={() => {
              if (!off) hover(e.type);
            }}
            onPointerLeave={cancelHover}
            onClick={() => {
              cancelHover();
              if (playheadEffect(e.type).effect) addAtPlayhead(e.type);
            }}
          >
            <span className="palette-icon" aria-hidden="true">
              {e.icon}
            </span>
            {e.name}
          </button>
        );
      })}
    </div>
  );
}
