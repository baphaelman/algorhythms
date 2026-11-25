/**
 * The Colours group's background controls (PLAN.md §15 M14 "Backgrounds"), in the Look grid:
 * - `GradientFields`: the gradient's shape (Linear | Radial), its angle or centre and radius,
 *   and its stops (a colour and a position each; add, remove, at least two);
 * - `PictureFields` (posters): pick any image, its fit (Cover | Contain | Tile), position and
 *   dimming. The picture lives in the piece's poster (saved files, not share links).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { setPictureImage } from '../../render/background';
import { patchPicture, setPicture } from '../../render/poster-edit';
import type { ThemeTokens } from '../../render/types';
import type { PictureFit } from '../../core/types';
import {
  GRADIENT_SHAPES,
  MAX_STOPS,
  MIN_STOPS,
  RADIUS_MAX,
  RADIUS_MIN,
  addStop,
  gradientAngle,
  gradientShape,
  gradientStops,
  removeStop,
  withAngle,
  withShape,
  withStop,
  type ColoursForm,
} from '../export-colours';
import { editPosterDoc } from '../poster-edits';
import { ensurePicture, pictureFromFile } from '../poster-picture';
import { usePlayer } from '../store';
import { Segs, Swatch } from './ColoursGroup';

/** A slider in the Look grid with its value beside it. */
function Slider({
  label,
  testId,
  min,
  max,
  step = 1,
  value,
  text,
  onChange,
}: {
  label: string;
  testId: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  text: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={text}
          data-testid={testId}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id} data-testid={`${testId}-value`}>
          {text}
        </output>
      </div>
    </>
  );
}

const pct = (v: number): string => `${Math.round(v * 100)} %`;

export function GradientFields({
  c,
  t,
  set,
}: {
  c: ColoursForm;
  t: ThemeTokens;
  set: (p: Partial<ColoursForm>) => void;
}) {
  const shape = gradientShape(c);
  const stops = gradientStops(c, t);
  return (
    <>
      <Segs
        label="Shape"
        testId="bg-shape"
        value={shape}
        options={GRADIENT_SHAPES}
        onChange={(s) => set(withShape(c, s))}
      />
      {shape === 'linear' ? (
        <Slider
          label="Angle"
          testId="bg-angle"
          min={0}
          max={359}
          value={gradientAngle(c)}
          text={`${gradientAngle(c)}°`}
          onChange={(a) => set(withAngle(a))}
        />
      ) : (
        <>
          <Slider
            label="Centre across"
            testId="bg-cx"
            min={0}
            max={100}
            value={Math.round(c.bgCx * 100)}
            text={pct(c.bgCx)}
            onChange={(v) => set({ bgCx: v / 100 })}
          />
          <Slider
            label="Centre down"
            testId="bg-cy"
            min={0}
            max={100}
            value={Math.round(c.bgCy * 100)}
            text={pct(c.bgCy)}
            onChange={(v) => set({ bgCy: v / 100 })}
          />
          <Slider
            label="Radius"
            testId="bg-r"
            min={Math.round(RADIUS_MIN * 100)}
            max={Math.round(RADIUS_MAX * 100)}
            value={Math.round(c.bgR * 100)}
            text={pct(c.bgR)}
            onChange={(v) => set({ bgR: v / 100 })}
          />
        </>
      )}
      {stops.map((s, i) => (
        <StopRows
          key={i}
          i={i}
          color={s.color}
          at={s.at}
          removable={stops.length > MIN_STOPS}
          onColor={(color) => set(withStop(c, t, i, { color }))}
          onAt={(at) => set(withStop(c, t, i, { at }))}
          onRemove={() => set(removeStop(c, t, i))}
        />
      ))}
      <span />
      <div className="field-row">
        <button
          type="button"
          disabled={stops.length >= MAX_STOPS}
          data-testid="bg-stop-add"
          onClick={() => set(addStop(c, t))}
        >
          Add stop
        </button>
      </div>
    </>
  );
}

/** One stop: its colour (swatch + hex) and its position, with Remove. */
function StopRows({
  i,
  color,
  at,
  removable,
  onColor,
  onAt,
  onRemove,
}: {
  i: number;
  color: string;
  at: number;
  removable: boolean;
  onColor: (hex: string) => void;
  onAt: (at: number) => void;
  onRemove: () => void;
}) {
  const id = useId();
  return (
    <>
      <Swatch
        label={`Stop ${i + 1}`}
        testId={`bg-stop-${i}`}
        value={color}
        set={false}
        onChange={(hex) => {
          if (hex) onColor(hex);
        }}
      />
      <label htmlFor={id}>Position</label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          value={Math.round(at * 100)}
          aria-valuetext={pct(at)}
          aria-label={`Stop ${i + 1} position`}
          data-testid={`bg-stop-${i}-at`}
          onChange={(e) => onAt(Number(e.target.value) / 100)}
        />
        <output htmlFor={id}>{pct(at)}</output>
        {removable && (
          <button
            type="button"
            className="swatch-reset"
            aria-label={`Remove stop ${i + 1}`}
            data-testid={`bg-stop-${i}-remove`}
            onClick={onRemove}
          >
            Remove
          </button>
        )}
      </div>
    </>
  );
}

const FITS: readonly { id: PictureFit; label: string }[] = [
  { id: 'cover', label: 'Cover' },
  { id: 'contain', label: 'Contain' },
  { id: 'tile', label: 'Tile' },
];

/** The poster's background picture: pick, fit, position, dimming, remove. */
export function PictureFields() {
  const picture = usePlayer((s) => s.piece.poster?.picture);
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const src = picture?.src;
  // A picture opened with the piece is decoded for the artboard.
  useEffect(() => {
    if (src) void ensurePicture(src);
  }, [src]);
  const pick = async (f: File) => {
    setError('');
    setBusy(true);
    try {
      const p = await pictureFromFile(f);
      const old = usePlayer.getState().piece.poster?.picture?.src;
      editPosterDoc(
        (d) => setPicture(d, { ...p, ...(old ? keepPlace(d?.picture) : {}) }),
        'Background picture',
      );
      if (old && old !== p.src) setPictureImage(old, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const patch = (key: string, p: Parameters<typeof patchPicture>[1]) =>
    editPosterDoc((d) => patchPicture(d, p), 'Background picture', `picture:${key}`);
  return (
    <>
      <span className="look-label">Picture</span>
      <div className="field-row" data-testid="bg-picture" data-set={picture ? 'yes' : 'no'}>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          data-testid="bg-picture-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void pick(f);
          }}
        />
        <button
          type="button"
          disabled={busy}
          data-testid="bg-picture-pick"
          onClick={() => file.current?.click()}
        >
          {busy ? 'Opening…' : picture ? 'Change…' : 'Choose…'}
        </button>
        {picture && (
          <button
            type="button"
            className="swatch-reset"
            data-testid="bg-picture-remove"
            onClick={() => editPosterDoc((d) => setPicture(d, undefined), 'Background picture')}
          >
            Remove
          </button>
        )}
        {picture && (
          <small className="swatch-hint">
            {picture.w} × {picture.h} · saved with the piece, not in links
          </small>
        )}
      </div>
      {error && (
        <small className="look-note field-error" role="status" data-testid="bg-picture-error">
          {error}
        </small>
      )}
      {picture && (
        <>
          <Segs
            label="Fit"
            testId="bg-picture-fit"
            value={picture.fit ?? 'cover'}
            options={FITS}
            onChange={(fit) => patch('fit', { fit })}
          />
          <Slider
            label="Across"
            testId="bg-picture-x"
            min={0}
            max={100}
            value={Math.round((picture.x ?? 0.5) * 100)}
            text={pct(picture.x ?? 0.5)}
            onChange={(v) => patch('x', { x: v / 100 })}
          />
          <Slider
            label="Down"
            testId="bg-picture-y"
            min={0}
            max={100}
            value={Math.round((picture.y ?? 0.5) * 100)}
            text={pct(picture.y ?? 0.5)}
            onChange={(v) => patch('y', { y: v / 100 })}
          />
          <Slider
            label="Dimming"
            testId="bg-picture-dim"
            min={0}
            max={100}
            value={Math.round((picture.dim ?? 0) * 100)}
            text={pct(picture.dim ?? 0)}
            onChange={(v) => patch('dim', { dim: v / 100 })}
          />
        </>
      )}
    </>
  );
}

/** A replaced picture keeps the old one's fit, position and dimming. */
function keepPlace(p: { fit?: PictureFit; x?: number; y?: number; dim?: number } | undefined) {
  if (!p) return {};
  const out: { fit?: PictureFit; x?: number; y?: number; dim?: number } = {};
  if (p.fit) out.fit = p.fit;
  if (p.x !== undefined) out.x = p.x;
  if (p.y !== undefined) out.y = p.y;
  if (p.dim !== undefined) out.dim = p.dim;
  return out;
}
