/**
 * The texture inspector (PLAN.md §6.4, M10b-4): for walk and pulse moments, Hold / Wander /
 * Arpeggio / Pulse and the block's length; the detailed walk or pulse fields sit under More.
 * Hold deletes the block (a gap holds the chords).
 */

import type { Piece, PulseMoment, WalkMoment } from '../../../core/types';
import { setTextureOf } from '../../editor/chord-block';
import { textureOf, type TextureChoice } from '../../editor/rows';
import { Chips, NumberField, fieldSetter } from './controls';
import { PulseFields } from './PulseFields';
import { WalkFields } from './TypeFields';

const TEXTURES: readonly (readonly [TextureChoice, string])[] = [
  ['hold', 'Hold'],
  ['wander', 'Wander'],
  ['arpeggio', 'Arpeggio'],
  ['pulse', 'Pulse'],
];

const HINTS: Record<TextureChoice, string> = {
  hold: 'The chords just hold (removes this block)',
  wander: 'Lines step around the chord tones',
  arpeggio: 'One line at a time, up and down, each bar',
  pulse: 'All lines together, in a rhythm',
};

const round6 = (t: number): number => Math.round(t * 1e6) / 1e6;

export function TextureFields({ m, piece }: { m: WalkMoment | PulseMoment; piece: Piece }) {
  const kind = textureOf(m);
  const len = m.until - m.at;
  const length = fieldSetter<number>(m.id, 'Edit texture length', (x, v) => ({
    until: round6(x.at + v),
  }));
  return (
    <>
      <Chips
        legend="Texture"
        className="insp-seg"
        testId="insp-texture"
        options={TEXTURES}
        hint={(v) => HINTS[v]}
        pressed={(v) => v === kind}
        onPick={(v) => v !== kind && setTextureOf(m.id, v)}
      />
      <NumberField
        label="Length"
        unit="s"
        value={len}
        set={length}
        min={0.05}
        step={0.5}
        slider={{ min: 1, max: Math.max(30, Math.ceil(len / 10) * 10) }}
        // Today's testids, so the region field keeps its name.
        testId={m.type === 'walk' ? 'insp-walk-region' : 'insp-pulse-region'}
      />
      {/* Open when a frozen walk has its badge and Unfreeze there. */}
      <details
        className="insp-advanced"
        data-testid="insp-texture-more"
        open={m.type === 'walk' && m.fixed !== undefined}
      >
        <summary>More</summary>
        {m.type === 'walk' ? (
          <WalkFields m={m} piece={piece} region={false} />
        ) : (
          <PulseFields m={m} piece={piece} region={false} />
        )}
      </details>
    </>
  );
}
