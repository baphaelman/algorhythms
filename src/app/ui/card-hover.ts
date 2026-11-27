import { useEffect, useRef } from 'react';
import { soundPreview, stopHoverSound } from '../hover-sound';
import { PREVIEW_DELAY_MS, stopPreview } from '../preview';

/**
 * Hover and keyboard focus on an Add or Next card (PLAN.md §11.3, M13 "Hover to hear"): after
 * `PREVIEW_DELAY_MS` one timer starts the ghost preview (`start`) and, if it started, its sound.
 * Leaving, blurring, clicking or dragging (`cancel`) stops both; the sound fades out over 50 ms.
 */
export function useCardHover(): {
  hover: (start: () => boolean) => void;
  cancel: () => void;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    stopPreview();
    stopHoverSound();
  };
  const hover = (start: () => boolean): void => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (start()) soundPreview();
    }, PREVIEW_DELAY_MS);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return { hover, cancel };
}

/** True when `el` got focus from the keyboard (not a click). */
export function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}
