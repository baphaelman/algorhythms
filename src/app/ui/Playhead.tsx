import { useEffect, useRef } from 'react';
import { live } from '../dom';
import { onScoreFrame } from '../loop';

/**
 * The editor's one playhead (PLAN.md §10 Drawing rules 5, §11.2): a DOM line over its parent (the
 * `.timeline` box holding the ruler, the score and the lane rows), from top to bottom. It is placed
 * every frame at the score canvas's left edge plus the camera's `xHead`, so it shares the axis with
 * everything in the box. While it is mounted (`live.playhead`), `drawScore` skips its own playhead.
 */
export function Playhead() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    live.playhead = el;
    // The canvas's left edge in the box's padding box; re-measured on resize.
    let left = 0;
    let lastX = NaN;
    const measure = (): void => {
      const c = box.querySelector('canvas');
      if (!c) return;
      left = c.getBoundingClientRect().left - box.getBoundingClientRect().left - box.clientLeft;
      lastX = NaN;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const canvas = box.querySelector('canvas');
    if (canvas) observer.observe(canvas);
    measure();

    const off = onScoreFrame((v) => {
      const show = v.xHead >= -0.5 && v.xHead <= v.width + 0.5;
      if (el.hidden === show) el.hidden = !show;
      const x = left + v.xHead;
      if (show && x !== lastX) {
        lastX = x;
        el.style.transform = `translateX(${x}px)`;
      }
    });
    return () => {
      off();
      observer.disconnect();
      if (live.playhead === el) live.playhead = null;
    };
  }, []);

  return <div ref={ref} className="playhead" data-testid="playhead" aria-hidden="true" hidden />;
}
