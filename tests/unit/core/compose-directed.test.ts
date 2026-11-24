/**
 * The directed composer (PLAN §15 M12, Acceptance, core side): every answer changes what it
 * should, the harmony fits, the build is in play order, the same brief gives the same piece, and
 * Surprise is at least as varied as today's Generate.
 */
import { describe, expect, it } from 'vitest';
import { parseChord } from '../../../src/core/chords';
import { compile } from '../../../src/core/compiler/compile';
import {
  COMPOSE_MODES,
  LENGTHS,
  MOODS,
  MOOD_REGIONS,
  PARTS,
  PROGRESSIONS,
  SHAPES,
  energyAt,
  modeFamily,
  progressionNamed,
  resolveBrief,
  type ComposeBrief,
  type ComposePart,
} from '../../../src/core/compose-brief';
import {
  PART_NAME,
  composeDirected,
  composeDirectedPiece,
  composeDirectedWithBrief,
  isComposedTitle,
  type DirectedComposition,
} from '../../../src/core/compose-directed';
import { composedPiece, generate } from '../../../src/core/generate';
import { mod } from '../../../src/core/math';
import { chordSymbolOf, theoryOf } from '../../../src/core/theory';
import { pitchClassOf } from '../../../src/core/scales';
import type { ChordMoment, Key, Moment, Piece, TuneMoment } from '../../../src/core/types';
import {
  activity,
  corr,
  density,
  maxLines,
  mean,
  pitchRange,
  span4,
  stdev,
} from './compose-metrics';

/** The part a moment targets: a `part`, or (with the piece) `voices` all of one part. */
const partOf = (m: Moment, p?: Piece): string | null => {
  const t = m.target;
  if (t && typeof t === 'object' && 'part' in t) return t.part;
  if (p && t && typeof t === 'object' && 'voices' in t) {
    const parts = new Set(t.voices.map((id) => p.voices.find((v) => v.id === id)?.part));
    return parts.size === 1 ? ([...parts][0] ?? null) : null;
  }
  return null;
};

/** Note starts of a tune (rests included). */
function starts(m: TuneMoment): number[] {
  const out: number[] = [];
  let t = m.at;
  for (const n of m.notes) {
    out.push(t);
    t += n.len;
  }
  return out;
}

/** The plan chord sounding at t. */
function chordAt(d: DirectedComposition, t: number): DirectedComposition['chords'][number] {
  let c = d.chords[0];
  for (const x of d.chords) if (x.t <= t + 1e-3) c = x; // times are rounded
  return c;
}

/** Every symbol the key's theory offers (triads and sevenths). */
function symbolsOf(key: Key): Set<string> {
  const th = theoryOf(key)!;
  const out = new Set<string>();
  for (const c of th.chords) {
    out.add(chordSymbolOf(c.num, c.quality, false));
    out.add(chordSymbolOf(c.num, c.quality, true));
  }
  return out;
}

/** The key in effect at t. */
function keyAt(p: Piece, t: number): Key {
  let k = p.key;
  for (const m of p.moments) if (m.type === 'key' && m.at <= t + 1e-6) k = m.key;
  return k;
}

const ALL: ComposePart[] = [...PARTS];

describe('resolveBrief', { timeout: 60_000 }, () => {
  it('a mood narrows mode, tempo, density and sounds to its region', () => {
    for (const mood of MOODS) {
      const R = MOOD_REGIONS[mood];
      for (let seed = 1; seed <= 20; seed++) {
        const r = resolveBrief({ seed, mood });
        expect(R.modes, `${mood} ${seed}`).toContain(r.key.mode);
        expect(r.tempo).toBeGreaterThanOrEqual(R.bpm[0]);
        expect(r.tempo).toBeLessThanOrEqual(R.bpm[1]);
        expect(r.density).toBeGreaterThanOrEqual(R.density[0] - 1e-9);
        expect(r.density).toBeLessThanOrEqual(R.density[1] + 1e-9);
        for (const p of PARTS) expect(R.sounds[p]).toContain(r.sounds[p]);
        expect(r.mood[mood]).toBe(1);
      }
    }
  });

  it('Surprise samples the whole range: blends of moods, any mode, the full tempo span', () => {
    const rs = Array.from({ length: 200 }, (_, i) => resolveBrief({ seed: i }));
    const blends = rs.filter((r) => MOODS.filter((m) => r.mood[m] > 0).length === 2).length;
    expect(blends).toBeGreaterThan(80);
    expect(new Set(rs.map((r) => r.key.mode)).size).toBe(COMPOSE_MODES.length);
    expect(new Set(rs.map((r) => r.key.tonic)).size).toBe(12);
    const tempi = rs.map((r) => r.tempo);
    expect(Math.min(...tempi)).toBeLessThan(62);
    expect(Math.max(...tempi)).toBeGreaterThan(128);
    const lengths = rs.map((r) => r.length);
    expect(Math.min(...lengths)).toBeLessThan(75);
    expect(Math.max(...lengths)).toBeGreaterThan(270);
    // Shapes blend too, and every part shows up.
    expect(
      rs.filter((r) => SHAPES.filter((s) => r.shape[s] > 0).length === 2).length,
    ).toBeGreaterThan(80);
    for (const p of PARTS) expect(rs.some((r) => r.parts.includes(p))).toBe(true);
  });

  it('keeps given answers: key (a mode without theory maps to the nearest), tempo, parts', () => {
    const r = resolveBrief({
      seed: 3,
      key: { tonic: 2, mode: 'mixolydian' },
      tempo: 97,
      parts: ['bass', 'bells'],
    });
    expect(r.key).toEqual({ tonic: 2, mode: 'mixolydian' });
    expect(r.tempo).toBe(97);
    expect(r.parts).toEqual(['bass', 'bells']);
    expect(resolveBrief({ seed: 3, key: { tonic: 2, mode: 'locrian' } }).key.mode).toBe('phrygian');
  });

  it('a named progression picks a mode whose own chords it uses', () => {
    for (const p of PROGRESSIONS) {
      expect(progressionNamed(p.name)).toBe(p);
      for (let seed = 1; seed <= 10; seed++) {
        const r = resolveBrief({ seed, start: { kind: 'progression', name: p.name } });
        expect(modeFamily(r.key.mode), `${p.name} ${seed}`).toBe(p.family);
        if (p.mode) expect(r.key.mode).toBe(p.mode);
      }
    }
    expect(progressionNamed('i-bVI-bIII-bVII')?.nick).toBe('Epic minor');
  });
});

describe('composeDirected', { timeout: 60_000 }, () => {
  it('compiles cleanly: no warnings or errors over 40 Surprise briefs', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const p = composeDirectedPiece({ seed });
      const bad = compile(p).diagnostics.filter((d) => d.level !== 'info');
      expect(bad, `seed ${seed}`).toEqual([]);
      expect(isComposedTitle(p.meta.title), p.meta.title).toBe(true);
    }
  });

  it('the length lands within ±5 %', () => {
    for (const length of LENGTHS) {
      for (let i = 0; i < 6; i++) {
        const brief: ComposeBrief = { seed: 10 + i, length, mood: MOODS[i % 5] };
        const p = composeDirectedPiece(brief);
        expect(Math.abs(p.end.at! - length) / length, `${length} ${i}`).toBeLessThanOrEqual(0.05);
        expect(Math.abs(compile(p).duration - length) / length).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('a mood sets the piece: its key, tempo and timbres', () => {
    for (const mood of MOODS) {
      const R = MOOD_REGIONS[mood];
      for (let seed = 1; seed <= 4; seed++) {
        const p = composeDirectedPiece({ seed, mood, parts: ALL });
        expect(R.modes).toContain(p.key.scale);
        expect(p.view.gridBpm).toBeGreaterThanOrEqual(R.bpm[0]);
        expect(p.view.gridBpm).toBeLessThanOrEqual(R.bpm[1]);
        for (const v of p.voices) {
          const part = PARTS.find((x) => PART_NAME[x] === v.part)!;
          expect(R.sounds[part]).toContain(v.timbre);
        }
      }
    }
    // Calm is slower and sparser than Driving, measured on the compiled piece.
    const calm = [1, 2, 3, 4].map((seed) =>
      compile(composeDirectedPiece({ seed, mood: 'calm', length: 60 })),
    );
    const drive = [1, 2, 3, 4].map((seed) =>
      compile(composeDirectedPiece({ seed, mood: 'driving', length: 60 })),
    );
    expect(mean(calm.map(density))).toBeLessThan(mean(drive.map(density)));
  });

  it('the shape is the energy curve, measured on levels and onsets', () => {
    const W = 12;
    const measure = (shape: (typeof SHAPES)[number]) =>
      Array.from({ length: 8 }, (_, i) => {
        const d = composeDirectedWithBrief({
          seed: 100 + i,
          shape,
          mood: MOODS[i % 5],
          length: 180,
        });
        const p = composedPiece(d.composition);
        const a = activity(compile(p), p.end.at!, W);
        const ml = Math.max(...a.level);
        const mr = Math.max(...a.rate);
        const act = a.level.map((l, k) => (0.5 * l) / ml + (0.5 * a.rate[k]) / mr);
        const e = Array.from({ length: W }, (_, k) => energyAt(d.resolved, (k + 0.5) / W));
        const body = act.slice(1, -1);
        return {
          c: corr(act, e),
          range: (Math.max(...body) - Math.min(...body)) / mean(body),
          act,
        };
      });
    const third = (xs: number[], k: number) =>
      mean(xs.slice((k * xs.length) / 3, ((k + 1) * xs.length) / 3));
    const build = measure('build');
    const arc = measure('arc');
    const steady = measure('steady');
    const journey = measure('journey');
    for (const [name, m] of [
      ['build', build],
      ['arc', arc],
      ['journey', journey],
    ] as const) {
      for (const x of m) expect(x.c, name).toBeGreaterThan(0.4);
      expect(mean(m.map((x) => x.c)), name).toBeGreaterThan(0.75);
    }
    for (const x of build) expect(third(x.act, 2)).toBeGreaterThan(third(x.act, 0));
    for (const x of arc) {
      expect(third(x.act, 1)).toBeGreaterThan(third(x.act, 0));
      expect(third(x.act, 1)).toBeGreaterThan(third(x.act, 2));
    }
    expect(mean(steady.map((x) => x.range))).toBeLessThan(0.35);
    expect(mean(steady.map((x) => x.range))).toBeLessThan(mean(build.map((x) => x.range)) / 2);
  });

  it('parts: only those rows, and each of them plays', () => {
    for (let mask = 1; mask < 32; mask++) {
      const parts = PARTS.filter((_, i) => mask & (1 << i));
      const p = composeDirectedPiece({ seed: mask, parts });
      const names = new Set(parts.map((x) => PART_NAME[x]));
      expect(new Set(p.voices.map((v) => v.part))).toEqual(names);
      for (const m of p.moments) {
        const part = partOf(m, p);
        if (part !== null) expect(names.has(part), `${mask} ${m.type}`).toBe(true);
        else expect(['level', 'key'], `${mask} ${m.type} targets all`).toContain(m.type);
      }
      const score = compile(p);
      for (const name of names) {
        const heard = score.voices.some(
          (v) => v.part === name && v.lives.length > 0 && v.level.some((l) => l.gain > 0.1),
        );
        expect(heard, `${mask} ${name}`).toBe(true);
      }
    }
  });

  it('a progression: those chords, in order, in every section; then home', () => {
    for (const prog of PROGRESSIONS) {
      for (const seed of [1, 2]) {
        const d = composeDirectedWithBrief({
          seed,
          parts: ALL,
          start: { kind: 'progression', name: prog.name },
        });
        const p = composedPiece(d.composition);
        const chordMoments = p.moments.filter(
          (m): m is ChordMoment => m.type === 'chord' && partOf(m) === PART_NAME.chords,
        );
        // The plan's chords, per section, are the progression from its first chord.
        for (const s of d.sections) {
          const roots = d.chords
            .filter((c) => c.t >= s.at - 1e-6 && c.t < s.end - 1e-6)
            .map((c) => [c.root, c.key] as const);
          if (s.name === 'Outro') {
            const home = parseChord(prog.family === 'major' ? 'I' : 'i', roots[0][1]);
            expect(roots.every(([r]) => home.ok && r === home.root)).toBe(true);
            continue;
          }
          roots.forEach(([r, key], i) => {
            const want = parseChord(prog.chords[i % prog.chords.length], key);
            expect(want.ok && r === want.root, `${prog.name} ${s.name} ${i}`).toBe(true);
          });
        }
        // And the piece sounds them: every Chords block names a chord of the progression.
        for (const m of chordMoments) {
          const sym = m.notes.kind === 'chord' ? m.notes.symbol : '';
          const root = parseChord(sym, keyAt(p, m.at));
          const ok = [...prog.chords, prog.family === 'major' ? 'I' : 'i'].some((n) => {
            const q = parseChord(n, keyAt(p, m.at));
            return q.ok && root.ok && q.root === root.root;
          });
          expect(ok, `${prog.name} ${sym}`).toBe(true);
        }
      }
    }
  });

  it('a given melody is kept, note for note, and harmonised', () => {
    // Ode to Joy, its first two phrases, in G (quarter = 0.5 s): the second ends on G.
    const tune =
      '71 71 72 74 74 72 71 69 67 67 69 71 71:3 69:1 69:4 71 71 72 74 74 72 71 69 67 67 69 71 69:3 67:1 67:4';
    const ode: { at: number; pitch: number; dur: number }[] = [];
    let at = 0;
    for (const w of tune.split(' ')) {
      const [p, q] = w.split(':').map(Number);
      const dur = ((q ?? 2) * 0.5) / 2;
      ode.push({ at, pitch: p, dur });
      at += dur;
    }
    for (const seed of [1, 2, 3]) {
      const d = composeDirectedWithBrief({
        seed,
        parts: ['chords', 'bass', 'melody'],
        start: { kind: 'melody', notes: ode },
      });
      const p = composedPiece(d.composition);
      expect(p.key.tonic).toBe('G');
      expect(p.view.gridBpm).toBe(120);
      const tunes = p.moments.filter(
        (m): m is TuneMoment => m.type === 'tune' && partOf(m) === PART_NAME.melody,
      );
      const kept = tunes.filter((m) => {
        const ps = m.notes.flatMap((n) => (n.rest ? [] : [n]));
        return (
          ps.length >= ode.length &&
          ode.every((n, i) => ps[i].pitch === n.pitch && Math.abs(ps[i].len - n.dur) < 1e-6)
        );
      });
      expect(kept.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      // Harmonised: most of the melody's time sits on chord tones.
      const m = kept[0];
      const st = starts(m);
      let on = 0;
      let all = 0;
      m.notes.forEach((n, k) => {
        if (n.rest) return;
        const c = chordAt(d, st[k]);
        all += n.len;
        if (c.pcs.includes(mod(n.pitch, 12))) on += n.len;
      });
      // A stepwise tune has passing notes: Ode to Joy under I–V–I–V sits about two thirds on them.
      expect(on / all).toBeGreaterThan(0.6);
    }
  });

  it('harmony: chords fit the key, the melody fits the chords, the bass is on the roots', () => {
    let strong = 0;
    let fits = 0;
    let changes = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const d = composeDirectedWithBrief({ seed });
      const p = composedPiece(d.composition);
      const beat = 60 / p.view.gridBpm!;
      const meter = p.view.meter!;
      for (const m of p.moments) {
        if (m.type !== 'chord' || m.notes.kind !== 'chord') continue;
        expect(symbolsOf(keyAt(p, m.at)).has(m.notes.symbol), `${seed} ${m.notes.symbol}`).toBe(
          true,
        );
      }
      for (const m of p.moments) {
        if (m.type !== 'tune') continue;
        const st = starts(m);
        if (partOf(m) === PART_NAME.melody) {
          m.notes.forEach((n, k) => {
            if (n.rest) return;
            const b = (st[k] - m.at) / beat;
            const onBeat = Math.abs(b - Math.round(b)) < 1e-3;
            const pos = mod(Math.round(b), meter);
            if (!onBeat || !(pos === 0 || (meter === 4 && pos === 2))) return;
            strong++;
            if (chordAt(d, st[k]).pcs.includes(mod(n.pitch, 12))) fits++;
          });
        }
        if (partOf(m) === PART_NAME.bass) {
          const end = st[st.length - 1] + m.notes[m.notes.length - 1].len;
          for (const c of d.chords) {
            if (c.t < m.at - 1e-6 || c.t >= end - 2e-3) continue; // times are on a 1 ms grid
            const k = st.findIndex((t) => Math.abs(t - c.t) < 2e-3);
            expect(k, `${seed} bass note at ${c.t}`).toBeGreaterThanOrEqual(0);
            const n = m.notes[k];
            expect(n.rest ? -1 : mod(n.pitch, 12), `${seed} root at ${c.t}`).toBe(c.root);
            changes++;
          }
        }
      }
    }
    expect(strong).toBeGreaterThan(500);
    expect(fits / strong).toBeGreaterThan(0.97);
    expect(changes).toBeGreaterThan(300);
  });

  it('is deterministic: the same brief gives the same piece', () => {
    for (const brief of [
      { seed: 9 },
      { seed: 9, mood: 'dark', shape: 'journey', length: 120, parts: ['chords', 'melody'] },
      { seed: 9, start: { kind: 'progression', name: 'ii–V–I' } },
    ] as ComposeBrief[]) {
      const a = JSON.stringify(composeDirected(brief));
      expect(JSON.stringify(composeDirected(structuredClone(brief)))).toBe(a);
      expect(JSON.stringify(composeDirected({ ...brief, seed: 10 }))).not.toBe(a);
    }
  });

  it('places the structure in play order, then one left-to-right detail sweep (maybe empty)', () => {
    let details = 0;
    let none = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const c = composeDirected({ seed });
      const cut = c.steps.findIndex((s) => s.phase === 'detail');
      const struct = cut < 0 ? c.steps : c.steps.slice(0, cut);
      const sweep = cut < 0 ? [] : c.steps.slice(cut);
      expect(struct.every((s) => s.kind === 'add' && s.phase === 'structure')).toBe(true);
      expect(sweep.every((s) => s.phase === 'detail')).toBe(true);
      for (const part of [struct, sweep]) {
        const ats = part.map((s) => s.moment.at);
        for (let i = 1; i < ats.length; i++) expect(ats[i]).toBeGreaterThanOrEqual(ats[i - 1]);
      }
      expect(new Set(c.steps.map((s) => s.moment.id)).size).toBe(c.steps.length);
      // Each section's name is on the build show's steps and on its first block.
      const names = new Set(c.steps.map((s) => (s.kind === 'add' ? s.section : '')));
      for (const s of c.sections) expect(names.has(s.name)).toBe(true);
      // Every partial build is a playable piece.
      for (const k of [1, Math.floor(c.steps.length / 3), Math.floor((2 * c.steps.length) / 3)]) {
        const bad = compile(composedPiece(c, k)).diagnostics.filter((x) => x.level === 'error');
        expect(bad, `${seed} at ${k}`).toEqual([]);
      }
      details += sweep.length;
      if (sweep.length === 0) none++;
    }
    // Detail is optional (PLAN M12 listening notes): some pieces get a little, most none.
    expect(details).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(0);
  });
});

describe('variety (PLAN M12 "Variety")', { timeout: 60_000 }, () => {
  it('over 50 seeds, all-Surprise spreads at least as widely as Generate', () => {
    const N = 50;
    const gen = Array.from({ length: N }, (_, i) =>
      generate(i + 1, { mode: 'dorian', length: 150 }),
    );
    const dir = Array.from({ length: N }, (_, i) => composeDirectedPiece({ seed: i + 1 }));
    const measure = (ps: Piece[]) => {
      const sc = ps.map((p) => compile(p));
      return {
        modes: new Set(ps.map((p) => String(p.key.scale))).size,
        keys: new Set(ps.map((p) => `${pitchClassOf(p.key.tonic)} ${String(p.key.scale)}`)).size,
        tempo: stdev(ps.map((p) => p.view.gridBpm ?? 60)),
        density: stdev(sc.map(density)) / mean(sc.map(density)),
        lines: stdev(sc.map(maxLines)),
        range: stdev(sc.map(pitchRange)),
      };
    };
    const g = measure(gen);
    const d = measure(dir);
    expect(d.modes).toBeGreaterThanOrEqual(Math.max(4, g.modes));
    expect(d.keys).toBeGreaterThan(g.keys);
    expect(d.tempo).toBeGreaterThan(g.tempo);
    expect(d.density).toBeGreaterThanOrEqual(g.density);
    expect(d.lines).toBeGreaterThanOrEqual(g.lines);
    expect(d.range).toBeGreaterThanOrEqual(g.range);
  }, 60_000);

  it('the same answers with different seeds share no 4-bar span', () => {
    const briefs: Omit<ComposeBrief, 'seed'>[] = [
      {
        mood: 'calm',
        length: 60,
        shape: 'steady',
        parts: ALL,
        key: { tonic: 0, mode: 'major' },
        tempo: 80,
      },
      {
        mood: 'driving',
        length: 60,
        shape: 'build',
        parts: ['chords', 'bass', 'melody'],
        key: { tonic: 9, mode: 'aeolian' },
        tempo: 120,
      },
      {
        mood: 'bright',
        length: 60,
        shape: 'arc',
        parts: ALL,
        key: { tonic: 7, mode: 'major' },
        tempo: 100,
        start: { kind: 'progression', name: 'I–V–vi–IV' },
      },
    ];
    for (const b of briefs) {
      const ps = [1, 2, 3].map((seed) => composeDirectedPiece({ ...b, seed }));
      const spans = ps.map((p) => {
        const s = compile(p);
        const bar = (60 / p.view.gridBpm!) * p.view.meter!;
        const out = new Set<string>();
        for (let t = 0; t + 4 * bar <= p.end.at! + 1e-6; t += bar) out.add(span4(p, s, t));
        return out;
      });
      for (let i = 0; i < ps.length; i++)
        for (let j = i + 1; j < ps.length; j++)
          for (const x of spans[i]) expect(spans[j].has(x), `${b.mood} ${i}/${j}`).toBe(false);
    }
  }, 60_000);
});
