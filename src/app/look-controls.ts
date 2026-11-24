/**
 * The Export dialog's Look controls (PLAN.md §12 "Export look", controls): continuous values are
 * sliders, yes/no choices switches, small fixed sets segmented buttons, Heads a row of on/off
 * segments. Each control is a pure mapping between the form and its value, and sets exactly the
 * fields the old checkboxes, radios and dropdowns set, so the Look, the video and poster options
 * and the remembered prefs keep their meaning.
 */

import { DEFAULT_HUD } from '../render/hud';
import { LINE_SCALE_MAX, LINE_SCALE_MIN, lineScaleOf } from '../render/look';
import {
  FOLLOW_AT_HIDDEN,
  FOLLOW_AT_MAX,
  FOLLOW_AT_MIN,
  FOLLOW_AT_SHOWN,
  HUD_CHOICES,
  followAtOf,
  type ExportForm,
  type LookForm,
} from './export-options';

export type LookKind = 'video' | 'poster';

export interface LookChoice {
  value: string;
  label: string;
}

interface Base {
  /** The control's test id (`look-<id>`). */
  id: string;
  label: string;
  /** A tooltip. */
  hint?: string;
  /** The formats that show it. */
  kinds: readonly LookKind[];
}

/** One of a few options, as segmented buttons. */
export interface LookSegments extends Base {
  type: 'segments';
  choices: readonly LookChoice[];
  /** The selected option's value (or '' when the form matches none). */
  value(form: ExportForm): string;
  apply(form: ExportForm, value: string): Partial<ExportForm>;
}

/** A yes/no choice, as a switch; `label` says what On means. */
export interface LookToggle extends Base {
  type: 'toggle';
  value(form: ExportForm): boolean;
  apply(form: ExportForm, on: boolean): Partial<ExportForm>;
}

/** A continuous value, as a slider with its value shown. */
export interface LookSlider extends Base {
  type: 'slider';
  min: number;
  max: number;
  step: number;
  value(form: ExportForm): number;
  apply(form: ExportForm, n: number): Partial<ExportForm>;
  /** The value as shown beside the slider (and its aria-valuetext). */
  text(n: number): string;
}

/** Independent flags in one row, as on/off segments. */
export interface LookFlags extends Base {
  type: 'flags';
  flags: readonly { id: string; label: string; key: FlagKey }[];
}

type FlagKey = { [K in keyof LookForm]-?: LookForm[K] extends boolean ? K : never }[keyof LookForm];

export type LookControl = LookSegments | LookToggle | LookSlider | LookFlags;

const BOTH: readonly LookKind[] = ['video', 'poster'];
const VIDEO: readonly LookKind[] = ['video'];

const look = (form: ExportForm, p: Partial<LookForm>): Partial<ExportForm> => ({
  look: { ...form.look, ...p },
});

/** Segments whose options each set a few Look fields; `value` names the form's state. */
function segments(
  id: string,
  label: string,
  kinds: readonly LookKind[],
  options: readonly { value: string; label: string; set: Partial<LookForm> }[],
  value: (l: LookForm) => string,
): LookSegments {
  return {
    type: 'segments',
    id,
    label,
    kinds,
    choices: options.map((o) => ({ value: o.value, label: o.label })),
    value: (form) => value(form.look),
    apply: (form, v) => {
      const o = options.find((x) => x.value === v);
      return o ? look(form, o.set) : {};
    },
  };
}

function onOff(id: string, label: string, key: FlagKey, kinds: readonly LookKind[]): LookToggle {
  return {
    type: 'toggle',
    id,
    label,
    kinds,
    value: (form) => form.look[key],
    apply: (form, on) => look(form, { [key]: on }),
  };
}

const pct = (x: number) => Math.round(x * 100);

/**
 * Ahead of the playhead, 0..100 %: 0 = hidden (nothing drawn ahead), 100 = full, between =
 * dimmed at that opacity. Hidden and Full keep the dimmed opacity, as the old radios did.
 */
export function futurePercent(l: Pick<LookForm, 'future' | 'futureOpacity'>): number {
  if (l.future === 'hidden') return 0;
  if (l.future === 'full') return 100;
  // A dimmed future is never shown at an end, which would read as Hidden or Full.
  return Math.min(99, Math.max(1, pct(l.futureOpacity)));
}

export function futureFromPercent(n: number): Pick<LookForm, 'future'> & Partial<LookForm> {
  const r = Math.round(n);
  if (!(r > 0)) return { future: 'hidden' };
  if (r >= 100) return { future: 'full' };
  return { future: 'dimmed', futureOpacity: r / 100 };
}

const futureControl: LookSlider = {
  type: 'slider',
  id: 'future',
  label: 'Ahead of the playhead',
  kinds: VIDEO,
  min: 0,
  max: 100,
  step: 1,
  value: (form) => futurePercent(form.look),
  apply: (form, n) => (Number.isFinite(n) ? look(form, futureFromPercent(n)) : {}),
  text: (n) => (n <= 0 ? 'Hidden' : n >= 100 ? 'Full' : `${Math.round(n)} %`),
};

const followAtControl: LookSlider = {
  type: 'slider',
  id: 'follow-at',
  label: 'Playhead at',
  kinds: VIDEO,
  min: FOLLOW_AT_MIN,
  max: FOLLOW_AT_MAX,
  step: 1,
  value: (form) => Math.round(followAtOf(form)),
  apply: (_form, n) =>
    Number.isFinite(n)
      ? { videoFollowAt: Math.min(FOLLOW_AT_MAX, Math.max(FOLLOW_AT_MIN, Math.round(n))) }
      : {},
  text: (n) => `${Math.round(n)} %`,
};

/** "1×", "0.6×", "1.75×". */
const factor = (n: number) => `${Number(n.toFixed(2))}×`;

const widthControl: LookSlider = {
  type: 'slider',
  id: 'width',
  label: 'Line width',
  kinds: BOTH,
  min: LINE_SCALE_MIN,
  max: LINE_SCALE_MAX,
  step: 0.05,
  value: (form) => lineScaleOf(form.look.lineWidth),
  apply: (form, n) =>
    Number.isFinite(n) ? look(form, { lineWidth: Number(lineScaleOf(n).toFixed(2)) }) : {},
  text: factor,
};

/** A 0..100 % slider over a 0..1 Look amount (absent = 0, and 0 leaves the field out). */
function amount(
  id: string,
  label: string,
  key: 'glow' | 'vignette' | 'minLineOpacity',
  hint: string,
): LookSlider {
  return {
    type: 'slider',
    id,
    label,
    hint,
    kinds: BOTH,
    min: 0,
    max: 100,
    step: 1,
    value: (form) => pct(form.look[key] ?? 0),
    apply: (form, n) => {
      if (!Number.isFinite(n)) return {};
      const v = Math.min(100, Math.max(0, Math.round(n))) / 100;
      const { [key]: _drop, ...rest } = form.look;
      return { look: v > 0 ? { ...rest, [key]: v } : rest };
    },
    text: (n) => (n <= 0 ? 'Off' : `${Math.round(n)} %`),
  };
}

/**
 * The Look's controls in dialog order (Theme, the HUD and the Colours group, which holds line
 * colours and the poster's transparent background, are separate controls).
 */
export const LOOK_CONTROLS: readonly LookControl[] = [
  segments(
    'guides',
    'Guides',
    BOTH,
    [
      { value: 'off', label: 'Off', set: { guides: false, guideLabels: false } },
      { value: 'lines', label: 'Lines', set: { guides: true, guideLabels: false } },
      { value: 'labels', label: 'Lines + labels', set: { guides: true, guideLabels: true } },
    ],
    (l) => (!l.guides ? 'off' : l.guideLabels ? 'labels' : 'lines'),
  ),
  segments(
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
  segments(
    'moments',
    'Moments',
    BOTH,
    [
      { value: 'off', label: 'Off', set: { markers: false, sections: false } },
      { value: 'labels', label: 'Labels', set: { markers: false, sections: true } },
      { value: 'markers', label: 'Markers', set: { markers: true, sections: false } },
      { value: 'all', label: 'Both', set: { markers: true, sections: true } },
    ],
    (l) => (l.markers ? (l.sections ? 'all' : 'markers') : l.sections ? 'labels' : 'off'),
  ),
  futureControl,
  followAtControl,
  onOff('playhead', 'Playhead line', 'playhead', VIDEO),
  onOff('level', 'Louder lines brighter', 'levelOpacity', BOTH),
  onOff('thickness', 'Thicker when merged or weighted', 'thickness', BOTH),
  onOff('pulse', 'Pulse marks', 'pulseMarks', BOTH),
  {
    type: 'flags',
    id: 'heads',
    label: 'Heads',
    kinds: VIDEO,
    flags: [
      { id: 'dots', label: 'Dots', key: 'dots' },
      { id: 'rings', label: 'Rings', key: 'rings' },
      { id: 'hz', label: 'Hz', key: 'hzLabels' },
    ],
  },
  widthControl,
  amount('glow', 'Glow', 'glow', 'Soft light around the lines.'),
  amount('vignette', 'Vignette', 'vignette', 'Darkens the corners.'),
  amount(
    'min-opacity',
    'Minimum line opacity',
    'minLineOpacity',
    'Sounding lines are drawn at least this bright, so gated parts stay bold between hits.',
  ),
];

/** The controls a format shows. */
export function lookControls(kind: LookKind): LookControl[] {
  return LOOK_CONTROLS.filter((c) => c.kinds.includes(kind));
}

/** The default HUD of a format: video today's readouts, poster none. */
export function defaultHud(kind: LookKind) {
  return kind === 'video' ? DEFAULT_HUD : [];
}

/** The HUD row's count: "6 readouts", "1 readout", "None". */
export function hudSummary(items: readonly unknown[]): string {
  const n = HUD_CHOICES.filter((c) => items.includes(c.id)).length;
  return n === 0 ? 'None' : `${n} readout${n === 1 ? '' : 's'}`;
}

/** The note under Playhead at. */
export function followAtHint(form: ExportForm): string {
  if (form.videoCamera === 'whole') return 'Follow only (Whole piece: the playhead moves across).';
  if (form.videoCamera !== 'follow') return 'Follow only (the camera places it).';
  if (form.videoFollowAt !== null) return 'Across the frame.';
  const by = form.look.future === 'hidden' ? FOLLOW_AT_HIDDEN : FOLLOW_AT_SHOWN;
  return `Across the frame; ${by} % follows Ahead of the playhead until you change it.`;
}
