/** Fields common to every moment (§6.1): target voices, glide (with a curve preview) and seed. */

import { momentSeed } from '../../../core/rng';
import type { EaseRef, Glide, GlideOrder, Moment, Piece, VoiceSelector } from '../../../core/types';
import { reroll, updateMoment } from '../../editor/actions';
import { NumberField, Row, SelectField, Slider, fieldSetter } from './controls';
import { easePath } from './fields';

type TargetMode = 'all' | 'voices' | 'rank';

function modeOf(t: VoiceSelector | undefined): TargetMode {
  if (!t || t === 'all') return 'all';
  return 'voices' in t ? 'voices' : 'rank';
}

export function TargetField({ m, piece }: { m: Moment; piece: Piece }) {
  const target = m.target;
  const mode = modeOf(target);
  const n = piece.voices.length;
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
  return (
    <>
      <SelectField<TargetMode>
        label="Voices"
        value={mode}
        testId="insp-target"
        options={[
          ['all', 'All active voices'],
          ['voices', 'Chosen voices'],
          ['rank', 'By pitch rank'],
        ]}
        onChange={(v) => {
          const next: VoiceSelector | undefined =
            v === 'all'
              ? undefined
              : v === 'voices'
                ? { voices: piece.voices.map((x) => x.id) }
                : { rank: [0, Math.max(0, n - 1)] };
          updateMoment(m.id, { target: next }, 'Change target');
        }}
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
      {target && target !== 'all' && 'rank' in target && (
        <>
          <NumberField
            label="Lowest rank"
            value={target.rank[0]}
            set={rankLo}
            integer
            step={1}
            min={0}
            max={Math.max(0, n - 1)}
            format={(v) => String(v + 1)}
            parse={(t) => (/^\d+$/.test(t.trim()) ? Number(t) - 1 : null)}
          />
          <NumberField
            label="Highest rank"
            value={target.rank[1]}
            set={rankHi}
            integer
            step={1}
            min={0}
            max={Math.max(0, n - 1)}
            format={(v) => String(v + 1)}
            parse={(t) => (/^\d+$/.test(t.trim()) ? Number(t) - 1 : null)}
          />
        </>
      )}
    </>
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
const EASES: readonly (readonly [EaseName, string])[] = [
  ['smootherstep', 'Smootherstep'],
  ['smoothstep', 'Smoothstep'],
  ['cosine', 'Cosine'],
  ['linear', 'Linear'],
  ['expo', 'Exponential'],
  ['bezier', 'Bézier…'],
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
  return (
    <fieldset className="insp-group">
      <legend>
        Glide
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
        testId="insp-glide-length"
      />
      <NumberField
        label="Stagger"
        unit="s"
        value={g.stagger}
        set={stagger}
        min={0}
        max={60}
        step={0.1}
      />
      <Slider label="Jitter" value={g.jitter} set={jitter} min={0} max={1} step={0.01} />
      <SelectField
        label="Order"
        value={g.order}
        options={ORDERS}
        onChange={(order) => updateMoment(m.id, { glide: { ...m.glide, order } }, 'Change order')}
      />
      <SelectField<EaseName>
        label="Ease"
        value={bz ? 'bezier' : (g.ease as EaseName)}
        options={EASES}
        onChange={(v) =>
          updateMoment(
            m.id,
            { glide: { ...m.glide, ease: v === 'bezier' ? DEFAULT_BEZIER : v } },
            'Change ease',
          )
        }
      />
      {bz && <BezierFields m={m} piece={piece} bz={bz} />}
      <Row label="Curve">
        <EasePreview ease={g.ease} />
      </Row>
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
      <button type="button" data-testid="insp-reroll" onClick={() => reroll(m.id)}>
        Reroll
      </button>
    </Row>
  );
}
