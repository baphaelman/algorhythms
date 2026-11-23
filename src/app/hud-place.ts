/**
 * Placing HUD readouts in the Export dialog's preview (PLAN.md §12 "Exports you can shape"):
 * layout edits from what the preview drew (`HudPlacement`, layout px). The first edit fixes
 * every readout where the frame shows it, so moving or removing one leaves the others in place.
 */

import type { HudBox, HudPlacement } from '../render/hud';
import {
  HUD_BOX_H,
  HUD_MIN_W,
  freeSpot,
  posOfBox,
  snapBox,
  type HudGuides,
  type HudLayout,
} from '../render/hud-layout';
import type { HudItem } from '../render/types';

/** Arrow-key steps, as a fraction of the frame: plain and with Shift. */
export const NUDGE = 0.005;
export const NUDGE_BIG = 0.05;

/** `layout` with every drawn readout's position filled in from where the frame shows it. */
export function fixLayout(layout: HudLayout, placement: HudPlacement): HudLayout {
  const out: HudLayout = { ...layout };
  for (const b of placement.boxes) out[b.item] ??= posOfBox(b.x, b.y, b.w, b.h, placement);
  return out;
}

const boxOf = (placement: HudPlacement, item: HudItem): HudBox | undefined =>
  placement.boxes.find((b) => b.item === item);

/**
 * Where a readout dragged to top-left (x, y) lands: snapped to the margins, centre lines and the
 * other readouts' edges within `tol` px, unless `free` (Alt); clamped inside the frame.
 */
export function dragTarget(
  placement: HudPlacement,
  item: HudItem,
  x: number,
  y: number,
  tol: number,
  free: boolean,
): { x: number; y: number; guides: HudGuides } {
  const b = boxOf(placement, item);
  const w = b?.w ?? HUD_MIN_W;
  const h = b?.h ?? HUD_BOX_H;
  const others = placement.boxes.filter((o) => o.item !== item);
  if (free) {
    const r = snapBox({ x, y, w, h }, placement, placement.margin, [], -1);
    return { x: r.x, y: r.y, guides: {} };
  }
  return snapBox({ x, y, w, h }, placement, placement.margin, others, tol);
}

/** The layout with `item`'s box at top-left (x, y) (others fixed where they are). */
export function moveReadout(
  layout: HudLayout,
  placement: HudPlacement,
  item: HudItem,
  x: number,
  y: number,
): HudLayout {
  const b = boxOf(placement, item);
  if (!b) return layout;
  return { ...fixLayout(layout, placement), [item]: posOfBox(x, y, b.w, b.h, placement) };
}

/** The layout with `item` moved by (dx, dy) fractions of the frame. */
export function nudgeReadout(
  layout: HudLayout,
  placement: HudPlacement,
  item: HudItem,
  dx: number,
  dy: number,
): HudLayout {
  const b = boxOf(placement, item);
  if (!b) return layout;
  return moveReadout(
    layout,
    placement,
    item,
    b.x + dx * placement.width,
    b.y + dy * placement.height,
  );
}

/** The layout once `item` is taken off the frame (the others fixed where they are). */
export function removeReadout(
  layout: HudLayout,
  placement: HudPlacement | null,
  item: HudItem,
): HudLayout {
  const out = placement ? fixLayout(layout, placement) : { ...layout };
  delete out[item];
  return out;
}

/**
 * The layout once `item` (about `w` px wide) is added back: at a free spot when readouts have
 * been placed and it has no position; an untouched layout ({}) stays as it is (the item takes
 * its default slot).
 */
export function addReadout(
  layout: HudLayout,
  placement: HudPlacement | null,
  item: HudItem,
  w: number,
): HudLayout {
  // Placed already (by the other format: video and poster share the layout): it stays there.
  if (!placement || Object.keys(layout).length === 0 || layout[item]) return layout;
  const others = placement.boxes.filter((b) => b.item !== item);
  const pos = freeSpot(Math.max(HUD_MIN_W, w), HUD_BOX_H, placement, placement.margin, others);
  return { ...fixLayout(layout, { ...placement, boxes: others }), [item]: pos };
}

/** A readout's width before it is drawn, from a sample of its text (layout px). */
export function sampleWidth(item: HudItem, sample: string): number {
  const em = item === 'chord' || item === 'title';
  return sample.length * (em ? 7.3 : 6.4);
}
