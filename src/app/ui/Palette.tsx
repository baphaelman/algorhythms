import { useEffect } from 'react';
import type { MomentType } from '../../core/types';
import { playheadEffect, usePaletteEffects, watchPaletteEffects } from '../editor/palette-effects';
import { addAtPlayhead, PALETTE } from '../editor/shortcuts';
import { endPaletteDrag, startPaletteDrag } from '../palette-drop';
import { startPreview, stopPreview } from '../preview';
import { keyboardFocus, useCardHover } from './card-hover';
import './palette.css';

/**
 * The moment palette, "Add" (PLAN.md §11.3, §6.4): one button per row (Chord, Texture, Melody,
 * Level, Sound, Key). A click adds that row's block exactly at the playhead line (revision 7: no
 * grid snap); dragging a button
 * onto the score or the lane adds it at the drop time (../palette-drop.ts).
 *
 * Revision 6: a type that would change nothing at the playhead is greyed out with the reason as
 * its tooltip; its click is disabled but it can still be dragged elsewhere. Hovering (or
 * keyboard-focusing) an enabled one for 250 ms previews it on the score (../preview.ts) and plays
 * it (M13, ../hover-sound.ts); leaving stops both. Each enabled card names its result ("→ Dm7").
 * Dragging one over the score or lane previews it, silently, at the drop time (../palette-drop.ts).
 */
export function Palette() {
  const effects = usePaletteEffects((s) => s.effects);
  const results = usePaletteEffects((s) => s.results);
  const { hover: hoverCard, cancel: cancelHover } = useCardHover();

  useEffect(() => {
    const stop = watchPaletteEffects();
    return () => {
      stop();
      stopPreview();
    };
  }, []);

  const hover = (type: MomentType): void =>
    hoverCard(() => playheadEffect(type).effect && startPreview(type));

  return (
    <div
      className="palette palette-add"
      role="toolbar"
      aria-label="Add moment at playhead"
      data-testid="palette"
    >
      <span className="palette-label" aria-hidden="true" title="Add at the playhead">
        Add <span className="visually-hidden">at playhead</span>
      </span>
      {PALETTE.map((e) => {
        const ef = effects?.[e.type];
        const off = ef ? !ef.effect : false;
        const reason = ef?.reason ? `No effect here: ${ef.reason}` : 'No effect here';
        const result = off ? undefined : results[e.type];
        return (
          <button
            key={e.type}
            type="button"
            data-moment={e.type}
            data-palette-row={e.row}
            data-no-effect={off || undefined}
            data-result={result}
            aria-disabled={off || undefined}
            // The result first, so a label cut off on the card reads whole here.
            title={
              off
                ? `${e.name}: ${reason} (drag to another time)`
                : `${result ? `${result}. ` : ''}${e.key ? `${e.hint} (${e.key})` : e.hint}`
            }
            aria-keyshortcuts={e.key}
            draggable
            onDragStart={(ev) => {
              cancelHover();
              startPaletteDrag(ev.nativeEvent, e.type);
            }}
            onPointerEnter={(ev) => {
              // Mouse only: a finger's tap adds (§11.3b, nothing depends on hover).
              if (!off && ev.pointerType === 'mouse') hover(e.type);
            }}
            onDragEnd={endPaletteDrag}
            onPointerLeave={cancelHover}
            onFocus={(ev) => {
              if (!off && keyboardFocus(ev.currentTarget)) hover(e.type);
            }}
            onBlur={cancelHover}
            onClick={() => {
              cancelHover();
              if (playheadEffect(e.type).effect) addAtPlayhead(e.type);
            }}
          >
            <span className="card-text">
              <span className="card-name">
                <span className="palette-icon" aria-hidden="true">
                  {e.icon}
                </span>
                {e.name}
              </span>
              {result && <span className="card-result">{result}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
