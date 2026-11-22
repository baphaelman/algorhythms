/**
 * The Export dialog's compact Look (PLAN.md §12 "Export look", preview and layout): each
 * dropdown or switch (`toggle`, two-way choices) as a pure mapping between the form and one `<select>` value. A dropdown sets exactly
 * the fields its checkboxes or radios set before, so the Look, the video and poster options and
 * the remembered prefs keep their meaning. A form state no option names (an older stored
 * combination) gets an extra option of its own, so the select never shows something else.
 */

import { DEFAULT_HUD } from '../render/hud';
import {
  FOLLOW_AT_HIDDEN,
  FOLLOW_AT_SHOWN,
  HUD_CHOICES,
  LOOK_COLORS,
  LOOK_WIDTHS,
  followAtOf,
  type ExportForm,
  type LookForm,
} from './export-options';

export type LookKind = 'video' | 'poster';

export interface LookChoice {
  value: string;
  label: string;
}

export interface LookControl {
  /** The control's test id (`look-<id>`). */
  id: string;
  label: string;
  /** A two-way choice, shown as a switch: values 'on' / 'off', `label` names the 'on' state. */
  toggle?: true;
  /** The formats that show it. */
  kinds: readonly LookKind[];
  /** The options, including one for the current value when no listed option names it. */
  choices(form: ExportForm): LookChoice[];
  /** The selected option's value. */
  value(form: ExportForm): string;
  /** The form fields to change for an option (a Partial to merge into the form). */
  apply(form: ExportForm, value: string): Partial<ExportForm>;
}

const BOTH: readonly LookKind[] = ['video', 'poster'];
const VIDEO: readonly LookKind[] = ['video'];
const POSTER: readonly LookKind[] = ['poster'];

const look = (form: ExportForm, p: Partial<LookForm>): Partial<ExportForm> => ({
  look: { ...form.look, ...p },
});

/** A control whose options each set a few Look fields; `value` names the form's state. */
function fixed(
  id: string,
  label: string,
  kinds: readonly LookKind[],
  options: readonly { value: string; label: string; set: Partial<LookForm> }[],
  value: (l: LookForm) => string,
  other?: (l: LookForm) => string,
): LookControl {
  return {
    id,
    label,
    kinds,
    choices: (form) => {
      const v = value(form.look);
      const list: LookChoice[] = options.map((o) => ({ value: o.value, label: o.label }));
      if (!list.some((o) => o.value === v)) list.push({ value: v, label: other?.(form.look) ?? v });
      return list;
    },
    value: (form) => value(form.look),
    apply: (form, v) => {
      const o = options.find((x) => x.value === v);
      return o ? look(form, o.set) : {};
    },
  };
}

/** A switch for one flag; `label` says what On means. */
function onOff(
  id: string,
  label: string,
  key: keyof LookForm,
  kinds: readonly LookKind[],
): LookControl {
  const c = fixed(
    id,
    label,
    kinds,
    [
      { value: 'on', label: 'On', set: { [key]: true } },
      { value: 'off', label: 'Off', set: { [key]: false } },
    ],
    (l) => (l[key] ? 'on' : 'off'),
  );
  return { ...c, toggle: true };
}

/** Dimmed opacities offered, %. */
export const DIMMED_STEPS = [20, 35, 50, 75] as const;
/** Playhead places offered, %. */
export const FOLLOW_AT_STEPS = [35, 50, 65, 80, 90] as const;

const pct = (x: number) => Math.round(x * 100);

const futureValue = (l: LookForm): string =>
  l.future === 'dimmed' ? `dimmed:${pct(l.futureOpacity)}` : l.future;

const futureControl: LookControl = {
  id: 'future',
  label: 'Ahead of the playhead',
  kinds: VIDEO,
  choices: (form) => {
    const list: LookChoice[] = [{ value: 'hidden', label: 'Hidden' }];
    const steps: number[] = [...DIMMED_STEPS];
    const cur = pct(form.look.futureOpacity);
    if (form.look.future === 'dimmed' && !steps.includes(cur)) steps.push(cur);
    for (const s of steps.sort((a, b) => a - b)) {
      list.push({ value: `dimmed:${s}`, label: `Dimmed ${s} %` });
    }
    list.push({ value: 'full', label: 'Full' });
    return list;
  },
  value: (form) => futureValue(form.look),
  apply: (form, v) => {
    if (v === 'hidden' || v === 'full') return look(form, { future: v });
    const m = /^dimmed:(\d+)$/.exec(v);
    if (!m) return {};
    return look(form, { future: 'dimmed', futureOpacity: Number(m[1]) / 100 });
  },
};

const followAtControl: LookControl = {
  id: 'follow-at',
  label: 'Playhead at',
  kinds: VIDEO,
  choices: (form) => {
    const cur = followAtOf(form);
    const steps: number[] = [...FOLLOW_AT_STEPS];
    if (!steps.includes(cur)) steps.push(cur);
    return steps.sort((a, b) => a - b).map((s) => ({ value: String(s), label: `${s} %` }));
  },
  value: (form) => String(followAtOf(form)),
  apply: (_form, v) => {
    const n = Number(v);
    return Number.isFinite(n) ? { videoFollowAt: n } : {};
  },
};

const HEADS = [
  { value: 'none', label: 'None', set: { dots: false, rings: false, hzLabels: false } },
  { value: 'dots', label: 'Dots', set: { dots: true, rings: false, hzLabels: false } },
  { value: 'dots-hz', label: 'Dots + Hz', set: { dots: true, rings: false, hzLabels: true } },
  { value: 'dots-rings', label: 'Dots + rings', set: { dots: true, rings: true, hzLabels: false } },
  { value: 'all', label: 'Dots + rings + Hz', set: { dots: true, rings: true, hzLabels: true } },
] as const;

function headsValue(l: LookForm): string {
  const h = HEADS.find(
    (o) => o.set.dots === l.dots && o.set.rings === l.rings && o.set.hzLabels === l.hzLabels,
  );
  return h ? h.value : `custom:${+l.dots}${+l.rings}${+l.hzLabels}`;
}

function headsLabel(l: LookForm): string {
  const parts = [l.rings && 'Rings', l.hzLabels && 'Hz'].filter(Boolean);
  return parts.length ? `${parts.join(' + ')} (no dots)` : 'None';
}

/** The Look's dropdowns in dialog order (Theme and the HUD are separate controls). */
export const LOOK_CONTROLS: readonly LookControl[] = [
  fixed(
    'guides',
    'Guides',
    BOTH,
    [
      { value: 'off', label: 'Off', set: { guides: false, guideLabels: false } },
      { value: 'lines', label: 'Lines', set: { guides: true, guideLabels: false } },
      { value: 'labels', label: 'Lines + Hz labels', set: { guides: true, guideLabels: true } },
    ],
    (l) => (!l.guides ? 'off' : l.guideLabels ? 'labels' : 'lines'),
  ),
  fixed(
    'beats',
    'Beat lines',
    BOTH,
    [
      { value: 'off', label: 'Off', set: { beats: 'off' } },
      { value: 'auto', label: 'Bars and beats', set: { beats: 'auto' } },
      { value: 'every', label: 'Every beat', set: { beats: 'every' } },
    ],
    (l) => l.beats,
  ),
  fixed(
    'moments',
    'Moments',
    BOTH,
    [
      { value: 'off', label: 'Off', set: { markers: false, sections: false } },
      { value: 'markers', label: 'Markers', set: { markers: true, sections: false } },
      { value: 'all', label: 'Markers + labels', set: { markers: true, sections: true } },
      { value: 'labels', label: 'Labels only', set: { markers: false, sections: true } },
    ],
    (l) => (l.markers ? (l.sections ? 'all' : 'markers') : l.sections ? 'labels' : 'off'),
  ),
  futureControl,
  followAtControl,
  onOff('playhead', 'Playhead line', 'playhead', VIDEO),
  onOff('level', 'Louder lines brighter', 'levelOpacity', BOTH),
  onOff('thickness', 'Thicker when merged or weighted', 'thickness', BOTH),
  onOff('pulse', 'Pulse marks', 'pulseMarks', BOTH),
  fixed('heads', 'Heads', VIDEO, HEADS, headsValue, headsLabel),
  fixed(
    'colors',
    'Line colours',
    BOTH,
    LOOK_COLORS.map((c) => ({ value: c.id, label: c.label, set: { colors: c.id } })),
    (l) => l.colors,
  ),
  fixed(
    'width',
    'Line width',
    BOTH,
    LOOK_WIDTHS.map((w) => ({ value: w.id, label: w.label, set: { lineWidth: w.id } })),
    (l) => l.lineWidth,
  ),
  onOff('background', 'Transparent background', 'transparent', POSTER),
];

/** The controls a format shows. */
export function lookControls(kind: LookKind): LookControl[] {
  return LOOK_CONTROLS.filter((c) => c.kinds.includes(kind));
}

/** The default HUD of a format: video today's readouts, poster none. */
export function defaultHud(kind: LookKind) {
  return kind === 'video' ? DEFAULT_HUD : [];
}

/** The HUD button's text: "6 readouts", "1 readout", "None". */
export function hudSummary(items: readonly unknown[]): string {
  const n = HUD_CHOICES.filter((c) => items.includes(c.id)).length;
  return n === 0 ? 'None' : `${n} readout${n === 1 ? '' : 's'}`;
}

/** The note under Playhead at. */
export function followAtHint(form: ExportForm): string {
  if (form.videoCamera !== 'follow') return 'Follow only (Whole piece: the playhead moves across).';
  if (form.videoFollowAt !== null) return 'Across the frame.';
  const by = form.look.future === 'hidden' ? FOLLOW_AT_HIDDEN : FOLLOW_AT_SHOWN;
  return `Across the frame; ${by} % follows Ahead of the playhead until you change it.`;
}
