/**
 * The live inputs' meeting point (PLAN.md §9): musical typing, the piano ruler and Web MIDI press
 * and release notes here, per source. A pitch is held while any source holds it, so the engine
 * sees one note on and one note off per pitch. Notes pressed while live mode is still starting
 * are sent once it runs (`resync`), and a source can release everything it holds (window blur,
 * pointer cancel, a MIDI port gone).
 */

import type { Pitch } from '../core/types';

/** The part of `LiveEngine` the hub drives (a fake in tests). */
export interface LiveTarget {
  readonly active: boolean;
  noteOn(pitch: Pitch, velocity?: number): unknown;
  noteOff(pitch: Pitch): unknown;
}

export type LiveSource = 'keys' | 'ruler' | 'midi';

export class LiveInputHub {
  private readonly bySource = new Map<LiveSource, Map<Pitch, number>>();
  private readonly count = new Map<Pitch, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly target: LiveTarget) {}

  /** `source` presses `pitch` (velocity 0..1). Repeats from the same source are ignored. */
  down(source: LiveSource, pitch: Pitch, velocity = 1): void {
    let mine = this.bySource.get(source);
    if (!mine) this.bySource.set(source, (mine = new Map()));
    if (mine.has(pitch)) return;
    mine.set(pitch, velocity);
    const c = (this.count.get(pitch) ?? 0) + 1;
    this.count.set(pitch, c);
    if (c === 1 && this.target.active) this.target.noteOn(pitch, velocity);
    this.changed();
  }

  /** `source` releases `pitch` (nothing if it did not hold it). */
  up(source: LiveSource, pitch: Pitch): void {
    const mine = this.bySource.get(source);
    if (!mine?.delete(pitch)) return;
    const c = (this.count.get(pitch) ?? 1) - 1;
    if (c > 0) this.count.set(pitch, c);
    else {
      this.count.delete(pitch);
      if (this.target.active) this.target.noteOff(pitch);
    }
    this.changed();
  }

  /** Releases every pitch `source` holds. */
  release(source: LiveSource): void {
    const mine = this.bySource.get(source);
    if (!mine) return;
    for (const p of [...mine.keys()]) this.up(source, p);
  }

  /** Releases everything (live mode ends). */
  releaseAll(): void {
    for (const s of [...this.bySource.keys()]) this.release(s);
  }

  /** Sends a note on for every held pitch (live mode just started running). */
  resync(): void {
    if (!this.target.active) return;
    const sent = new Set<Pitch>();
    for (const mine of this.bySource.values()) {
      for (const [p, v] of mine) {
        if (sent.has(p)) continue;
        sent.add(p);
        this.target.noteOn(p, v);
      }
    }
  }

  /** Whether `source` (or any source) holds `pitch`. */
  holds(pitch: Pitch, source?: LiveSource): boolean {
    return source ? (this.bySource.get(source)?.has(pitch) ?? false) : this.count.has(pitch);
  }

  /** Pitches held by any source, ascending. */
  get held(): Pitch[] {
    return [...this.count.keys()].sort((a, b) => a - b);
  }

  /** Calls `fn` after every change of the held pitches; returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
