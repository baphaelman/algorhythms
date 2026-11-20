/**
 * Stems export hook for the e2e tests (`window.__fixtures.stems`): runs `exportStems` in the real
 * worker on a fixture (dense-24 stretched to any length), writing to a Blob, to OPFS (the same
 * `FileSystemFileHandle` path as showSaveFilePicker) or into a discarding stream, and reports what
 * the browser saw. Not used by the site.
 */

import type { StemsPlan } from '../stems';
import { exportStems } from '../stems-client';
import { FIXTURE_MIX, denseScore, fixtureScore, stressScore, type FixtureName } from './scores';
import type { WavBitDepth } from '../wav';

/** One run. */
export interface StemsRunOptions {
  /** A fixture name; 'dense-24' and 'stress' take `seconds`. */
  fixture: FixtureName;
  /** Only for dense-24 and stress: piece length (default: the fixture's 30 s). */
  seconds?: number;
  /** Stress only: 4 voices at 3× gain, so the limiter is working hard. */
  hot?: boolean;
  bitDepth?: WavBitDepth;
  mono?: boolean;
  sampleRate?: 44100 | 48000;
  /** Where the zip goes. */
  target: 'blob' | 'opfs' | 'null';
  /** Abort once progress passes this fraction. */
  cancelAt?: number;
  /** Blob target only: return the zip as base64 (small runs). */
  returnZip?: boolean;
}

/** What a run reports. */
export interface StemsRunResult {
  ok: boolean;
  /** 'AbortError' etc. when not ok. */
  error?: string;
  bytes?: number;
  entries?: string[];
  zip64?: boolean;
  plan?: StemsPlan;
  ms: number;
  progress: number[];
  /** OPFS target: size of the file on disk, and the entry count read from its end records. */
  fileBytes?: number;
  cdEntries?: number;
  firstEntryIsMixWav?: boolean;
  /** Blob target with returnZip. */
  zipBase64?: string;
}

/** Memory facts the page can read about itself. */
export interface StemsHook {
  run(o: StemsRunOptions): Promise<StemsRunResult>;
  /** performance.measureUserAgentSpecificMemory() bytes, or null when unavailable. */
  memory(): Promise<number | null>;
  crossOriginIsolated: boolean;
}

function scoreFor(o: StemsRunOptions) {
  if (o.fixture === 'dense-24' && o.seconds) return denseScore(24, o.seconds);
  if (o.fixture === 'stress' && o.seconds) {
    const score = stressScore(o.hot ? 4 : 12, o.seconds, 1, 9);
    if (o.hot) for (const v of score.voices) v.gain = 3;
    return score;
  }
  return fixtureScore(o.fixture);
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Reads the zip's end records from a file on disk (no ZIP64 needed for the checks here). */
async function inspect(file: File): Promise<{ cdEntries: number; firstEntryIsMixWav: boolean }> {
  const tail = new DataView(await file.slice(Math.max(0, file.size - 22)).arrayBuffer());
  const eocdOk = tail.getUint32(0, true) === 0x06054b50;
  const cdEntries = eocdOk ? tail.getUint16(10, true) : -1;
  const head = new Uint8Array(await file.slice(0, 30 + 7).arrayBuffer());
  const name = new TextDecoder().decode(head.subarray(30, 37));
  return { cdEntries, firstEntryIsMixWav: name === 'mix.wav' };
}

export const stemsHook: StemsHook = {
  crossOriginIsolated: self.crossOriginIsolated,
  async memory() {
    const p = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    if (!p.measureUserAgentSpecificMemory || !self.crossOriginIsolated) return null;
    try {
      return (await p.measureUserAgentSpecificMemory()).bytes;
    } catch {
      return null; // SecurityError in some headless configurations
    }
  },
  async run(o) {
    const t0 = performance.now();
    const progress: number[] = [];
    const ac = new AbortController();
    let plan: StemsPlan | undefined;
    let handle: FileSystemFileHandle | null = null;
    let dir: FileSystemDirectoryHandle | null = null;
    let target: WritableStream<Uint8Array<ArrayBuffer>> | FileSystemFileHandle | undefined;
    if (o.target === 'opfs') {
      dir = await navigator.storage.getDirectory();
      handle = await dir.getFileHandle('stems-test.zip', { create: true });
      target = handle;
    } else if (o.target === 'null') {
      target = new WritableStream<Uint8Array<ArrayBuffer>>();
    }
    try {
      const r = await exportStems(scoreFor(o), FIXTURE_MIX, {
        sampleRate: o.sampleRate ?? 48000,
        bitDepth: o.bitDepth ?? 32,
        mono: o.mono ?? false,
        target,
        signal: ac.signal,
        onPlan: (p) => (plan = p),
        onProgress: (p) => {
          progress.push(p.fraction);
          if (o.cancelAt !== undefined && p.fraction >= o.cancelAt) ac.abort();
        },
      });
      const res: StemsRunResult = {
        ok: true,
        bytes: r.bytes,
        entries: r.entries,
        zip64: r.zip64,
        plan,
        ms: performance.now() - t0,
        progress,
      };
      if (handle) {
        const file = await handle.getFile();
        res.fileBytes = file.size;
        Object.assign(res, await inspect(file));
      }
      if (r.blob && o.returnZip) res.zipBase64 = base64(new Uint8Array(await r.blob.arrayBuffer()));
      if (r.blob) res.fileBytes = r.blob.size;
      return res;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.name : String(e),
        plan,
        ms: performance.now() - t0,
        progress,
      };
    } finally {
      if (dir && handle) await dir.removeEntry('stems-test.zip').catch(() => undefined);
    }
  },
};
