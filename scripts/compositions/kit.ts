/**
 * Helpers for the second set of compositions (docs/composing.md §3), written the way the editor
 * makes them: chords as symbols or Roman numerals, tunes typed as in the inspector's text box
 * ("D5 1.5, B4 0.5": note names, lengths in beats), region moments (pulse, walk) doing the
 * repetitive work, and sections reused by copy and paste.
 */
import { parseTuneText } from '../../src/app/editor/tune';
import { momentSeed } from '../../src/core/rng';
import { Song, type Target } from './song';

type Json = Record<string, unknown>;

export class Kit extends Song {
  /** Bars as seconds: `bars(2)` is two bars long. */
  bars(n: number): number {
    return n * this.meter * this.beat;
  }

  /** A tune typed as in the inspector, from bar (and beat) on `target`. */
  say(target: Target, bar: number, text: string, fields: Json = {}, beat = 0): Json {
    const r = parseTuneText(text, this.beat);
    if (!r.ok) throw new Error(`${this.title} bar ${bar}: ${r.error}`);
    return this.m('tune', this.T(bar, beat), { target, notes: r.notes, ...fields });
  }

  /** A chord symbol or Roman numeral on `target` at bar (and beat). */
  chord(target: Target, bar: number, symbol: string, fields: Json = {}, beat = 0): Json {
    return this.m('chord', this.T(bar, beat), {
      target,
      notes: { kind: 'chord', symbol },
      ...fields,
    });
  }

  /** One chord per `per` beats from bar0: a progression on one part. */
  prog(target: Target, bar0: number, symbols: string, fields: Json = {}, per = this.meter): void {
    symbols
      .split(/[\s|]+/)
      .filter((s) => s !== '')
      .forEach((sym, i) => {
        if (sym !== '-') this.chord(target, bar0, sym, fields, i * per);
      });
  }

  /**
   * Copy and paste: every moment starting in bars [from, to) again, `to - from` bars later or at
   * bar `at`. Copies keep the original's effective seed, as the editor's Duplicate does.
   */
  paste(from: number, to: number, at: number): void {
    const [a, b, dt] = [this.T(from), this.T(to), this.T(at) - this.T(from)];
    const src = this.moments.filter(
      (m) => (m.at as number) >= a - 1e-9 && (m.at as number) < b - 1e-9,
    );
    for (const m of src) {
      const { seedFrom, ...rest } = m;
      const copy = structuredClone(rest) as Json;
      copy.id = '';
      copy.at = Math.round(((m.at as number) + dt) * 1e3) / 1e3;
      if (typeof copy.until === 'number') copy.until = Math.round((copy.until + dt) * 1e3) / 1e3;
      delete copy.label;
      if (m.type === 'walk' || m.type === 'chord') copy.seedFrom = seedFrom ?? m;
      this.moments.push(copy);
    }
  }

  toJson(): Json {
    const j = super.toJson();
    for (const m of j.moments as Json[]) {
      const src = m.seedFrom as Json | undefined;
      if (!src) continue;
      delete m.seedFrom;
      m.seed = (src.seed as number | undefined) ?? momentSeed(this.seed, src.id as string);
    }
    return j;
  }
}
