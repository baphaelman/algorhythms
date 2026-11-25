/**
 * The export surfaces' shared fields (PLAN.md §12 "Export look", "Exports you can shape",
 * "Poster export"): the Look panel and HUD list, the HUD boxes over a preview, the poster's
 * size and rows, the Section, the Poster | Video switch and the status line. Used by the poster
 * workspace and the video and audio dialogs; every change goes through `patch`.
 */

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { evalSegment } from '../../core/segment';
import { hudPosText, posOfBox } from '../../render/hud-layout';
import { sectionText, type TimeSpan } from '../../render/section';
import { tokensOf } from '../../render/palettes';
import type { HudItem } from '../../render/types';
import { NUDGE, NUDGE_BIG, dragTarget, moveReadout, nudgeReadout } from '../hud-place';
import {
  HUD_CHOICES,
  POSTER_MAX_AREA,
  POSTER_MAX_ROWS,
  POSTER_MAX_SIDE,
  POSTER_MIN_SIDE,
  POSTER_SIZES,
  SECTION_KINDS,
  clampPosterDims,
  defaultCustomSpan,
  gridOf,
  moveHandle,
  parseClock,
  posterCapped,
  posterPixels,
  posterPreset,
  resetLook,
  saveExportPrefs,
  sectionClock,
  stepHandle,
  typeHandle,
  type ExportForm,
  type SectionHandle,
} from '../export-options';
import {
  defaultHud,
  followAtHint,
  hudSummary,
  lookControls,
  posterAheadControl,
  type LookControl,
  type LookFlags,
  type LookKind,
  type LookSegments,
  type LookSlider,
} from '../look-controls';
import { EXPORT_MODES, type ExportMode } from '../export-surface';
import { cameraOf, loopRegion, usePlayer } from '../store';
import { ColoursGroup } from './ColoursGroup';
import { Radios, Switch } from './export-controls';
import { PitchGuidesRow } from './ExportYoutube';
import {
  IDLE,
  appDark,
  hudList,
  hudListPatch,
  patch,
  patchLook,
  sectionNow,
  setReadout,
  useExportUi,
  type RunState,
} from './export-state';

/** Segmented buttons in the Look grid: a label, then a radio group drawn as one bar. */
function LookSegmentsRow({
  control,
  form,
  disabled,
  aside,
}: {
  control: LookSegments;
  form: ExportForm;
  disabled?: boolean;
  aside?: ReactNode;
}) {
  const id = useId();
  const value = control.value(form);
  const label = (
    <span className="look-label" id={`${id}-label`}>
      {control.label}
    </span>
  );
  return (
    <>
      {aside ? (
        <div className="look-label-row">
          {label}
          {aside}
        </div>
      ) : (
        label
      )}
      <div
        className="seg radios look-seg"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        data-testid={`look-${control.id}`}
        data-value={value}
      >
        {control.choices.map((c) => (
          <label key={c.value} className={value === c.value ? 'on' : undefined}>
            <input
              type="radio"
              name={`${id}-r`}
              value={c.value}
              checked={value === c.value}
              disabled={disabled}
              onChange={() => patch(control.apply(useExportUi.getState().form, c.value))}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

/** Independent flags drawn as segments, each lit when on (checkboxes, so Space toggles). */
function LookFlagsRow({
  control,
  form,
  disabled,
}: {
  control: LookFlags;
  form: ExportForm;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <>
      <span className="look-label" id={`${id}-label`}>
        {control.label}
      </span>
      <div
        className="seg radios look-seg"
        role="group"
        aria-labelledby={`${id}-label`}
        data-testid={`look-${control.id}`}
      >
        {control.flags.map((f) => {
          const on = form.look[f.key];
          return (
            <label key={f.id} className={on ? 'on' : undefined}>
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                data-testid={`look-${control.id}-${f.id}`}
                onChange={(e) => patchLook({ [f.key]: e.target.checked })}
              />
              <span>{f.label}</span>
            </label>
          );
        })}
      </div>
    </>
  );
}

/** A slider in the Look grid, its value shown beside it. */
function LookSliderRow({
  control,
  form,
  disabled,
}: {
  control: LookSlider;
  form: ExportForm;
  disabled?: boolean;
}) {
  const id = useId();
  const value = control.value(form);
  const text = control.text(value);
  return (
    <>
      <label htmlFor={id} title={control.hint}>
        {control.label}
      </label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={value}
          disabled={disabled}
          aria-valuetext={text}
          data-testid={`look-${control.id}`}
          onChange={(e) =>
            patch(control.apply(useExportUi.getState().form, Number(e.target.value)))
          }
        />
        <output htmlFor={id} data-testid={`look-${control.id}-value`}>
          {text}
        </output>
      </div>
    </>
  );
}

/** One Look control: a switch row, segments or a slider. */
function LookRow({
  control,
  form,
  disabled,
  aside,
}: {
  control: LookControl;
  form: ExportForm;
  disabled?: boolean;
  /** Beside the control: a switch's details disclosure (poster workspace). */
  aside?: ReactNode;
}) {
  switch (control.type) {
    case 'toggle': {
      const sw = (
        <Switch
          label={control.label}
          checked={control.value(form)}
          disabled={disabled}
          testId={`look-${control.id}`}
          onChange={(on) => patch(control.apply(useExportUi.getState().form, on))}
        />
      );
      return aside ? (
        <div className="look-switch-row">
          {sw}
          {aside}
        </div>
      ) : (
        sw
      );
    }
    case 'segments':
      return <LookSegmentsRow control={control} form={form} disabled={disabled} aside={aside} />;
    case 'flags':
      return <LookFlagsRow control={control} form={form} disabled={disabled} />;
    case 'slider':
      return <LookSliderRow control={control} form={form} disabled={disabled} />;
  }
}

/**
 * The HUD: a disclosure row ("HUD · 6 readouts") that expands in place with a height animation
 * (none under prefers-reduced-motion), one switch per readout with its sample, and None /
 * Default. No popup and no document listeners: it stays open until its row is pressed again.
 * Collapsed, the list stays in the DOM (so it can animate) but is inert and hidden.
 */
function HudSection({
  form,
  kind,
  aside,
}: {
  form: ExportForm;
  kind: LookKind;
  aside?: ReactNode;
}) {
  const open = useExportUi((s) => s.hudOpen);
  const pieceName = usePlayer((s) => s.piece.meta.title);
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const hud = hudList(form, kind);
  const setHud = (items: readonly HudItem[]) => patch(hudListPatch(kind, items));
  const placed = Object.keys(form.hudLayout).length > 0;

  useLayoutEffect(() => {
    if (panel.current) panel.current.inert = !open;
  }, [open]);

  return (
    <div className="hud-section">
      {aside ? (
        <div className="look-switch-row">
          <button
            type="button"
            className="hud-row"
            id={`${id}-button`}
            aria-expanded={open}
            aria-controls={`${id}-list`}
            data-testid="look-hud-button"
            onClick={() => useExportUi.setState({ hudOpen: !open })}
          >
            <span>HUD · {hudSummary(hud)}</span>
            <span className="hud-chevron" aria-hidden="true" />
          </button>
          {aside}
        </div>
      ) : (
        <button
          type="button"
          className="hud-row"
          id={`${id}-button`}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          data-testid="look-hud-button"
          onClick={() => useExportUi.setState({ hudOpen: !open })}
        >
          <span>HUD · {hudSummary(hud)}</span>
          <span className="hud-chevron" aria-hidden="true" />
        </button>
      )}
      <div
        ref={panel}
        className={open ? 'hud-panel open' : 'hud-panel'}
        id={`${id}-list`}
        role="group"
        aria-label="HUD readouts"
        data-testid="look-hud"
      >
        <div className="hud-inner">
          <div className="hud-quick">
            <button type="button" data-testid="hud-none" onClick={() => setHud([])}>
              None
            </button>
            <button
              type="button"
              data-testid="hud-default"
              onClick={() => setHud(defaultHud(kind))}
            >
              Default
            </button>
            <button
              type="button"
              data-testid="hud-reset-layout"
              disabled={!placed}
              onClick={() => patch({ hudLayout: {} })}
            >
              Reset layout
            </button>
          </div>
          <small className="hud-hint">Drag readouts in the preview to place them.</small>
          {HUD_CHOICES.map((c) => (
            <Switch
              key={c.id}
              className="hud-item"
              label={c.label}
              checked={hud.includes(c.id)}
              testId={`hud-${c.id}`}
              onChange={(on) => setReadout(kind, c.id, on)}
            >
              <small className="hud-sample">
                {c.id === 'title' ? pieceName || 'Untitled' : c.sample}
              </small>
            </Switch>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Some of the video's own Look controls (M15: the look lives in Poster; the video panel holds
 * only what moves), by id, in the Look's order; `hud` adds the video's readouts.
 */
export function VideoLookRows({
  form,
  ids,
  hud = false,
  poster = false,
  disabled,
}: {
  form: ExportForm;
  ids: readonly string[];
  hud?: boolean;
  /** Over the poster: Ahead of the playhead is its own (`videoAheadPoster`). */
  poster?: boolean;
  disabled: boolean;
}) {
  const follow = form.videoCamera === 'follow';
  return (
    <div className="look-grid">
      {lookControls('video')
        .filter((c) => ids.includes(c.id))
        .map((c) => (poster && c.id === 'future' ? posterAheadControl : c))
        .map((c) => (
          <Fragment key={c.id}>
            <LookRow
              control={c}
              form={form}
              disabled={disabled || (c.id === 'follow-at' && !follow)}
            />
            {c.id === 'follow-at' && (
              <small className="look-note" data-testid="look-follow-at-hint">
                {followAtHint(form)}
              </small>
            )}
          </Fragment>
        ))}
      {hud && <HudSection form={form} kind="video" />}
    </div>
  );
}

/**
 * The Look section (PLAN.md §12 "Export look"), shared by video and poster: sliders, switches
 * and segments in a label / control grid, the HUD and Reset.
 */
export function LookPanel({
  form,
  kind,
  disabled,
  details,
}: {
  form: ExportForm;
  kind: LookKind;
  disabled: boolean;
  /**
   * A control's details (the poster workspace): a disclosure beside it and its panel below, by
   * control id (`pitch-guides` and `hud` for those rows).
   */
  details?: (id: string) => { button: ReactNode; panel: ReactNode } | null;
}) {
  const look = form.look;
  const follow = form.videoCamera === 'follow';
  const dark = look.theme === 'current' ? appDark() : look.theme === 'dark';
  const pitch = details?.('pitch-guides');
  const hud = details?.('hud');

  return (
    <fieldset className="look" disabled={disabled} data-testid="look">
      <legend>Look</legend>
      <div className="look-grid">
        {lookControls(kind).map((c) => {
          const d = details?.(c.id);
          return (
            <Fragment key={c.id}>
              <LookRow
                control={c}
                form={form}
                disabled={c.id === 'follow-at' && !follow}
                aside={d?.button}
              />
              {c.id === 'follow-at' && (
                <small className="look-note" data-testid="look-follow-at-hint">
                  {followAtHint(form)}
                </small>
              )}
              {d?.panel}
            </Fragment>
          );
        })}
        <PitchGuidesRow form={form} disabled={disabled} onLook={patchLook} aside={pitch?.button} />
        {pitch?.panel}
        <HudSection form={form} kind={kind} aside={hud?.button} />
        {hud?.panel}
      </div>
      <ColoursGroup
        look={look}
        kind={kind}
        dark={dark}
        saved={form.colourSchemes}
        onLook={patchLook}
        onSaved={(colourSchemes) => patch({ colourSchemes })}
      />
      <button
        type="button"
        className="look-reset"
        data-testid="look-reset"
        onClick={() => {
          useExportUi.setState((s) => ({ form: resetLook(s.form), run: IDLE }));
          saveExportPrefs(useExportUi.getState().form);
        }}
      >
        Reset to defaults
      </button>
    </fieldset>
  );
}

/** Snap distance while dragging a readout, CSS px. */
const SNAP_CSS = 6;

const readoutLabel = (item: HudItem): string =>
  HUD_CHOICES.find((c) => c.id === item)?.label ?? item;

/**
 * The HUD readouts over the preview (PLAN.md §12 "Exports you can shape"): a box per readout
 * where the preview drew it. Drag places it (snapping to the margins, centre lines and other
 * readouts' edges, guides shown; Alt free); focused, the arrow keys move it (Shift: larger
 * steps) and Delete removes it, as its × does. Positions are in % of the frame, so the boxes
 * follow the canvas at any size.
 */
export function HudOverlay({
  form,
  kind,
  disabled,
}: {
  form: ExportForm;
  kind: LookKind;
  disabled: boolean;
}) {
  const place = useExportUi((s) => s.hudPlace);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ item: HudItem; px: number; py: number; bx: number; by: number } | null>(
    null,
  );
  const [guides, setGuides] = useState<{ x?: number; y?: number } | null>(null);
  const [said, setSaid] = useState('');
  const [dragging, setDragging] = useState<HudItem | null>(null);
  if (!place || place.boxes.length === 0) return null;
  const W = place.width;
  const H = place.height;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const posText = (item: HudItem): string => {
    const b = place.boxes.find((x) => x.item === item);
    const pos = form.hudLayout[item] ?? (b ? posOfBox(b.x, b.y, b.w, b.h, place) : undefined);
    return pos ? hudPosText(pos) : '';
  };
  /** Sets the layout; saved to the prefs unless mid-drag (saved on release). */
  const setLayout = (layout: ExportForm['hudLayout'], save = true) => {
    if (save) patch({ hudLayout: layout });
    else useExportUi.setState((s) => ({ form: { ...s.form, hudLayout: layout }, run: IDLE }));
  };
  const remove = (item: HudItem, refocus: boolean) => {
    const order = place.boxes.map((b) => b.item);
    const next = order[order.indexOf(item) + 1] ?? order[order.indexOf(item) - 1];
    setReadout(kind, item, false);
    setSaid(`${readoutLabel(item)} removed`);
    if (refocus) {
      requestAnimationFrame(() => {
        const el = next && layer.current?.querySelector<HTMLElement>(`[data-item="${next}"]`);
        el?.focus();
      });
    }
  };

  return (
    <div
      className={disabled ? 'hud-overlay disabled' : 'hud-overlay'}
      ref={layer}
      data-testid="hud-overlay"
      data-width={W}
      data-height={H}
    >
      {place.boxes.map((b) => {
        const label = readoutLabel(b.item);
        return (
          <div
            key={b.item}
            className={dragging === b.item ? 'hud-box dragging' : 'hud-box'}
            data-item={b.item}
            data-testid={`hud-box-${b.item}`}
            data-anchor={b.anchor}
            tabIndex={disabled ? -1 : 0}
            role="group"
            aria-roledescription="HUD readout"
            aria-label={`${label}: ${posText(b.item)}. Arrow keys move it, Shift for larger steps, Delete removes it.`}
            style={{
              left: pct(b.x, W),
              top: pct(b.y, H),
              width: pct(b.w, W),
              height: pct(b.h, H),
            }}
            onPointerDown={(e) => {
              if (disabled || e.button !== 0) return;
              if ((e.target as HTMLElement).closest('button')) return;
              e.preventDefault();
              e.currentTarget.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { item: b.item, px: e.clientX, py: e.clientY, bx: b.x, by: b.y };
              setDragging(b.item);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              const el = layer.current;
              if (!d || d.item !== b.item || !el) return;
              const cur = useExportUi.getState().hudPlace;
              if (!cur) return;
              const k = el.getBoundingClientRect().width / cur.width || 1;
              const x = d.bx + (e.clientX - d.px) / k;
              const y = d.by + (e.clientY - d.py) / k;
              const t = dragTarget(cur, b.item, x, y, SNAP_CSS / k, e.altKey);
              setGuides(t.guides);
              const form = useExportUi.getState().form;
              setLayout(moveReadout(form.hudLayout, cur, b.item, t.x, t.y), false);
            }}
            onPointerUp={(e) => {
              if (!drag.current) return;
              drag.current = null;
              setDragging(null);
              e.currentTarget.releasePointerCapture?.(e.pointerId);
              setGuides(null);
              saveExportPrefs(useExportUi.getState().form);
              setSaid(`${label}: ${posText(b.item)}`);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(null);
              setGuides(null);
              saveExportPrefs(useExportUi.getState().form);
            }}
            onKeyDown={(e) => {
              if (disabled) return;
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                remove(b.item, true);
                return;
              }
              const step = e.shiftKey ? NUDGE_BIG : NUDGE;
              const dir: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              };
              const v = dir[e.key];
              if (!v) return;
              e.preventDefault();
              const cur = useExportUi.getState().hudPlace;
              if (!cur) return;
              const form = useExportUi.getState().form;
              const layout = nudgeReadout(form.hudLayout, cur, b.item, v[0], v[1]);
              setLayout(layout);
              const pos = layout[b.item];
              if (pos) setSaid(`${label}: ${hudPosText(pos)}`);
            }}
          >
            <button
              type="button"
              className="hud-x"
              tabIndex={-1}
              aria-label={`Remove ${label}`}
              title={`Remove ${label}`}
              data-testid={`hud-x-${b.item}`}
              disabled={disabled}
              onClick={() => remove(b.item, false)}
            >
              ×
            </button>
          </div>
        );
      })}
      {guides?.x !== undefined && (
        <div className="hud-guide v" style={{ left: pct(guides.x, W) }} data-testid="hud-guide-x" />
      )}
      {guides?.y !== undefined && (
        <div className="hud-guide h" style={{ top: pct(guides.y, H) }} data-testid="hud-guide-y" />
      )}
      <div className="visually-hidden" aria-live="polite" data-testid="hud-live">
        {said}
      </div>
    </div>
  );
}

/** A slider field with its value shown beside it (Rows, Width, Height). */
export function RangeField({
  label,
  min,
  max,
  value,
  text,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  text: string;
  disabled: boolean;
  testId: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          aria-valuetext={text}
          data-testid={testId}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id} data-testid={`${testId}-value`}>
          {text}
        </output>
      </div>
    </div>
  );
}

/** The poster's Rows slider (PLAN.md §12 "Rows and dimensions"). */
export function RowsField({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  return (
    <RangeField
      label="Rows"
      min={1}
      max={POSTER_MAX_ROWS}
      value={form.posterRows}
      text={form.posterRows === 1 ? '1 row' : `${form.posterRows} rows`}
      disabled={disabled}
      testId="export-prows"
      onChange={(posterRows) => patch({ posterRows })}
    />
  );
}

/**
 * The poster's Width and Height sliders and the size quick picks (PLAN.md §12 "Rows and
 * dimensions"). Each side keeps a fixed range (a max that followed the other side moved this
 * thumb while its number stayed); a dragged side stops where width × height reaches the cap.
 */
export function PosterSizeFields({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  const id = useId();
  const w = form.posterWidth;
  const h = form.posterHeight;
  return (
    <>
      <Radios
        legend="Size"
        name={`${id}-psize`}
        value={posterPreset(form) ?? ''}
        options={POSTER_SIZES}
        disabled={disabled}
        testId="export-psize"
        onChange={(p) => {
          const o = POSTER_SIZES.find((x) => x.id === p);
          if (o) patch({ posterWidth: o.width, posterHeight: o.height });
        }}
      />
      <RangeField
        label="Width"
        min={POSTER_MIN_SIDE}
        max={POSTER_MAX_SIDE}
        value={w}
        text={`${w} px`}
        disabled={disabled}
        testId="export-pwidth"
        onChange={(v) => {
          const d = clampPosterDims(v, h, 'height');
          patch({ posterWidth: d.width, posterHeight: d.height });
        }}
      />
      <RangeField
        label="Height"
        min={POSTER_MIN_SIDE}
        max={POSTER_MAX_SIDE}
        value={h}
        text={`${h} px`}
        disabled={disabled}
        testId="export-pheight"
        onChange={(v) => {
          const d = clampPosterDims(w, v, 'width');
          patch({ posterWidth: d.width, posterHeight: d.height });
        }}
      />
      {posterCapped(w, h) && (
        <small className="export-hint" data-testid="export-pcap">
          Capped at {(POSTER_MAX_AREA / 1e6).toFixed(1)} million pixels, the largest image every
          browser can draw (Safari’s limit). {POSTER_MAX_SIDE} px is the most for one side.
        </small>
      )}
    </>
  );
}

/** Overview height, CSS px. */
const OVERVIEW_H = 48;

/**
 * The piece in miniature for the Section's range: every line as a thin polyline (one sample per
 * 2 px) and the section labels at their markers, x = t / duration · width (the handles use the
 * same mapping).
 */
function drawOverview(
  c: HTMLCanvasElement,
  compiled: ReturnType<typeof usePlayer.getState>['compiled'],
  labels: readonly { t: number; text: string }[],
  dark: boolean,
): void {
  const g = c.getContext('2d');
  if (!g) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w === 0 || h === 0) return;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tk = tokensOf(dark ? 'dark' : 'light');
  g.clearRect(0, 0, w, h);
  const D = Math.max(1e-6, compiled.duration);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of compiled.voices) {
    for (const sg of v.segments) {
      lo = Math.min(lo, sg.p0, sg.p1);
      hi = Math.max(hi, sg.p0, sg.p1);
    }
  }
  if (!(hi > lo)) {
    lo -= 6;
    hi += 6;
  }
  const top = 13;
  const bottom = h - 3;
  const y = (p: number) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);
  g.strokeStyle = tk.ink2;
  g.globalAlpha = 0.85;
  g.lineWidth = 1;
  g.lineJoin = 'round';
  for (const v of compiled.voices) {
    for (const sg of v.segments) {
      const x0 = (sg.t0 / D) * w;
      const x1 = (sg.t1 / D) * w;
      g.beginPath();
      g.moveTo(x0, y(sg.p0));
      if (sg.p0 !== sg.p1 || sg.curve) {
        for (let x = x0 + 2; x < x1; x += 2) g.lineTo(x, y(evalSegment(sg, (x / w) * D)));
      }
      g.lineTo(Math.max(x1, x0 + 0.5), y(sg.p1));
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  g.font = `500 8.5px ${getComputedStyle(c).fontFamily}`;
  g.fillStyle = tk.ink2;
  g.strokeStyle = tk.rule;
  let lastEnd = -1e9;
  for (const l of labels) {
    const x = Math.round((l.t / D) * w) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    const text = l.text.toUpperCase();
    const tw = g.measureText(text).width;
    if (x >= lastEnd + 6 && x + 3 + tw < w) {
      g.fillText(text, x + 3, 9);
      lastEnd = x + 3 + tw;
    }
  }
}

/** A handle's time typed in a text field ("1:05.5" or seconds), committed on Enter or blur. */
function ClockInput({
  label,
  value,
  disabled,
  testId,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  testId: string;
  onCommit: (t: number) => void;
}) {
  const shown = sectionClock(value);
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const t = parseClock(text);
    setText(null);
    if (t !== null) onCommit(t);
  };
  return (
    <label className="section-clock">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        spellCheck={false}
        value={text ?? shown}
        disabled={disabled}
        aria-invalid={text !== null && parseClock(text) === null}
        data-testid={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape' && text !== null) {
            e.preventDefault();
            e.stopPropagation();
            setText(null);
          }
        }}
      />
    </label>
  );
}

/**
 * The Section (PLAN.md §12 "Exports you can shape"): Whole piece, Loop region (when the piece
 * has one) or Custom, a two-handle range over the piece in miniature. Handles snap to bar lines
 * when the piece has a tempo (Alt: free); each is a slider (arrows: a bar, or a second without a
 * tempo; Shift: four; Alt: 0.1 s; Home / End), and the times can be typed.
 */
export function SectionField({
  form,
  disabled,
  timeline = false,
}: {
  form: ExportForm;
  disabled: boolean;
  /**
   * The video workspace's timeline (M15): the range always shows, with the preview's time on it;
   * moving a handle makes the section Custom.
   */
  timeline?: boolean;
}) {
  const id = useId();
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const appView = usePlayer((s) => s.view.theme);
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<SectionHandle | null>(null);
  const [width, setWidth] = useState(0);
  const D = compiled.duration;
  const grid = gridOf(piece);
  const loop = loopRegion();
  const kinds = SECTION_KINDS.filter((k) => k.id !== 'loop' || loop !== null);
  // Loop without a loop region (it was removed) shows as Whole.
  const kind = form.section === 'loop' && !loop ? 'whole' : form.section;
  const span = sectionNow(form);
  const custom = kind === 'custom';
  const ranged = custom || timeline;
  const cspan = custom ? (form.sectionSpan ?? span) : span;
  const previewT = useExportUi((s) => (timeline ? s.previewT : 0));

  const labels = useMemo(() => {
    const out: { t: number; text: string }[] = [];
    for (const m of piece.moments) if (m.label) out.push({ t: m.at, text: m.label });
    return out.sort((a, b) => a.t - b.t);
  }, [piece.moments]);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => setWidth((w) => (w === el.clientWidth ? w : el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ranged]);

  useEffect(() => {
    if (ranged && canvas.current && width > 0) {
      drawOverview(canvas.current, compiled, labels, appDark());
    }
  }, [ranged, compiled, labels, width, appView]);

  const setSpan = (next: TimeSpan) => {
    const f = useExportUi.getState().form;
    const cur = f.sectionSpan;
    if (f.section === 'custom' && cur && cur.start === next.start && cur.end === next.end) return;
    patch(
      f.section === 'custom' ? { sectionSpan: next } : { section: 'custom', sectionSpan: next },
    );
  };
  const timeAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return (Math.min(Math.max(clientX - r.left, 0), r.width) / r.width) * D;
  };
  const onMove = (e: React.PointerEvent) => {
    const h = drag.current;
    if (!h) return;
    const f = useExportUi.getState().form;
    const cur = f.section === 'custom' ? (f.sectionSpan ?? cspan) : cspan;
    setSpan(moveHandle(cur, h, timeAt(e.clientX), D, grid, e.altKey));
  };
  const startDrag = (e: React.PointerEvent, h: SectionHandle) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    drag.current = h;
    track.current?.setPointerCapture(e.pointerId);
    (track.current?.querySelector(`[data-handle="${h}"]`) as HTMLElement | null)?.focus();
    onMove(e);
  };

  const pct = (t: number) =>
    `${(Math.min(Math.max(t / Math.max(D, 1e-6), 0), 1) * 100).toFixed(3)}%`;
  const handle = (h: SectionHandle) => {
    const t = cspan[h];
    const name = h === 'start' ? 'Section start' : 'Section end';
    return (
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={Math.round(D * 10) / 10}
        aria-valuenow={Math.round(t * 10) / 10}
        aria-valuetext={sectionClock(t)}
        aria-disabled={disabled || undefined}
        aria-describedby={`${id}-keys`}
        className={`section-handle ${h}`}
        data-handle={h}
        data-testid={`section-${h}`}
        style={{ left: pct(t) }}
        onPointerDown={(e) => {
          e.stopPropagation();
          startDrag(e, h);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          const next = stepHandle(cspan, h, e.key, { shift: e.shiftKey, alt: e.altKey }, D, grid);
          if (!next) return;
          e.preventDefault();
          setSpan(next);
        }}
      />
    );
  };

  return (
    <div className="section-field" data-testid="export-section-field">
      <Radios
        legend="Section"
        name={`${id}-section`}
        value={kind}
        options={kinds}
        disabled={disabled}
        testId="export-section"
        onChange={(section) => {
          if (section === 'custom' && !useExportUi.getState().form.sectionSpan) {
            patch({ section, sectionSpan: defaultCustomSpan(D, cameraOf(), loop, grid) });
          } else patch({ section });
        }}
      />
      {ranged && (
        <>
          <div
            ref={track}
            className={disabled ? 'section-range disabled' : 'section-range'}
            data-testid="section-range"
            style={{ height: `${OVERVIEW_H}px` }}
            onPointerDown={(e) => {
              // A press on the track moves the nearer handle there.
              const t = timeAt(e.clientX);
              startDrag(e, Math.abs(t - cspan.start) <= Math.abs(t - cspan.end) ? 'start' : 'end');
            }}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <canvas
              ref={canvas}
              className="section-overview"
              role="img"
              aria-label="The piece in miniature"
              data-testid="section-overview"
            />
            <div className="section-shade" style={{ left: 0, width: pct(cspan.start) }} />
            <div className="section-shade" style={{ left: pct(cspan.end), right: 0 }} />
            <div
              className="section-sel"
              style={{
                left: pct(cspan.start),
                width: `calc(${pct(cspan.end)} - ${pct(cspan.start)})`,
              }}
            />
            {timeline && (
              <div
                className="section-playhead"
                aria-hidden="true"
                data-testid="timeline-playhead"
                style={{ left: pct(previewT) }}
              />
            )}
            {handle('start')}
            {handle('end')}
          </div>
          <small className="visually-hidden" id={`${id}-keys`}>
            {grid
              ? 'Arrow keys move by a bar, Shift by four bars, Alt by a tenth of a second.'
              : 'Arrow keys move by a second, Shift by ten, Alt by a tenth.'}
          </small>
          <div className="field-row section-times">
            <ClockInput
              label="Start"
              value={cspan.start}
              disabled={disabled}
              testId="section-start-text"
              onCommit={(t) => setSpan(typeHandle(cspan, 'start', t, D))}
            />
            <ClockInput
              label="End"
              value={cspan.end}
              disabled={disabled}
              testId="section-end-text"
              onCommit={(t) => setSpan(typeHandle(cspan, 'end', t, D))}
            />
          </div>
        </>
      )}
      {kind !== 'whole' && (
        <small className="export-hint" data-testid="section-summary">
          {sectionText(span, D)} ({Math.round((span.end - span.start) * 10) / 10} s)
          {grid ? (custom ? '. Snaps to bars; hold Alt to place freely.' : '') : ''}
        </small>
      )}
    </div>
  );
}

/**
 * Poster | Video at the top of the workspace and the video dialog (PLAN.md §15 M14 "Entry"):
 * segmented radios; the choice is remembered as the mode Menu → Export opens.
 */
export function ExportModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: ExportMode;
  disabled?: boolean;
  onChange: (m: ExportMode) => void;
}) {
  const id = useId();
  return (
    <div
      className="seg radios export-mode"
      role="radiogroup"
      aria-label="Export"
      data-testid="export-mode"
    >
      {EXPORT_MODES.map((m) => (
        <label key={m.id} className={value === m.id ? 'on' : undefined}>
          <input
            type="radio"
            name={`${id}-mode`}
            value={m.id}
            checked={value === m.id}
            disabled={disabled}
            onChange={() => onChange(m.id)}
          />
          <span>{m.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * An export's status line: progress while running, else the last run's message, after the
 * surface's own idle lines (`children`). Announced politely.
 */
export function RunStatus({ run, children }: { run: RunState; children?: ReactNode }) {
  const running = run.status === 'running';
  return (
    <div className="export-status" aria-live="polite" data-testid="export-status">
      {!running && children}
      {running && (
        <>
          <progress
            value={run.fraction ?? undefined}
            max={1}
            aria-label="Export progress"
            data-testid="export-progress"
          />
          <p className="export-size">
            {run.fraction !== null ? `${Math.round(run.fraction * 100)}%. ` : ''}
            {run.label}
          </p>
        </>
      )}
      {!running && run.message && (
        <p
          className={run.status === 'error' ? 'export-warn' : 'export-size'}
          role={run.status === 'error' ? 'alert' : undefined}
          data-testid="export-message"
        >
          {run.message}
        </p>
      )}
    </div>
  );
}

/** The poster's size and file for the status line ("3840 × 2160, PNG"). */
export function posterSummary(form: ExportForm): string {
  return `${posterPixels(form)}, ${form.posterFormat.toUpperCase()}`;
}
