/**
 * Main-thread client of the wavetable worker (PLAN.md §8.11). Falls back to building on the
 * calling thread where module workers are unavailable. Each result is a fresh set that may be
 * transferred to the worklet.
 */

import type { Timbre } from '../core/types';
import { buildWavetables, type WavetableSet } from '../dsp/wavetable';
import type { TablesRequest } from './tables.worker';

interface Pending {
  resolve: (set: WavetableSet) => void;
  reject: (error: Error) => void;
}

export class TableBuilder {
  private worker: Worker | null = null;
  private failed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** Builds the tables of `timbre` at `sampleRate` (in the worker when possible). */
  build(timbre: Timbre, sampleRate: number): Promise<WavetableSet> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(buildWavetables(timbre, sampleRate));
    const id = this.nextId++;
    return new Promise<WavetableSet>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: TablesRequest = { id, timbre, sampleRate };
      worker.postMessage(req);
    });
  }

  /** Stops the worker. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('table builder disposed'));
    this.pending.clear();
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    if (typeof Worker === 'undefined') {
      this.failed = true;
      return null;
    }
    try {
      const w = new Worker(new URL('./tables.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; set?: WavetableSet; error?: string }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.set) p.resolve(e.data.set);
        else p.reject(new Error(e.data.error ?? 'table build failed'));
      };
      w.onerror = () => {
        // A worker that cannot start: build the outstanding requests here instead.
        this.failed = true;
        this.worker = null;
        w.terminate();
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(new Error('table worker failed'));
        }
      };
      this.worker = w;
    } catch {
      this.failed = true;
    }
    return this.worker;
  }
}
