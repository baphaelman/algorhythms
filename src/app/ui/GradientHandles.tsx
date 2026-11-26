/**
 * The background gradient's handles on the artboard (PLAN.md §15 M14 "Backgrounds"): shown while
 * the poster's background is a gradient and the background is selected (a click on the paper
 * where nothing is; owner, 2026-11-26: only the selection shows handles). Linear:
 * the two ends and a handle per stop between; radial: the centre and the radius. Each drag
 * writes the Colours form (../gradient-handles) and is one undo step. Never exported: they are
 * page elements over the canvas.
 */

import { useEffect, useRef } from 'react';
import { tokensOf } from '../../render/palettes';
import type { ColoursForm } from '../export-colours';
import type { ExportForm } from '../export-options';
import {
  dragGradientHandle,
  gradientHandles,
  type GradientHandle,
  type GradientHandleKind,
} from '../gradient-handles';
import { posterFormGesture } from '../poster-sync';
import { useWorkspace } from '../poster-workspace';
import { appDark, patchLook, useExportUi } from './export-state';

const NAMES: Readonly<Record<GradientHandleKind, string>> = {
  start: 'Gradient start',
  end: 'Gradient end',
  stop: 'Gradient stop',
  centre: 'Gradient centre',
  radius: 'Gradient radius',
};

interface Drag {
  handle: GradientHandle;
  c0: ColoursForm;
  x0: number;
  y0: number;
  last: { x: number; y: number } | null;
  gesture: ReturnType<typeof posterFormGesture> | null;
  raf: number;
}

const tokensFor = (form: ExportForm) =>
  tokensOf(
    (form.look.theme === 'current' ? appDark() : form.look.theme === 'dark') ? 'dark' : 'light',
  );

export function GradientHandles({ form }: { form: ExportForm }) {
  const layout = useWorkspace((s) => s.layout);
  const on = useWorkspace((s) => s.selected?.kind === 'background');
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(
    () => () => {
      const d = drag.current;
      if (d) {
        cancelAnimationFrame(d.raf);
        d.gesture?.end();
      }
    },
    [],
  );
  if (!layout || !on || form.look.transparent) return null;
  const W = layout.width;
  const H = layout.height;
  const t = tokensFor(form);
  const g = gradientHandles(form.look.colours, t, W, H);
  if (!g) return null;

  const board = (e: { clientX: number; clientY: number }) => {
    const b = root.current!.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * W, y: ((e.clientY - b.top) / b.height) * H };
  };
  const apply = (d: Drag) => {
    d.raf = 0;
    if (!d.last) return;
    const x = d.handle.x + d.last.x - d.x0;
    const y = d.handle.y + d.last.y - d.y0;
    const p = dragGradientHandle(d.c0, t, d.handle, x, y, W, H);
    patchLook({ colours: { ...d.c0, ...p } });
  };
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.gesture) {
      apply(d);
      d.gesture.end();
    }
  };

  return (
    <div
      ref={root}
      className="ws-gradient"
      data-testid="gradient-handles"
      data-shape={g.shape}
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {g.line && (
          <line
            x1={g.line.x0}
            y1={g.line.y0}
            x2={g.line.x1}
            y2={g.line.y1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {g.circle && (
          <ellipse
            cx={g.circle.cx}
            cy={g.circle.cy}
            rx={g.circle.r}
            ry={g.circle.r}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {g.handles.map((h) => {
        const id = h.kind === 'stop' ? `stop-${h.stop}` : h.kind;
        return (
          <div
            key={`${h.kind}-${h.stop ?? ''}`}
            className={`ws-ghandle ws-ghandle-${h.kind}`}
            title={NAMES[h.kind]}
            data-testid={`gradient-${id}`}
            data-stop={h.stop}
            style={{ left: `${(h.shown.x / W) * 100}%`, top: `${(h.shown.y / H) * 100}%` }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = board(e);
              drag.current = {
                handle: h,
                c0: useExportUi.getState().form.look.colours,
                x0: p.x,
                y0: p.y,
                last: null,
                gesture: null,
                raf: 0,
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              d.last = board(e);
              d.gesture ??= posterFormGesture('Move gradient');
              if (!d.raf) d.raf = requestAnimationFrame(() => apply(d));
            }}
            onPointerUp={finish}
            onPointerCancel={finish}
          />
        );
      })}
    </div>
  );
}

/** Colours, with a gradient on the poster: how to reach its handles on the artboard. */
export function GradientHandlesHint() {
  return (
    <small className="look-note" data-testid="bg-handles-hint">
      Click the poster’s background to drag the gradient’s handles.
    </small>
  );
}
