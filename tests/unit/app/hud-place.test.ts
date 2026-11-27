/** Placing HUD readouts in the Export dialog (PLAN.md §12 "Exports you can shape"). */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  EXPORT_PREFS_KEY,
  EXPORT_PREFS_VERSION,
  loadExportPrefs,
  parsePrefs,
  resetLook,
  saveExportPrefs,
} from '../../../src/app/export-options';
import {
  NUDGE,
  addReadout,
  dragTarget,
  fixLayout,
  moveReadout,
  nudgeReadout,
  removeReadout,
} from '../../../src/app/hud-place';
import { placeBox, type HudPlacement } from '../../../src/render';

/** Today's default HUD at 16:9 as the preview reports it (two columns, bottom band). */
const PLACE: HudPlacement = {
  width: 853,
  height: 480,
  margin: 21.3,
  boxes: [
    { item: 'formula', text: 'f', anchor: 'bl', x: 21.3, y: 419.5, w: 160, h: 14 },
    { item: 'notes', text: 'n', anchor: 'bl', x: 21.3, y: 433.5, w: 70, h: 14 },
    { item: 'time', text: 't', anchor: 'bl', x: 21.3, y: 447.5, w: 120, h: 14 },
    { item: 'chord', text: 'C', anchor: 'br', x: 791.7, y: 419.5, w: 40, h: 14 },
    { item: 'key', text: 'k', anchor: 'br', x: 711.7, y: 433.5, w: 120, h: 14 },
    { item: 'hz', text: 'h', anchor: 'br', x: 731.7, y: 447.5, w: 100, h: 14 },
  ],
};

const at = (layout: ReturnType<typeof fixLayout>, item: keyof typeof layout, w: number) =>
  placeBox(layout[item]!, w, 14, PLACE);

describe('layout edits', () => {
  it('fixLayout keeps every readout where the frame shows it', () => {
    const l = fixLayout({}, PLACE);
    for (const b of PLACE.boxes) {
      const p = at(l, b.item, b.w);
      // Positions are canonical (4 significant digits): within 0.05 px.
      expect(p.x).toBeCloseTo(b.x, 1);
      expect(p.y).toBeCloseTo(b.y, 1);
    }
    expect(l.formula!.anchor).toBe('bl');
    expect(l.chord!.anchor).toBe('br');
  });

  it('moving one readout leaves the others in place', () => {
    const l = moveReadout({}, PLACE, 'chord', 400, 30);
    expect(l.chord!.anchor).toBe('t');
    expect(at(l, 'chord', 40).x).toBeCloseTo(400, 1);
    expect(at(l, 'chord', 40).y).toBeCloseTo(30, 1);
    expect(at(l, 'time', 120).y).toBeCloseTo(447.5, 1);
  });

  it('dragging snaps (margin, other edges) unless free; never leaves the frame', () => {
    const t = dragTarget(PLACE, 'chord', 24, 100, 6, false);
    expect(t).toMatchObject({ x: 21.3, y: 100, guides: { x: 21.3 } });
    const free = dragTarget(PLACE, 'chord', 24, 100, 6, true);
    expect(free).toEqual({ x: 24, y: 100, guides: {} });
    // Below the left column's last row: top snaps to its bottom.
    expect(dragTarget(PLACE, 'chord', 300, 463, 6, false).y).toBeCloseTo(461.5, 9);
    expect(dragTarget(PLACE, 'chord', 2000, 2000, 6, true)).toMatchObject({ x: 813, y: 466 });
  });

  it('nudges by a fraction of the frame', () => {
    const l = nudgeReadout({}, PLACE, 'notes', NUDGE, -NUDGE);
    const p = at(l, 'notes', 70);
    expect(p.x).toBeCloseTo(21.3 + 853 * NUDGE, 1);
    expect(p.y).toBeCloseTo(433.5 - 480 * NUDGE, 1);
  });

  it('remove fixes the others; add back finds a free spot once placed', () => {
    const removed = removeReadout({}, PLACE, 'chord');
    expect(removed.chord).toBeUndefined();
    expect(Object.keys(removed).sort()).toEqual(['formula', 'hz', 'key', 'notes', 'time']);
    const others = { ...PLACE, boxes: PLACE.boxes.filter((b) => b.item !== 'chord') };
    const added = addReadout(removed, others, 'chord', 40);
    const p = at(added, 'chord', 40);
    for (const b of others.boxes) {
      const apart = p.x >= b.x + b.w || b.x >= p.x + 40 || p.y >= b.y + b.h || b.y >= p.y + 14;
      expect(apart).toBe(true);
    }
    // Untouched layout: the readout takes its default slot.
    expect(addReadout({}, others, 'chord', 40)).toEqual({});
    expect(removeReadout({ chord: { anchor: 'tl', x: 0, y: 0 } }, null, 'chord')).toEqual({});
    // Already placed (the other format shares the layout): stays where it is.
    const kept = { ...removed, chord: { anchor: 'tl' as const, x: 0.3, y: 0.3 } };
    expect(addReadout(kept, others, 'chord', 40)).toBe(kept);
  });
});

describe('remembered layout', () => {
  class Mem {
    m = new Map<string, string>();
    getItem(k: string) {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      this.m.set(k, v);
    }
  }

  it('round-trips (version 3 and later), dropping bad positions', () => {
    expect(EXPORT_PREFS_VERSION).toBeGreaterThanOrEqual(3);
    const st = new Mem();
    const hudLayout = { chord: { anchor: 'tr' as const, x: -0.1, y: 0.05 } };
    saveExportPrefs({ ...DEFAULT_EXPORT_FORM, hudLayout }, st);
    expect(JSON.parse(st.getItem(EXPORT_PREFS_KEY)!).v).toBe(EXPORT_PREFS_VERSION);
    expect(loadExportPrefs(st).hudLayout).toEqual(hudLayout);
    expect(
      parsePrefs({
        v: 3,
        hudLayout: {
          chord: { anchor: 'x', x: 0, y: 0 },
          nope: { anchor: 'tl', x: 0, y: 0 },
          hz: hudLayout.chord,
        },
      }).hudLayout,
    ).toEqual({ hz: hudLayout.chord });
  });

  it('migrates an old ordered list: the list kept, every readout in its default slot', () => {
    const p = parsePrefs({ v: 2, videoHud: ['hz', 'chord', 'formula'], posterHud: ['title'] });
    expect(p.videoHud).toEqual(['formula', 'chord', 'hz']);
    expect(p.posterHud).toEqual(['title']);
    expect(p.hudLayout).toEqual({});
    // An old record's stray layout is not trusted.
    expect(
      parsePrefs({ videoHud: [], hudLayout: { chord: { anchor: 'tl', x: 0, y: 0 } } }).hudLayout,
    ).toEqual({});
  });

  it('Reset to defaults clears the layout', () => {
    const f = {
      ...DEFAULT_EXPORT_FORM,
      hudLayout: { chord: { anchor: 'tl' as const, x: 0, y: 0 } },
    };
    expect(resetLook(f).hudLayout).toEqual({});
  });
});
