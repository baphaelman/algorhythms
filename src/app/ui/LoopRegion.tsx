import { useEffect, useRef } from 'react';
import { onScoreFrame } from '../loop';
import { loopDraft, loopRegion } from '../store';

/**
 * The loop region's shading (PLAN.md §11.3 revision 6): one box over its parent (the `.timeline`
 * holding the ruler, score and rows), placed every frame on the score's axis like `Playhead.tsx`.
 * Shows the region being dragged on the ruler, else the stored one; dimmed while looping is off.
 */
export function LoopRegion() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    let left = 0;
    let last = '';
    const measure = (): void => {
      const c = box.querySelector('canvas');
      if (!c) return;
      left = c.getBoundingClientRect().left - box.getBoundingClientRect().left - box.clientLeft;
      last = '';
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const canvas = box.querySelector('canvas');
    if (canvas) observer.observe(canvas);
    measure();

    const off = onScoreFrame((v) => {
      const draft = loopDraft.span;
      const r = draft ? { ...draft, on: true } : loopRegion();
      let key = '';
      let x0 = 0;
      let x1 = 0;
      if (r) {
        x0 = Math.max(0, (r.start - v.start) * v.pps);
        x1 = Math.min(v.width, (r.end - v.start) * v.pps);
        if (x1 > x0) key = `${x0}|${x1}|${r.on}|${draft ? 1 : 0}|${r.start}|${r.end}`;
      }
      if (key === last) return;
      last = key;
      el.hidden = key === '';
      if (!r || key === '') return;
      el.style.transform = `translateX(${left + x0}px)`;
      el.style.width = `${x1 - x0}px`;
      el.dataset.on = String(r.on);
      el.dataset.start = r.start.toFixed(3);
      el.dataset.end = r.end.toFixed(3);
      el.classList.toggle('draft', draft !== null);
    });
    return () => {
      off();
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="loop-region" data-testid="loop-region" aria-hidden="true" hidden />
  );
}
