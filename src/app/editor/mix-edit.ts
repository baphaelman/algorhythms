/**
 * Master FX editing behind the Sound drawer's Master section (PLAN.md §8.6, §11.3): the slider
 * table for `Piece.mix`, pure recipes, per-section reset to `defaultMix()`, and the delay time in
 * beats. A mix edit reaches the engine through the store (`mixAudio` on every new `piece.mix`),
 * where every parameter is smoothed per block. Drags reuse the timbre sliders' gesture
 * (`beginTimbreDrag` …): one undo entry, one update per frame.
 */

import { defaultMix } from '../../core/defaults';
import type { MixSettings, ViewSettings } from '../../core/types';
import type { Recipe } from './history';
import { beatStep } from './snap';
import { rawValueOf, roundFor, sameValue, type SliderControl } from './timbre-edit';

/** The Master section's groups; each has its own Reset ('bus': glue and width). */
export type MixSection = 'reverb' | 'delay' | 'sends' | 'tone' | 'bus';

/** The optional top-level master numbers (§12 "Ready for YouTube") and their absent values. */
const BUS_DEFAULTS = { glue: 0, width: 1 } as const;

export interface MixControl extends SliderControl {
  section: MixSection;
}

const m = (
  id: string,
  label: string,
  section: MixSection,
  path: readonly string[],
  min: number,
  max: number,
  step: number,
  unit = '',
  curve: SliderControl['curve'] = 'lin',
): MixControl => ({ id, label, section, path, min, max, step, curve, unit });

/**
 * Every master slider. Ranges lie inside the schema bounds and the engine's own clamps (delay
 * ≤ 2 s and feedback ≤ 0.95, pre-delay ≤ 0.5 s, tilt ±6 dB/oct); times and frequencies are log.
 */
export const MIX_CONTROLS: readonly MixControl[] = [
  m('rev-size', 'Room size', 'reverb', ['reverb', 'size'], 0, 1, 0.01),
  m('rev-decay', 'Decay', 'reverb', ['reverb', 'decay'], 0.2, 20, 0.01, ' s', 'log'),
  m('rev-damping', 'Damping', 'reverb', ['reverb', 'damping'], 0, 1, 0.01),
  m('rev-predelay', 'Pre-delay', 'reverb', ['reverb', 'preDelay'], 0, 0.25, 0.001, ' s', 'sqrt'),
  m('rev-return', 'Return', 'reverb', ['reverb', 'returnLevel'], 0, 1, 0.005, '', 'sqrt'),
  m('dly-time', 'Time', 'delay', ['delay', 'time'], 0.02, 2, 0.001, ' s', 'log'),
  m('dly-feedback', 'Feedback', 'delay', ['delay', 'feedback'], 0, 0.9, 0.01),
  m('dly-return', 'Return', 'delay', ['delay', 'returnLevel'], 0, 1, 0.005, '', 'sqrt'),
  m('send-rev', 'Reverb send', 'sends', ['sends', 'reverb'], 0, 1, 0.005, '', 'sqrt'),
  m('send-dly', 'Delay send', 'sends', ['sends', 'delay'], 0, 1, 0.005, '', 'sqrt'),
  m('tone-tilt', 'Tilt', 'tone', ['tone', 'tilt'], -6, 6, 0.1, ' dB/oct'),
  m('tone-lowpass', 'Low-pass', 'tone', ['tone', 'lowpassHz'], 200, 20000, 1, ' Hz', 'log'),
  m('glue', 'Glue', 'bus', ['glue'], 0, 1, 0.01),
  m('width', 'Width', 'bus', ['width'], 0, 2, 0.01),
];

/** The delay-time control (beats with a tempo). */
export const DELAY_TIME = MIX_CONTROLS.find((c) => c.id === 'dly-time')!;

/** The number at `path` in the mix (the default's when a file left it out). */
export function mixValue(mix: MixSettings, path: readonly string[]): number {
  const read = (root: unknown): unknown =>
    path.reduce<unknown>(
      (o, k) =>
        o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
      root,
    );
  const v = read(mix);
  if (typeof v === 'number') return v;
  if (path.length === 1 && path[0] in BUS_DEFAULTS)
    return BUS_DEFAULTS[path[0] as keyof typeof BUS_DEFAULTS];
  return read(defaultMix()) as number;
}

/**
 * A recipe setting the mix number at `path` (two levels, or glue/width at the top; those are
 * left out again at their absent value); same piece when unchanged.
 */
export function setMixAt(path: readonly string[], value: number): Recipe {
  return (p) => {
    if (path.length === 1) {
      const key = path[0] as keyof typeof BUS_DEFAULTS;
      if (mixValue(p.mix, path) === value) return p;
      const mix = { ...p.mix, [key]: value };
      if (value === BUS_DEFAULTS[key]) delete mix[key];
      return { ...p, mix };
    }
    const [group, key] = path as [keyof MixSettings, string];
    const old = p.mix[group] as unknown as Record<string, number>;
    if (old[key] === value) return p;
    return { ...p, mix: { ...p.mix, [group]: { ...old, [key]: value } } };
  };
}

/** A recipe setting how `pan: 'auto'` voices spread. */
export function setPanAuto(v: MixSettings['panAuto']): Recipe {
  return (p) => (p.mix.panAuto === v ? p : { ...p, mix: { ...p.mix, panAuto: v } });
}

/** How the mix normalises its sum (§8.4 revision 10); absent means 'part'. */
export const normaliseOf = (mix: MixSettings): 'all' | 'part' => mix.normalise ?? 'part';

/** A recipe setting the level normalisation; same piece when unchanged. */
export function setNormalise(v: 'all' | 'part'): Recipe {
  return (p) => (normaliseOf(p.mix) === v ? p : { ...p, mix: { ...p.mix, normalise: v } });
}

/** Whether a section holds the defaults (Sends also covers `panAuto`). */
export function isSectionDefault(mix: MixSettings, section: MixSection): boolean {
  if (section === 'bus')
    return (mix.glue ?? BUS_DEFAULTS.glue) === 0 && (mix.width ?? BUS_DEFAULTS.width) === 1;
  const d = defaultMix();
  return sameValue(mix[section], d[section]) && (section !== 'sends' || mix.panAuto === d.panAuto);
}

/** A recipe putting a section back to `defaultMix()`; same piece when it already is. */
export function resetSection(section: MixSection): Recipe {
  return (p) => {
    if (isSectionDefault(p.mix, section)) return p;
    if (section === 'bus') {
      const { glue: _g, width: _w, ...mix } = p.mix;
      return { ...p, mix };
    }
    const d = defaultMix();
    const mix = { ...p.mix, [section]: d[section] };
    if (section === 'sends') mix.panAuto = d.panAuto;
    return { ...p, mix };
  };
}

// ---------------------------------------------------------------------------------------------
// Delay time in beats
// ---------------------------------------------------------------------------------------------

/** Delay times the slider snaps to with Snap to beats, in beats (1/16 … 1/2 note in x/4). */
export const DELAY_BEATS: readonly { beats: number; name: string }[] = [
  { beats: 0.25, name: '1/16' },
  { beats: 0.5, name: '1/8' },
  { beats: 0.75, name: 'dotted 1/8' },
  { beats: 1, name: '1/4' },
  { beats: 1.5, name: 'dotted 1/4' },
  { beats: 2, name: '1/2' },
];

/** Seconds per beat when the piece has a tempo (drawn or snapping), else null. */
export function beatSeconds(view: Pick<ViewSettings, 'gridBpm'>): number | null {
  const bpm = view.gridBpm;
  return bpm !== undefined && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null;
}

/**
 * The delay time at slider position `pos`. With Snap to beats on (and not `alt`), the nearest
 * (in log distance) of `DELAY_BEATS` that fits the range, to 1 µs; else rounded as usual.
 */
export function delayTimeAt(
  pos: number,
  view: Pick<ViewSettings, 'gridBpm' | 'snapBeats'>,
  alt = false,
): number {
  const raw = rawValueOf(DELAY_TIME, pos);
  const beat = alt ? null : beatStep(view);
  if (beat !== null) {
    let best = 0;
    let bestDist = Infinity;
    for (const { beats } of DELAY_BEATS) {
      const t = Math.round(beats * beat * 1e6) / 1e6;
      const dist = Math.abs(Math.log(t / raw));
      if (t >= DELAY_TIME.min && t <= DELAY_TIME.max && dist < bestDist) {
        best = t;
        bestDist = dist;
      }
    }
    if (best > 0) return best;
  }
  return roundFor(DELAY_TIME, raw);
}

const trim = (x: number, digits: number): string => String(Number(x.toFixed(digits)));

/** The delay time for display: `0.75 beat · 0.45 s` (with a named note value when it is one). */
export function formatDelay(time: number, view: Pick<ViewSettings, 'gridBpm'>): string {
  const beat = beatSeconds(view);
  const s = `${trim(time, 3)} s`;
  if (beat === null) return s;
  const beats = time / beat;
  const named = DELAY_BEATS.find((d) => Math.abs(d.beats - beats) < 1e-4);
  const b = `${trim(beats, 2)} ${Math.abs(beats - 1) < 1e-4 ? 'beat' : 'beats'}`;
  return named ? `${named.name} · ${b} · ${s}` : `${b} · ${s}`;
}

/** A master value for display (Hz above 1 kHz as kHz; glue off, width as a percentage). */
export function formatMix(ctl: MixControl, value: number): string {
  if (ctl.id === 'glue') return value === 0 ? 'off' : trim(value, 2);
  if (ctl.id === 'width') return value === 0 ? 'mono' : `${Math.round(value * 100)} %`;
  if (ctl.unit === ' Hz' && value >= 1000) return `${trim(value / 1000, 2)} kHz`;
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 3;
  return `${trim(value, digits)}${ctl.unit}`;
}
