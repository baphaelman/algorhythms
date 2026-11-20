/**
 * Hidden fixture page (fixtures.html, not linked from the site) for M2 listening tests: play each
 * DSP fixture live through the engine worklet, stress seek, loop and hot-swap, and download WAV
 * exports. Plain DOM, no React. It also exposes `window.__fixtures` for the e2e tests.
 */

import type { CompiledScore, MixSettings } from '../../core/types';
import { AudioEngine, ENGINE_PROCESSOR, engineWorkletUrl } from '../engine';
import { exportWav } from '../export-client';
import { parseWavHeader, type WavBitDepth } from '../wav';
import { stemsHook, type StemsHook } from './stems-hook';
import {
  DRY_MIX,
  FIXTURE_MIX,
  FIXTURE_NAMES,
  fixtureScore,
  swapPair,
  type FixtureName,
} from './scores';

type Name = FixtureName | 'swap-pair';
const NAMES: Name[] = [...FIXTURE_NAMES, 'swap-pair'];

function scoreOf(name: Name): CompiledScore {
  return name === 'swap-pair' ? swapPair(3).a : fixtureScore(name);
}

/** What the e2e tests can reach. */
export interface FixturesHook {
  workletUrl: string;
  processorName: string;
  names: string[];
  /** Renders a fixture through the real worklet in an OfflineAudioContext. */
  renderOffline(
    name: string,
    seconds: number,
    sampleRate?: number,
  ): Promise<{ left: number[]; right: number[]; sampleRate: number }>;
  /** Exports a fixture as WAV in the export worker; returns header facts and a decode check. */
  exportCheck(
    name: string,
    bitDepth: WavBitDepth,
    sampleRate: 44100 | 48000,
  ): Promise<{
    bytes: number;
    header: ReturnType<typeof parseWavHeader>;
    decodedSeconds: number;
    decodedChannels: number;
    decodedPeak: number;
    progress: number[];
  }>;
  /** Stems export in the real worker (tests/e2e/stems.spec.ts). */
  stems: StemsHook;
  /** The live engine while playing (null when stopped). */
  engine: AudioEngine | null;
  /** An analyser on the live engine's output. */
  analyser: AnalyserNode | null;
}

declare global {
  interface Window {
    __fixtures?: FixturesHook;
  }
}

const root = document.getElementById('fixtures') as HTMLElement;
root.innerHTML = `
  <style>
    body { font: 15px/1.45 system-ui, sans-serif; margin: 0; background: #f6f5f1; color: #1d1c1a; }
    main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    p.note { color: #5d5a54; margin: 0 0 20px; }
    fieldset { border: 1px solid #d6d3cc; border-radius: 8px; margin: 0 0 16px; padding: 12px 14px; }
    legend { font-weight: 600; padding: 0 6px; }
    button, select { font: inherit; margin: 4px 6px 4px 0; padding: 6px 12px; border-radius: 6px;
      border: 1px solid #b9b5ac; background: #fff; color: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    output { font-variant-numeric: tabular-nums; }
    .meter { height: 8px; background: #e3e0d8; border-radius: 4px; overflow: hidden; margin-top: 8px; }
    .meter > div { height: 100%; width: 0; background: #2f6f5e; }
    @media (prefers-color-scheme: dark) {
      body { background: #171716; color: #e9e6df; }
      button, select { background: #262523; border-color: #4a4843; }
      fieldset { border-color: #3a3835; }
      p.note { color: #a29e95; }
      .meter { background: #2e2d2a; }
    }
  </style>
  <h1>AlgoRhythms sound fixtures</h1>
  <p class="note">Internal listening page for the M2 sound engine. Not linked from the site.</p>
  <fieldset>
    <legend>Fixture</legend>
    <select id="name" aria-label="Fixture"></select>
    <label><input type="checkbox" id="dry" /> dry (no FX)</label>
    <div>
      <button id="play">Play</button>
      <button id="stop" disabled>Stop</button>
      <output id="time">0.00 s</output> · <output id="state">stopped</output>
    </div>
    <div class="meter" aria-hidden="true"><div id="meter"></div></div>
  </fieldset>
  <fieldset>
    <legend>Stress</legend>
    <button id="back">−2 s</button>
    <button id="fwd">+2 s</button>
    <button id="scrub">Scrub burst (20 seeks)</button>
    <button id="loop">Loop 2–4.5 s</button>
    <button id="swap">Hot-swap (swap-pair: A ↔ B)</button>
  </fieldset>
  <fieldset>
    <legend>Export WAV</legend>
    <select id="bits" aria-label="Bit depth">
      <option value="16">16-bit (TPDF dither)</option>
      <option value="24" selected>24-bit</option>
      <option value="32">32-bit float</option>
    </select>
    <select id="rate" aria-label="Sample rate">
      <option value="48000">48 kHz</option>
      <option value="44100">44.1 kHz</option>
    </select>
    <button id="export">Download</button>
    <button id="cancel" disabled>Cancel</button>
    <output id="progress"></output>
  </fieldset>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nameSel = $<HTMLSelectElement>('name');
for (const n of NAMES) nameSel.add(new Option(n, n));
const status = $<HTMLOutputElement>('state');
const timeOut = $<HTMLOutputElement>('time');
const meterBar = $<HTMLDivElement>('meter');

const hook: FixturesHook = {
  workletUrl: engineWorkletUrl,
  processorName: ENGINE_PROCESSOR,
  names: NAMES,
  stems: stemsHook,
  engine: null,
  analyser: null,
  async renderOffline(name, seconds, sampleRate = 48000) {
    const ctx = new OfflineAudioContext({
      numberOfChannels: 2,
      length: Math.round(seconds * sampleRate),
      sampleRate,
    });
    await AudioEngine.create({
      context: ctx,
      preload: { score: scoreOf(name as Name), mix: FIXTURE_MIX, playFrom: 0 },
    });
    const buf = await ctx.startRendering();
    return {
      left: Array.from(buf.getChannelData(0)),
      right: Array.from(buf.getChannelData(1)),
      sampleRate,
    };
  },
  async exportCheck(name, bitDepth, sampleRate) {
    const progress: number[] = [];
    const blob = await exportWav({
      score: scoreOf(name as Name),
      mix: FIXTURE_MIX,
      sampleRate,
      bitDepth,
      onProgress: (f) => progress.push(f),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const header = parseWavHeader(bytes);
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate });
    const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
    let peak = 0;
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const d = decoded.getChannelData(c);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    return {
      bytes: bytes.byteLength,
      header,
      decodedSeconds: decoded.duration,
      decodedChannels: decoded.numberOfChannels,
      decodedPeak: peak,
      progress,
    };
  },
};
window.__fixtures = hook;

let engine: AudioEngine | null = null;
let swapped = false;
let looping = false;
let raf = 0;

function mixOf(): MixSettings {
  return $<HTMLInputElement>('dry').checked ? DRY_MIX : FIXTURE_MIX;
}

function setPlaying(on: boolean): void {
  $<HTMLButtonElement>('play').disabled = on;
  $<HTMLButtonElement>('stop').disabled = !on;
  status.textContent = on ? 'playing' : 'stopped';
}

function tick(): void {
  if (engine) timeOut.textContent = `${engine.currentTime().toFixed(2)} s`;
  raf = requestAnimationFrame(tick);
}

$<HTMLButtonElement>('play').onclick = async () => {
  // Create the context inside the click for Safari's autoplay rules.
  const context = new AudioContext({ latencyHint: 'playback' });
  void context.resume();
  setPlaying(true);
  status.textContent = 'starting…';
  try {
    const e = await AudioEngine.create({ context });
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    e.node.connect(analyser);
    e.onMeter = (m) =>
      (meterBar.style.width = `${Math.min(100, Math.max(m.peakL, m.peakR) * 100)}%`);
    e.onEnded = () => (status.textContent = 'ended');
    e.onError = (msg) => (status.textContent = `error: ${msg}`);
    await e.load(scoreOf(nameSel.value as Name), mixOf());
    swapped = false;
    looping = false;
    e.play(0);
    engine = e;
    hook.engine = e;
    hook.analyser = analyser;
    status.textContent = 'playing';
    cancelAnimationFrame(raf);
    tick();
  } catch (err) {
    status.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    setPlaying(false);
    void context.close();
  }
};

$<HTMLButtonElement>('stop').onclick = () => {
  const e = engine;
  engine = null;
  hook.engine = null;
  hook.analyser = null;
  setPlaying(false);
  cancelAnimationFrame(raf);
  if (!e) return;
  e.pause();
  window.setTimeout(() => void e.dispose(), 150);
};

$<HTMLButtonElement>('back').onclick = () => engine?.seek(Math.max(0, engine.currentTime() - 2));
$<HTMLButtonElement>('fwd').onclick = () => engine?.seek(engine.currentTime() + 2);
$<HTMLButtonElement>('scrub').onclick = () => {
  const e = engine;
  if (!e) return;
  const base = e.currentTime();
  for (let i = 0; i < 20; i++) window.setTimeout(() => e.seek(base + 1 + i * 0.07), i * 30);
};
$<HTMLButtonElement>('loop').onclick = () => {
  looping = !looping;
  engine?.loop(looping ? { start: 2, end: 4.5 } : null);
  $<HTMLButtonElement>('loop').textContent = looping ? 'Stop looping' : 'Loop 2–4.5 s';
};
$<HTMLButtonElement>('swap').onclick = () => {
  if (!engine) return;
  const pair = swapPair(3);
  swapped = !swapped;
  void engine.swap(swapped ? pair.b : pair.a);
};

let exportAbort: AbortController | null = null;
$<HTMLButtonElement>('export').onclick = async () => {
  const name = nameSel.value as Name;
  const bitDepth = Number($<HTMLSelectElement>('bits').value) as WavBitDepth;
  const sampleRate = Number($<HTMLSelectElement>('rate').value) as 44100 | 48000;
  const progress = $<HTMLOutputElement>('progress');
  exportAbort = new AbortController();
  $<HTMLButtonElement>('cancel').disabled = false;
  try {
    const blob = await exportWav({
      score: scoreOf(name),
      mix: mixOf(),
      sampleRate,
      bitDepth,
      signal: exportAbort.signal,
      onProgress: (f) => (progress.textContent = `${Math.round(f * 100)} %`),
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `algorhythms-${name}-${bitDepth}bit-${sampleRate / 1000}k.wav`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    progress.textContent = `done (${(blob.size / 1e6).toFixed(1)} MB)`;
  } catch (err) {
    progress.textContent =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'cancelled'
        : `error: ${String(err)}`;
  } finally {
    $<HTMLButtonElement>('cancel').disabled = true;
    exportAbort = null;
  }
};
$<HTMLButtonElement>('cancel').onclick = () => exportAbort?.abort();
