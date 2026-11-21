/**
 * Compares the rewritten compositions with earlier versions, by numbers (docs/composing.md §1):
 * pitch lines every 50 ms, the pad's dry 10 ms RMS envelope (the pulse rhythm), loudness above
 * 150 Hz, and the click detector of tests/dsp. Writes before/after WAVs to `outDir`.
 * Launched by compare.mjs: `node scripts/compositions/compare.mjs <old-dir> <out-dir>`.
 * Env switches: LINK_ONLY (share links only), SKIP_ENV (no pad envelope), WINDOWS (every 4 s
 * window), PART_WINDOWS (4 s windows per part, dry), DUMP=voice,from,to (pitch samples).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportFrameCount, renderOffline } from '../../src/audio/offline';
import { WavEncoder, wavHeader } from '../../src/audio/wav';
import { compile } from '../../src/core/compiler/compile';
import {
  DEFAULT_GLIDE,
  DEFAULT_MIX,
  DEFAULT_VIEW,
  MOMENT_DEFAULTS,
  defaultVoice,
} from '../../src/core/defaults';
import { pitchAt } from '../../src/core/query';
import { parsePiece } from '../../src/core/schema';
import type { CompiledScore, Piece } from '../../src/core/types';
import { encodeShareLink } from '../../src/app/share';
import { clickScore } from '../../tests/dsp/helpers';

const RATE = 48000;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Removes fields equal to `def` (recursively); objects left empty go too. */
function stripLike(
  v: Record<string, unknown>,
  def: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const d = def[k];
    if (d !== undefined && same(x, d)) continue;
    if (
      d &&
      typeof d === 'object' &&
      !Array.isArray(d) &&
      x &&
      typeof x === 'object' &&
      !Array.isArray(x)
    ) {
      const s = stripLike(x as Record<string, unknown>, d as Record<string, unknown>);
      if (Object.keys(s).length > 0) out[k] = s;
    } else out[k] = x;
  }
  return out;
}

/**
 * An estimate of M5's share-link default stripping (PLAN §11.4, not built yet): fields equal to
 * their defaults go (piece, mix, view, voices, moment fields).
 */
export function stripDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const p = stripLike(raw, {
    tuning: { referenceHz: 440, system: { kind: '12tet' } },
    defaults: { glide: DEFAULT_GLIDE },
    mix: DEFAULT_MIX,
    view: DEFAULT_VIEW,
  } as unknown as Record<string, unknown>);
  p.voices = (raw.voices as Record<string, unknown>[]).map((v, i) => {
    const s = stripLike(v, defaultVoice(i) as unknown as Record<string, unknown>);
    return { id: v.id, ...s };
  });
  p.moments = (raw.moments as Record<string, unknown>[]).map((m) => {
    const d = MOMENT_DEFAULTS[m.type as keyof typeof MOMENT_DEFAULTS] as Record<string, unknown>;
    const s = stripLike(m, d);
    return { id: m.id, type: m.type, at: m.at, ...s };
  });
  return p;
}
const SITE = 'https://baphaelman.github.io/algorhythms/';

function load(path: string): Piece {
  const r = parsePiece(readFileSync(path, 'utf8'));
  if (!r.ok) throw new Error(`${path}: ${r.errors.join('; ')}`);
  return r.piece;
}

function render(piece: Piece, score: CompiledScore, frames: number): Float32Array[] {
  const { left, right } = renderOffline(
    { score, mix: piece.mix, timbres: piece.timbres, sampleRate: RATE },
    frames,
  );
  return [left, right];
}

function writeWav(file: string, [l, r]: Float32Array[], seed: number): void {
  const format = { sampleRate: RATE, bitDepth: 24, channels: 2 } as const;
  const enc = new WavEncoder(format, seed);
  writeFileSync(file, Buffer.concat([wavHeader(format, l.length), enc.encode(l, r, l.length)]));
}

/** The pad alone, dry: the other parts muted, no reverb or delay. */
function dryPart(piece: Piece, part: string): Piece {
  const p = structuredClone(piece);
  p.voices.forEach((v, i) => {
    const inPart =
      part === '*' || (v.part !== undefined ? v.part === part : partOfOld(piece, i) === part);
    v.mute = !inPart;
    v.sends = { reverb: 0, delay: 0 };
  });
  p.mix.sends = { reverb: 0, delay: 0 };
  return p;
}

/** Old files have no parts: the same pool layout as the new ones (by voice index). */
let PARTS: string[] = [];
const partOfOld = (_p: Piece, i: number): string => PARTS[i];

/** One-pole-pair high-pass at 150 Hz (2nd-order Butterworth), mono sum. */
function highpassMono([l, r]: Float32Array[]): Float64Array {
  const w = Math.tan((Math.PI * 150) / RATE);
  const k = Math.SQRT2;
  const n = 1 / (1 + k * w + w * w);
  const b0 = n;
  const a1 = 2 * (w * w - 1) * n;
  const a2 = (1 - k * w + w * w) * n;
  const out = new Float64Array(l.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < l.length; i++) {
    const x = 0.5 * (l[i] + r[i]);
    const y = b0 * (x - 2 * x1 + x2) - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

/** RMS per window of `win` s starting at `from` (s); x is indexed from time `t0`. */
function rmsWindows(
  x: ArrayLike<number>,
  win: number,
  t0: number,
  from: number,
  to: number,
): number[] {
  const out: number[] = [];
  for (let t = from; t + win <= to; t += win) {
    const a = Math.round((t - t0) * RATE);
    const b = Math.round((t + win - t0) * RATE);
    let s = 0;
    let n = 0;
    for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) {
      s += x[i] * x[i];
      n++;
    }
    out.push(n > 0 ? Math.sqrt(s / n) : 0);
  }
  return out;
}

function rmsAll(x: ArrayLike<number>, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

interface Section {
  name: string;
  from: number;
  to: number;
  /** Pulse step (s): also compare each step's peak and trough. */
  step?: number;
}

export async function compareSong(
  name: string,
  oldDir: string,
  newDir: string,
  outDir: string,
  /** Old time = new time + shift (the removed lead-in). */
  shift: number,
  parts: string[],
  sections: Section[],
  extraNew?: { tag: string; piece: Piece },
  /** How long after the downbeat the old chords arrived (s). */
  chordLag = 0,
): Promise<string> {
  PARTS = parts;
  const lines: string[] = [];
  const say = (s: string): void => {
    lines.push(s);
  };
  const file = `${name}.algorhythms.json`;
  const oldP = load(join(oldDir, file));
  const newP = extraNew?.piece ?? load(join(newDir, file));
  const tag = extraNew ? `-${extraNew.tag}` : '';
  type Raw = Record<string, unknown> & { moments: unknown[] };
  const raw = JSON.parse(readFileSync(join(newDir, file), 'utf8')) as Raw;
  const oldRaw = JSON.parse(readFileSync(join(oldDir, file), 'utf8')) as Raw;
  const len = async (r: Raw, strip: boolean): Promise<number> =>
    (await encodeShareLink(strip ? stripDefaults(r) : r, SITE)).length;
  say(
    `${name}${tag}: moments ${oldRaw.moments.length} → ${raw.moments.length}; share link ${await len(oldRaw, false)} → ${await len(raw, false)} chars as stored, ${await len(oldRaw, true)} → ${await len(raw, true)} with defaults stripped (M5 estimate)`,
  );
  if (process.env.LINK_ONLY) return lines.join('\n');
  const oldS = compile(oldP);
  const newS = compile(newP);
  const bad = newS.diagnostics.filter((d) => d.level !== 'info');
  if (bad.length) say(`  DIAGNOSTICS ${JSON.stringify(bad)}`);

  if (process.env.DUMP) {
    const [vi, from, to] = process.env.DUMP.split(',').map(Number);
    for (let t = from; t < to; t += 0.1) {
      const a = pitchAt(newS.voices[vi], t);
      const b = pitchAt(oldS.voices[vi], t + shift);
      say(`    ${t.toFixed(2)} new ${a?.toFixed(2)} old ${b?.toFixed(2)}`);
    }
  }
  // Pitch lines, every 50 ms, voice by voice (same pool layout).
  const end = (newP.end.at ?? newS.duration) - 0.5;
  const lines50 = (part: string, lag: number, label: string): void => {
    let n = 0;
    let off = 0;
    let worst = 0;
    let worstAt = 0;
    let longest = 0;
    let longestAt = 0;
    let presence = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== part) continue;
      let run = 0;
      for (let t = 0; t < end; t += 0.05) {
        const a = pitchAt(newS.voices[i], t);
        const b = pitchAt(oldS.voices[i], t + shift + lag);
        if ((a === null) !== (b === null)) presence++;
        if (a === null || b === null) continue;
        n++;
        const d = Math.abs(a - b);
        if (d > 0.5) {
          off++;
          run += 0.05;
          if (run > longest) {
            longest = run;
            longestAt = t;
          }
        } else run = 0;
        if (d > worst) {
          worst = d;
          worstAt = t;
        }
      }
    }
    say(
      `  pitch ${label}: ${((100 * off) / n).toFixed(1)} % of samples off by > 0.5 st; longest run ${longest.toFixed(2)} s (ends ${longestAt.toFixed(2)} s); max ${worst.toFixed(2)} st at ${worstAt.toFixed(2)} s; on/off mismatches ${presence}`,
    );
  };
  for (const part of [...new Set(parts)]) {
    lines50(part, 0, part);
    // Chords now land on the downbeat; the old ones arrived `chordLag` s after it.
    if (part === 'Chords' && chordLag)
      lines50(part, chordLag, `Chords vs old moved ${chordLag} s earlier`);
  }

  // Full renders (WAVs for the owner).
  const frames = exportFrameCount(newS, newP.mix, RATE);
  const oldFrames = exportFrameCount(oldS, oldP.mix, RATE);
  const nw = render(newP, newS, frames);
  const ow = render(oldP, oldS, oldFrames);
  if (!extraNew) writeWav(join(outDir, `${name}-before.wav`), ow, oldP.seed);
  writeWav(join(outDir, `${name}-after${tag}.wav`), nw, newP.seed);

  // Loudness above 150 Hz: overall and per 4 s window.
  const nh = highpassMono(nw);
  const oh = highpassMono(ow);
  const tEnd = newP.end.at ?? newS.duration;
  const lo = db(rmsAll(oh, Math.round(shift * RATE), Math.round((tEnd + shift) * RATE)));
  const ln = db(rmsAll(nh, 0, Math.round(tEnd * RATE)));
  say(`  loudness >150 Hz: ${lo.toFixed(2)} → ${ln.toFixed(2)} dB (Δ ${(ln - lo).toFixed(2)})`);
  const wn = rmsWindows(nh, 4, 0, 0, tEnd);
  const wo = rmsWindows(oh, 4, -shift, 0, tEnd);
  let w4 = 0;
  let w4at = 0;
  wn.forEach((v, k) => {
    if (db(wo[k]) < -50) return;
    const d = db(v) - db(wo[k]);
    if (Math.abs(d) > Math.abs(w4)) {
      w4 = d;
      w4at = 4 * k;
    }
  });
  const over1 = wn.filter((v, k) => db(wo[k]) >= -50 && Math.abs(db(v) - db(wo[k])) > 1).length;
  say(
    `  4 s windows: largest Δ ${w4.toFixed(2)} dB at ${w4at}–${w4at + 4} s; ${over1} of ${wn.length} windows off by > 1 dB`,
  );
  if (process.env.WINDOWS) say(`    ${wn.map((v, k) => (db(v) - db(wo[k])).toFixed(1)).join(' ')}`);

  // The pad's envelope, dry (the pulse rhythm): 10 ms RMS, per section.
  if (process.env.PART_WINDOWS) {
    for (const part of ['*', ...new Set(parts)]) {
      const a = dryPart(newP, part);
      const b = dryPart(oldP, part);
      const ra = highpassMono(render(a, compile(a), frames));
      const rb = highpassMono(render(b, compile(b), oldFrames));
      const xa = rmsWindows(ra, 4, 0, 0, tEnd);
      const xb = rmsWindows(rb, 4, -shift, 0, tEnd);
      say(`    ${part}: ${xa.map((v, k) => (db(v) - db(xb[k])).toFixed(1)).join(' ')}`);
    }
  }
  if (process.env.SKIP_ENV) return lines.join('\n');
  const pn = dryPart(newP, 'Chords');
  const po = dryPart(oldP, 'Chords');
  const en = render(pn, compile(pn), frames);
  const eo = render(po, compile(po), oldFrames);
  const mn = en[0].map((v, i) => 0.5 * (v + en[1][i]));
  const mo = eo[0].map((v, i) => 0.5 * (v + eo[1][i]));
  for (const s of sections) {
    const a = rmsWindows(mn, 0.01, 0, s.from, s.to);
    const b = rmsWindows(mo, 0.01, -shift, s.from, s.to);
    let sum = 0;
    let k = 0;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    for (let i = 0; i < a.length; i++) {
      sab += (a[i] - ma) * (b[i] - mb);
      saa += (a[i] - ma) ** 2;
      sbb += (b[i] - mb) ** 2;
      if (db(b[i]) < -60) continue;
      sum += Math.abs(db(a[i]) - db(b[i]));
      k++;
    }
    const level = db(rmsAll(a, 0, a.length)) - db(rmsAll(b, 0, b.length));
    let steps = '';
    if (s.step) {
      // Per step: the peak (accent) and the trough just before the next hit, in dB.
      const per = Math.round(s.step / 0.01);
      const pk: number[][] = [[], []];
      const tr: number[][] = [[], []];
      for (let i = 0; i + per <= a.length; i += per) {
        [a, b].forEach((e, j) => {
          const w = e.slice(i, i + per);
          pk[j].push(db(Math.max(...w)));
          tr[j].push(db(Math.min(...w.slice(-3))));
        });
      }
      const mad = (x: number[], y: number[]): number =>
        x.reduce((acc, v, i) => acc + Math.abs(v - y[i]), 0) / x.length;
      const corr = (x: number[], y: number[]): number => {
        const mx = x.reduce((p, q) => p + q, 0) / x.length;
        const my = y.reduce((p, q) => p + q, 0) / y.length;
        let xy = 0;
        let xx = 0;
        let yy = 0;
        x.forEach((v, i) => {
          xy += (v - mx) * (y[i] - my);
          xx += (v - mx) ** 2;
          yy += (y[i] - my) ** 2;
        });
        return xy / Math.sqrt(xx * yy);
      };
      const bias = (x: number[], y: number[]): number =>
        x.reduce((acc, v, i) => acc + v - y[i], 0) / x.length;
      steps = `; per step: peaks Δ ${bias(pk[0], pk[1]).toFixed(2)} ± ${mad(pk[0], pk[1]).toFixed(2)} dB (accent corr ${corr(pk[0], pk[1]).toFixed(3)}), troughs Δ ${bias(tr[0], tr[1]).toFixed(2)} ± ${mad(tr[0], tr[1]).toFixed(2)} dB`;
    }
    say(
      `  pad envelope ${s.name}: mean |Δ| ${(sum / Math.max(1, k)).toFixed(2)} dB, corr ${(sab / Math.sqrt(saa * sbb)).toFixed(3)}, level Δ ${level.toFixed(2)} dB${steps}`,
    );
  }

  // Clicks (tests/dsp/clicks.test.ts metric: largest step / local RMS).
  for (const [label, w] of [
    ['before', ow],
    ['after', nw],
  ] as const) {
    const c = [clickScore(w[0], 480), clickScore(w[1], 480)].sort((x, y) => y.ratio - x.ratio)[0];
    say(`  clicks ${label}: worst ${c.ratio.toFixed(3)} at ${c.at.toFixed(2)} s`);
  }
  return lines.join('\n');
}
