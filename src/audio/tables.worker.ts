/**
 * Wavetable worker (PLAN.md §8.11): builds a timbre's band-limited mip tables off the main and
 * audio threads and transfers them back. Started by tables.ts as a module worker.
 */

import type { Timbre } from '../core/types';
import { buildWavetables, wavetableTransferList } from '../dsp/wavetable';

/** Request: build tables for `timbre` at `sampleRate`. */
export interface TablesRequest {
  id: number;
  timbre: Timbre;
  sampleRate: number;
}

self.onmessage = (event: MessageEvent<TablesRequest>) => {
  const { id, timbre, sampleRate } = event.data;
  try {
    const set = buildWavetables(timbre, sampleRate);
    self.postMessage({ id, set }, { transfer: wavetableTransferList(set) });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
