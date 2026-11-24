/**
 * Measures of a compiled piece for the directed composer's tests (PLAN §15 M12 "Variety",
 * "shape → the energy curve"): onsets, levels, line counts, pitch range, and a 4-bar fingerprint.
 */
import { pitchAt } from '../../../src/core/query';
import type {
  CompiledScore,
  CompiledVoice,
  Piece,
  PulseMoment,
  Seconds,
} from '../../../src/core/types';

/** A voice's level at t (the compiled level timeline: linear ramps from the value before). */
export function levelAt(v: CompiledVoice, t: Seconds): number {
  let cur = 1;
  for (const c of v.level) {
    if (c.t > t) break;
    const from = cur;
    cur = c.over > 0 && t < c.t + c.over ? from + ((c.gain - from) * (t - c.t)) / c.over : c.gain;
  }
  return cur;
}

/** True while the voice sounds (inside a life). */
export function alive(v: CompiledVoice, t: Seconds): boolean {
  return v.lives.some((l) => l.born <= t && t < (l.died ?? Infinity));
}

/** Note onsets: births, pitch moves and pulse hits, with their times. */
export function onsets(score: CompiledScore): Seconds[] {
  const out: Seconds[] = [];
  for (const v of score.voices) {
    for (const l of v.lives) out.push(l.born);
    for (const s of v.segments) if (Math.abs(s.p1 - s.p0) > 0.01) out.push(s.t0);
    for (const p of v.pulse ?? []) if (p.hit && p.accent > 0) out.push(p.t);
  }
  return out.sort((a, b) => a - b);
}

/** Per window: the summed level of sounding lines and the onsets per second. */
export function activity(
  score: CompiledScore,
  end: Seconds,
  windows: number,
): { level: number[]; rate: number[] } {
  const on = onsets(score);
  const level: number[] = [];
  const rate: number[] = [];
  const w = end / windows;
  for (let i = 0; i < windows; i++) {
    let sum = 0;
    let n = 0;
    for (let t = i * w + 0.05; t < (i + 1) * w; t += 0.25) {
      for (const v of score.voices) if (alive(v, t)) sum += levelAt(v, t);
      n++;
    }
    level.push(sum / Math.max(1, n));
    rate.push(on.filter((t) => t >= i * w && t < (i + 1) * w).length / w);
  }
  return { level, rate };
}

/** The most lines sounding at once (sampled every 0.25 s). */
export function maxLines(score: CompiledScore): number {
  let best = 0;
  for (let t = 0; t < score.duration; t += 0.25) {
    let n = 0;
    for (const v of score.voices) if (alive(v, t) && levelAt(v, t) > 0.02) n++;
    best = Math.max(best, n);
  }
  return best;
}

/** Highest minus lowest sounding pitch. */
export function pitchRange(score: CompiledScore): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of score.voices) {
    for (const s of v.segments) {
      if (!alive(v, (s.t0 + s.t1) / 2) || levelAt(v, (s.t0 + s.t1) / 2) < 0.02) continue;
      lo = Math.min(lo, s.p0, s.p1);
      hi = Math.max(hi, s.p0, s.p1);
    }
  }
  return hi - lo;
}

/** Onsets per second over the piece. */
export function density(score: CompiledScore): number {
  return onsets(score).length / Math.max(1, score.duration);
}

/**
 * The content of the 4 bars from `t0`: each audible line's rounded pitch on an eighth grid, and
 * the onsets on that grid, by part; equal strings mean the same music.
 */
export function span4(piece: Piece, score: CompiledScore, t0: Seconds): string {
  const beat = 60 / (piece.view.gridBpm ?? 60);
  const meter = piece.view.meter ?? 4;
  const steps = 4 * meter * 2;
  const parts = new Map<string, string[]>();
  const hits = new Set<string>(onsets(score).map((t) => `${Math.round((t - t0) / (beat / 2))}`));
  for (const v of score.voices) {
    const key = v.part ?? '';
    const row: string[] = [];
    for (let k = 0; k < steps; k++) {
      const t = t0 + (k + 0.5) * (beat / 2);
      const p = alive(v, t) && levelAt(v, t) > 0.05 ? pitchAt(v, t) : null;
      row.push(p === null ? '.' : String(Math.round(p)));
    }
    parts.set(key, [...(parts.get(key) ?? []), row.join(',')]);
  }
  const rows = [...parts].map(([k, r]) => `${k}:${r.sort().join('/')}`).sort();
  const grid = Array.from({ length: steps }, (_, k) => (hits.has(String(k)) ? 'x' : '-')).join('');
  return `${rows.join('|')}#${grid}`;
}

export function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

export function stdev(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

export function corr(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    s += (a[i] - ma) * (b[i] - mb);
    sa += (a[i] - ma) ** 2;
    sb += (b[i] - mb) ** 2;
  }
  return s / Math.sqrt(sa * sb || 1);
}

/**
 * An arpeggio (PLAN M12 listening notes, round 2): lines one at a time (not 'together'), a beat
 * or quicker, at least 60 % of the steps in its cycle (a bar when it restarts) sounding.
 */
export function isArp(m: PulseMoment, beat: number): boolean {
  if (m.mode === 'together' || m.step > beat + 1e-6) return false;
  const n = m.restart ? Math.max(1, Math.round(m.restart / m.step)) : m.pattern.length;
  const cycle = Array.from({ length: n }, (_, j) => m.pattern[j % m.pattern.length]);
  return cycle.filter((x) => x > 0).length >= 0.6 * n;
}

/** The share of the piece's length under an arpeggio. */
export function arpShare(p: Piece): number {
  const beat = 60 / (p.view.gridBpm ?? 60);
  const iv = p.moments
    .filter((m): m is PulseMoment => m.type === 'pulse' && isArp(m, beat))
    .map((m) => [m.at, m.until] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let a = 0;
  let b = -1;
  for (const [x, y] of iv) {
    if (x > b) {
      total += Math.max(0, b - a);
      a = x;
      b = y;
    } else b = Math.max(b, y);
  }
  total += Math.max(0, b - a);
  return total / p.end.at!;
}

/** The shortest figure: pulse steps, walk grids and tune notes (each tune's last note excepted). */
export function quickest(p: Piece): number {
  let q = Infinity;
  for (const m of p.moments) {
    if (m.type === 'pulse') q = Math.min(q, m.step);
    if (m.type === 'walk') q = Math.min(q, m.grid);
    if (m.type === 'tune')
      m.notes.slice(0, -1).forEach((n) => {
        if (!n.rest) q = Math.min(q, n.len);
      });
  }
  return q;
}

/** The pace of change of a directed composition (PLAN M12 "Speed"). */
export interface PaceOfChange {
  /** Mean chord length, bars (repeated chords merged). */
  chord: number;
  /** Mean chord-change glide (length + stagger), beats. */
  glide: number;
  /** Mean level ramp (entries, exits, moves), s. */
  fade: number;
  /** Mean body section length, bars. */
  section: number;
  /** Sections, intro and outro included. */
  sections: number;
}

export function paceOf(
  d: {
    resolved: { tempo: number; meter: number };
    chords: readonly { t: Seconds; symbol: string; key: { tonic: string } }[];
    sections: readonly { name: string; at: Seconds; end: Seconds }[];
  },
  p: Piece,
): PaceOfChange {
  const beat = 60 / d.resolved.tempo;
  const bar = beat * d.resolved.meter;
  const end = d.sections[d.sections.length - 1].end;
  const ch = d.chords.filter(
    (c, i) =>
      i === 0 || c.symbol !== d.chords[i - 1].symbol || c.key.tonic !== d.chords[i - 1].key.tonic,
  );
  const glides: number[] = [];
  const fades: number[] = [];
  for (const m of p.moments) {
    if (m.type === 'chord' && m.at > 0)
      glides.push(((m.glide?.length ?? 0) + (m.glide?.stagger ?? 0)) / beat);
    if (m.type === 'level' && m.over > 0) fades.push(m.over);
  }
  const body = d.sections.filter((s) => s.name !== 'Intro' && s.name !== 'Outro');
  return {
    chord: mean(ch.map((c, i) => ((ch[i + 1]?.t ?? end) - c.t) / bar)),
    glide: mean(glides),
    fade: mean(fades),
    section: mean(body.map((s) => (s.end - s.at) / bar)),
    sections: d.sections.length,
  };
}
