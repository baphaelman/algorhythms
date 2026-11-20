/**
 * Fields common to every moment (§6.1, §11.3 revisions 5–6): target voices (under "Advanced"),
 * the transition (sliders, Order and Curve chips, curve preview, Arrive together) and seed.
 */

import { useState } from 'react';
import { activeAt } from '../../../core/query';
import { momentSeed } from '../../../core/rng';
import type { EaseRef, Glide, GlideOrder, Moment, Piece, VoiceSelector } from '../../../core/types';
import { reroll, updateMoment } from '../../editor/actions';
import { usePlayer } from '../../store';
import { CheckField, Chips, NumberField, Row, Slider, fieldSetter } from './controls';
import { arriveGlide, easePath, targetMode, type TargetMode } from './fields';

const TARGET_MODES: readonly (readonly [TargetMode, string])[] = [
  ['all', 'All'],
  ['rank', 'By rank'],
  ['pick', 'Pick…'],
];

/**
 * Voice targeting (§11.3 Voices): moments target all voices by default, so the selector sits in
 * a collapsed "Advanced" fold, open when the moment already targets something else.
 */
export function TargetField({ m, piece }: { m: Moment; piece: Piece }) {
  const compiled = usePlayer((s) => s.compiled);
  const target = m.target;
  const pool = piece.voices.length;
  const mode = targetMode(target);
  // Voices sounding just before the moment acts: what `rank` counts from.
  const active = Math.max(1, activeAt(compiled, m.at).length);
  const rank = target && target !== 'all' && 'rank' in target ? target.rank : null;
  const [open, setOpen] = useState(mode !== 'all');

  const choose = (v: TargetMode): void => {
    if (v === mode) return;
    const next: VoiceSelector | undefined =
      v === 'all'
        ? undefined
        : v === 'pick'
          ? { voices: piece.voices.map((x) => x.id) }
          : { rank: [0, active - 1] };
    updateMoment(m.id, { target: next }, 'Change target');
  };

  const rankLo = fieldSetter<number>(m.id, 'Edit target', (x, v) => {
    const t = x.target;
    const hi = t && t !== 'all' && 'rank' in t ? t.rank[1] : v;
    return { target: { rank: [v, Math.max(v, hi)] } };
  });
  const rankHi = fieldSetter<number>(m.id, 'Edit target', (x, v) => {
    const t = x.target;
    const lo = t && t !== 'all' && 'rank' in t ? t.rank[0] : v;
    return { target: { rank: [Math.min(v, lo), v] } };
  });
  const rankProps = {
    integer: true,
    step: 1,
    min: 0,
    max: Math.max(0, pool - 1),
    format: (v: number) => String(v + 1),
    parse: (t: string) => (/^\d+$/.test(t.trim()) ? Number(t) - 1 : null),
  } as const;

  return (
    <details
      className="insp-advanced insp-target"
      data-testid="insp-advanced"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Advanced</summary>
      <Chips
        legend="Voices"
        className="target-modes"
        testId="insp-target"
        options={TARGET_MODES}
        pressed={(v) => v === mode}
        onPick={choose}
      />
      {target && target !== 'all' && 'voices' in target && (
        <fieldset className="insp-voices">
          <legend className="sr-only">Target voices</legend>
          {piece.voices.map((v) => {
            const on = target.voices.includes(v.id);
            return (
              <label key={v.id} className={on ? 'on' : undefined}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const ids = on
                      ? target.voices.filter((x) => x !== v.id)
                      : piece.voices
                          .map((x) => x.id)
                          .filter((x) => x === v.id || target.voices.includes(x));
                    updateMoment(m.id, { target: { voices: ids } }, 'Change target');
                  }}
                />
                {v.name ?? v.id}
              </label>
            );
          })}
        </fieldset>
      )}
      {rank && (
        <>
          <NumberField label="Lowest rank" value={rank[0]} set={rankLo} {...rankProps} />
          <NumberField label="Highest rank" value={rank[1]} set={rankHi} {...rankProps} />
        </>
      )}
    </details>
  );
}

const ORDERS: readonly (readonly [GlideOrder, string])[] = [
  ['random', 'Random'],
  ['low-first', 'Low → high'],
  ['high-first', 'High → low'],
  ['center-out', 'Centre out'],
  ['outside-in', 'Outside in'],
];

type EaseName = Exclude<EaseRef, object> | 'bezier';
const CURVES: readonly (readonly [EaseName, string])[] = [
  ['smootherstep', 'Smooth'],
  ['linear', 'Linear'],
  ['cosine', 'Cosine'],
  ['expo', 'Expo'],
  ['bezier', 'Custom'],
];

/** Writes one glide field into the moment's partial glide. */
function glidePatch<K extends keyof Glide>(k: K) {
  return (x: Moment, v: Glide[K]) => ({ glide: { ...x.glide, [k]: v } });
}

export function GlideFields({ m, piece }: { m: Moment; piece: Piece }) {
  const g: Glide = { ...piece.defaults.glide, ...m.glide };
  const length = fieldSetter<number>(m.id, 'Edit glide length', glidePatch('length'));
  const stagger = fieldSetter<number>(m.id, 'Edit stagger', glidePatch('stagger'));
  const jitter = fieldSetter<number>(m.id, 'Edit jitter', glidePatch('jitter'));
  const bz = typeof g.ease === 'object' ? g.ease : null;
  const curve: EaseName = bz ? 'bezier' : (g.ease as EaseName);
  // Smoothstep has no chip of its own (§11.3); show one only while it is the curve.
  const curves: readonly (readonly [EaseName, string])[] =
    curve === 'smoothstep'
      ? [...CURVES.slice(0, 1), ['smoothstep', 'Smoothstep'], ...CURVES.slice(1)]
      : CURVES;
  return (
    <fieldset className="insp-group" data-testid="insp-transition">
      <legend>
        Transition
        {m.glide && (
          <button
            type="button"
            className="link"
            onClick={() => updateMoment(m.id, { glide: undefined }, 'Reset glide')}
          >
            use defaults
          </button>
        )}
      </legend>
      <NumberField
        label="Length"
        unit="s"
        value={g.length}
        set={length}
        min={0}
        max={120}
        step={0.1}
        slider={{ min: 0, max: 20 }}
        testId="insp-glide-length"
      />
      <NumberField
        label="Stagger"
        unit="s"
        value={g.stagger}
        set={stagger}
        min={0}
        max={60}
        step={0.05}
        slider={{ min: 0, max: 5 }}
        testId="insp-glide-stagger"
      />
      <Slider
        label="Jitter"
        value={g.jitter}
        set={jitter}
        min={0}
        max={1}
        step={0.01}
        testId="insp-glide-jitter"
      />
      <CheckField
        label="Arrive together"
        checked={g.arrive !== 'spread'}
        testId="insp-arrive"
        onChange={(on) =>
          updateMoment(
            m.id,
            { glide: arriveGlide(m.glide, piece.defaults.glide.arrive, on) },
            on ? 'Arrive together' : 'Arrive spread',
          )
        }
      />
      <Chips
        legend="Order"
        options={ORDERS}
        pressed={(v) => v === g.order}
        onPick={(order) =>
          order !== g.order && updateMoment(m.id, { glide: { ...m.glide, order } }, 'Change order')
        }
      />
      <Chips
        legend="Curve"
        options={curves}
        pressed={(v) => v === curve}
        onPick={(v) =>
          v !== curve &&
          updateMoment(
            m.id,
            { glide: { ...m.glide, ease: v === 'bezier' ? DEFAULT_BEZIER : v } },
            'Change curve',
          )
        }
      />
      <Row label="Preview" className="insp-preview">
        <EasePreview ease={g.ease} />
      </Row>
      {bz && <BezierFields m={m} piece={piece} bz={bz} />}
    </fieldset>
  );
}

const DEFAULT_BEZIER = { kind: 'bezier' as const, x1: 0.42, y1: 0, x2: 0.58, y2: 1 };

function BezierFields({ m, piece, bz }: { m: Moment; piece: Piece; bz: Extract<EaseRef, object> }) {
  const patch = (k: 'x1' | 'y1' | 'x2' | 'y2') => (x: Moment, v: number) => {
    const cur = { ...piece.defaults.glide, ...x.glide }.ease;
    const base = typeof cur === 'object' ? cur : DEFAULT_BEZIER;
    return { glide: { ...x.glide, ease: { ...base, [k]: v } } };
  };
  const x1 = fieldSetter<number>(m.id, 'Edit curve', patch('x1'));
  const y1 = fieldSetter<number>(m.id, 'Edit curve', patch('y1'));
  const x2 = fieldSetter<number>(m.id, 'Edit curve', patch('x2'));
  const y2 = fieldSetter<number>(m.id, 'Edit curve', patch('y2'));
  return (
    <div className="insp-bezier">
      <NumberField label="x1" value={bz.x1} set={x1} min={0} max={1} step={0.01} />
      <NumberField label="y1" value={bz.y1} set={y1} min={-2} max={3} step={0.01} />
      <NumberField label="x2" value={bz.x2} set={x2} min={0} max={1} step={0.01} />
      <NumberField label="y2" value={bz.y2} set={y2} min={-2} max={3} step={0.01} />
    </div>
  );
}

function EasePreview({ ease }: { ease: EaseRef }) {
  const w = 120;
  const h = 40;
  const name = typeof ease === 'object' ? 'bézier' : ease;
  return (
    <svg
      className="ease-preview"
      viewBox={`-2 -2 ${w + 4} ${h + 4}`}
      width={w + 4}
      height={h + 4}
      role="img"
      aria-label={`${name} easing curve`}
    >
      <rect x="0" y="0" width={w} height={h} className="frame" />
      <path d={easePath(ease, w, h)} className="curve" />
    </svg>
  );
}

export function SeedField({ m, piece }: { m: Moment; piece: Piece }) {
  const effective = momentSeed(piece.seed, m.id, m.seed);
  // A frozen walk draws nothing, so its seed does nothing (§6.2).
  const frozen = m.type === 'walk' && m.fixed !== undefined;
  return (
    <Row label="Seed">
      <span
        className="insp-seed"
        data-testid="insp-seed"
        title={
          m.seed === undefined ? 'Derived from the piece seed and the moment id' : 'Explicit seed'
        }
      >
        {effective}
        {m.seed === undefined && <span className="dim"> (derived)</span>}
      </span>
      <button
        type="button"
        data-testid="insp-reroll"
        disabled={frozen}
        title={frozen ? 'Unfreeze to change' : undefined}
        onClick={() => reroll(m.id)}
      >
        Reroll
      </button>
    </Row>
  );
}
