/**
 * The directed composer (PLAN.md §15 M12, §11.3 "Compose for me, directed"): a `ComposeBrief` →
 * the steps that build the piece, in play order, then one sweep of detail edits (the same
 * `Composition` contract as `composeSteps`, so the build show replays it unchanged).
 *
 * Method, the way the bundled compositions are written (scripts/compositions):
 *   Form      bars on the tempo's grid: an intro, 4-bar phrases grouped into sections (A, B,
 *             A′ …; Journey is A–B–A), an outro on the home chord. Each section's energy is the
 *             brief's curve at that time.
 *   Harmony   a loop per section label, drawn with the theory-aware ranking (core/theory
 *             `rankNext`, `transition`), or the named progression, or (a given melody) the best
 *             path of chords under its notes. Chords are Roman numerals, so they follow the key.
 *   Parts     each part is a named part (Chords, Bass, Melody, Pulse, Bells) and its rows: chord
 *             blocks landing on the downbeat (`glide.land`, explicit stagger), textures (Pulse,
 *             Arpeggio, walks over the chord), a bass tune on the roots, melodies fitted to the
 *             chords (core/melody `fitMelody`), and level ramps: a part comes in when the energy
 *             passes its threshold and fades in and out, never cut.
 *   Joins     (D3, the owner's listening notes) a section never changes everything on one beat:
 *             its last chord leads into the next section's first (a turnaround); a texture's
 *             new figure comes in part by part, or line by line when one part changes alone,
 *             over a bar; the bass carries its old pattern a bar into the new section.
 *   Lead      with no tune (no Melody part) the first of Chords, Pulse, Bells, Bass drives the
 *             piece: its progression develops (a new loop for A′, a substitute every other
 *             time round), its top line moves like a tune (voicing windows chosen per chord),
 *             and its texture follows each phrase's energy. Backing parts may loop.
 *   Detail    optional: upper-neighbour notes only on long held chords in quiet sections.
 *   Speed     the pace of change (not the tempo or the figures): slower holds chords longer,
 *             glides, hands over and fades for longer, and makes phrases and sections longer
 *             (fewer of them in the same length), so parts come and go less often.
 *
 * Deterministic for the brief (seed included): every draw is `rand(seed, decision, i,
 * Purpose.Compose)`.
 */

import { chordOf, chordSymbolOf, rankNext, theoryOf, transition, type Theory } from './theory';
import { parseChord } from './chords';
import { compile } from './compiler/compile';
import { canonicalMoment, canonicalPiece } from './canonical';
import {
  MOOD_LABEL,
  PART_LABEL,
  changeScale,
  energyAt,
  modeFamily,
  pickIndex,
  resolveBrief,
  type ComposeBrief,
  type ComposePart,
  type ResolvedBrief,
} from './compose-brief';
import {
  builtinTimbresFor,
  defaultGlide,
  defaultMix,
  defaultView,
  DEFAULT_TIMESTAMP,
} from './defaults';
import {
  composedPiece,
  type ComposeStep,
  type Composition,
  type GeneratedSection,
} from './generate';
import { clamp, exp2, log2, mod, sinPi } from './math';
import { fitMelody, type MelodyChord } from './melody';
import { pitchAt } from './query';
import { voiceNotes } from './voicing';
import { Purpose, base62Id, mix32, rand } from './rng';
import {
  FLAT_NAMES,
  SHARP_NAMES,
  pitchClassOf,
  pitchesWithPcs,
  scalePcs,
  stepByScale,
} from './scales';
import {
  PIECE_FORMAT,
  PIECE_VERSION,
  type Glide,
  type Key,
  type KeyChange,
  type Moment,
  type Piece,
  type Pitch,
  type PulseMode,
  type PulseMoment,
  type Seconds,
  type TuneNote,
  type VoiceDef,
  type VoiceSelector,
  type WalkMoment,
} from './types';

/** A moment without its id (distributes over the union). */
type NewMoment = Moment extends infer M ? (M extends Moment ? Omit<M, 'id'> : never) : never;

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const r3 = (x: number): number => Math.round(x * 1e3) / 1e3;

/** The part names in the piece (a part's rows are labelled by them). */
export const PART_NAME: Readonly<Record<ComposePart, string>> = PART_LABEL;

/** Keys written with flats (F, B♭, E♭, A♭, D♭, G♭ major and their modes' tonics by parent). */
const FLAT_TONICS = new Set([5, 10, 3, 8, 1, 6]);

/** The key as the piece writes it. */
export function keyOf(tonic: number, mode: Key['scale']): Key {
  const pc = mod(tonic, 12);
  // The parent major's tonic decides flats vs sharps.
  const family = typeof mode === 'string' ? modeFamily(mode) : 'major';
  const parent = family === 'minor' ? mod(pc + 3, 12) : pc;
  return { tonic: (FLAT_TONICS.has(parent) ? FLAT_NAMES : SHARP_NAMES)[pc], scale: mode };
}

/** "Dreamy D Lydian 4021": the mood, the key and the seed. */
export function composedTitle(r: ResolvedBrief): string {
  const k = keyOf(r.key.tonic, r.key.mode);
  const mode = r.key.mode
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${MOOD_LABEL[r.moodName]} ${k.tonic.replace('b', '♭').replace('#', '♯')} ${mode} ${r.seed}`;
}

const TITLE_RE = new RegExp(
  `^(${Object.values(MOOD_LABEL).join('|')}) [A-G][♭♯#]? [A-Z][a-z]+( [A-Z][a-z]+)? \\d+$`,
);

/** True if `title` looks exactly like an automatic `composedTitle`. */
export function isComposedTitle(title: string): boolean {
  return TITLE_RE.test(title.trim());
}

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

/** One chord of the plan: from `beat` (piece beats) for `beats`. */
interface PlanChord {
  beat: number;
  beats: number;
  num: string;
  symbol: string;
  key: Key;
  root: number;
  pcs: number[];
}

type Label = 'A' | 'B' | 'C';
type Kind = 'intro' | 'body' | 'outro';

interface Section {
  name: string;
  kind: Kind;
  label: Label | null;
  bar0: number;
  bars: number;
  energy: number;
  key: Key;
  on: Record<ComposePart, boolean>;
  chords: PlanChord[];
}

/** A loop: numerals with lengths in beats. */
type Loop = { num: string; beats: number }[];

/** A 4-bar phrase (intro and outro are one phrase each). */
interface Phrase {
  bar0: number;
  bars: number;
  energy: number;
  section: Section;
}

/** A texture on a part's lines: a pulse, and a walk inside it; null holds. */
interface Tex {
  pulse?: Omit<PulseMoment, 'id' | 'type' | 'at' | 'until' | 'target'>;
  walk?: Omit<WalkMoment, 'id' | 'type' | 'at' | 'until' | 'target'>;
}

/** A stretch of one texture on a part (beats); `on` false where the part is silent. */
interface Span {
  from: number;
  to: number;
  on: boolean;
  tex: Tex | null;
  /** Energy of its first and last phrase. */
  energy: number;
  last: number;
}

/** A chord block of a part: the opening, a change, an entry, or a new voicing of a long chord. */
interface Block {
  beat: number;
  beats: number;
  c: PlanChord;
  reg: [Pitch, Pitch];
  open?: boolean;
  revoice?: boolean;
}

/**
 * A texture's figure: its rhythm (step, accents, envelope, all lines together or one at a time)
 * and its walk's grid and steps; not an arpeggio's direction or how often the walk steps.
 * 'hold' for none.
 */
function figureOf(tex: Tex | null): string {
  if (tex === null) return 'hold';
  const p = tex.pulse;
  const w = tex.walk;
  return JSON.stringify([
    p && [p.step, p.pattern, p.decay, p.floor, p.mode === 'together', p.restart ?? 0, p.strike],
    w && [w.grid, w.steps, w.over],
  ]);
}

/** A part's texture in one phrase; `on` false where the part is silent. */
interface PhraseTex {
  on: boolean;
  tex: Tex | null;
}

/** The most of a piece arpeggios may fill (the acceptance allows a third; staging adds a bar). */
const ARP_SHARE = 0.25;

/** The steps a pulse sounds in one cycle (a bar when it restarts). */
function cycleOf(p: NonNullable<Tex['pulse']>): number[] {
  if (!p.restart) return p.pattern;
  const n = Math.max(1, Math.round(p.restart / p.step));
  return Array.from({ length: n }, (_, j) => p.pattern[j % p.pattern.length]);
}

/**
 * True when a texture reads as an arpeggio: lines one at a time, a beat or quicker, most steps
 * sounding. (A broken chord rests every other step.)
 */
export function isArp(tex: Tex | null | undefined, beat: Seconds): boolean {
  const p = tex?.pulse;
  if (!p || p.mode === 'together' || p.step > beat + 1e-6) return false;
  const c = cycleOf(p);
  return c.filter((x) => x > 0).length >= 0.6 * c.length;
}

/** True when the lines sound one at a time (an arpeggio or a broken chord). */
function oneAtATime(tex: Tex | null | undefined): boolean {
  return tex?.pulse !== undefined && tex.pulse.mode !== 'together';
}

/** An arpeggio made a broken chord: every other step of its cycle a rest, no restart. */
function thinned(tex: Tex): Tex {
  const p = tex.pulse!;
  let c = cycleOf(p);
  if (c.length % 2 === 1) c = [...c, ...c];
  const { restart: _, ...rest } = p;
  return { ...tex, pulse: { ...rest, pattern: c.map((x, i) => (i % 2 === 0 ? x : 0)) } };
}

/** The parts written as chord blocks and textures. */
const BLOCK_PARTS = ['chords', 'pulse', 'bells'] as const;
type BlockPart = (typeof BLOCK_PARTS)[number];

type BassPattern = 'hold' | 'halves' | 'rfo' | 'walk' | 'drive';

/** Thresholds of energy at which a part plays (owner: frequent bells, a solid bass). */
const ENTER: Readonly<Record<ComposePart, number>> = {
  chords: 0,
  bells: 0.12,
  bass: 0.22,
  pulse: 0.3,
  melody: 0.3,
};

/**
 * Level trims per timbre: a held note of each at about the same loudness (measured offline at
 * C4: sine −16.7 LUFS, glass −20.2, choir −15.2 …); struck sounds get more, as they die away.
 */
const TRIM: Readonly<Record<string, number>> = {
  sine: 0.86,
  glass: 1.25,
  organ: 0.9,
  reed: 1,
  choir: 0.75,
  wobble: 1.05,
  flute: 1,
  brass: 1.15,
  bell: 1.1,
  pluck: 1.5,
  epiano: 1.3,
  marimba: 1.4,
};

/** Timbres that are struck and die away to a quiet sustain. */
const STRUCK = new Set(['pluck', 'epiano', 'marimba', 'bell']);

/** Which part carries the sound when no other plays, in order. */
const LEAD_ORDER: readonly ComposePart[] = ['chords', 'pulse', 'bells', 'bass', 'melody'];

/** A composition of the brief: its steps, sections and finished piece settings. */
export function composeDirected(brief: ComposeBrief): Composition<string> {
  return new Composer(resolveBrief(brief), brief).run();
}

/** The finished piece of `composeDirected(brief)`. */
export function composeDirectedPiece(brief: ComposeBrief): Piece {
  return composedPiece(composeDirected(brief));
}

/** A chord of the plan, as the piece sounds it from `t`. */
export interface ComposedChord {
  t: Seconds;
  symbol: string;
  /** Its Roman numeral (core/theory). */
  num: string;
  key: Key;
  /** Root pitch class and the chord's pitch classes. */
  root: number;
  pcs: readonly number[];
}

/** A section of the plan: where it starts, its energy and the parts that play in it. */
export interface ComposedSection {
  name: string;
  at: Seconds;
  end: Seconds;
  energy: number;
  parts: ComposePart[];
}

/** The composition with its resolved brief and plan (tests, D3 tuning). */
export interface DirectedComposition {
  resolved: ResolvedBrief;
  composition: Composition<string>;
  chords: ComposedChord[];
  sections: ComposedSection[];
  /** The part that drives the piece when no part carries a tune (no Melody), else null. */
  lead: ComposePart | null;
}

/** `composeDirected`, also returning the resolved brief, the chords and the sections. */
export function composeDirectedWithBrief(brief: ComposeBrief): DirectedComposition {
  const resolved = resolveBrief(brief);
  const c = new Composer(resolved, brief);
  const composition = c.run();
  return { resolved, composition, ...c.plan(), lead: c.lead };
}

class Composer {
  readonly r: ResolvedBrief;
  readonly beat: Seconds;
  readonly barSec: Seconds;
  readonly meter: number;
  readonly has: (p: ComposePart) => boolean;
  /** Draws keyed by a decision name. */
  readonly d: (stream: string, i?: number) => number;
  private sections: Section[] = [];
  private moments: { m: NewMoment; phase: 'structure' | 'detail'; order: number }[] = [];
  private order = 0;
  /** Each part's pool voices. */
  private voices: VoiceDef[] = [];
  private partVoices = new Map<ComposePart, number>();
  /** Each part's register: chords, pulse, bells (close voicing windows), bass, melody. */
  private reg: Record<ComposePart, [Pitch, Pitch]>;
  private now: string;
  /** The part that drives the piece when no part carries a tune (PLAN M12 "A lone part leads"). */
  readonly lead: ComposePart | null;
  private phrases: Phrase[] = [];
  private allBars = 0;
  /** Chord blocks per part, with their voicing windows. */
  private blocks = new Map<BlockPart, Block[]>();
  /** Texture spans per part. */
  private spans = new Map<BlockPart, Span[]>();
  /** The bass pattern per section name. */
  private bassPats = new Map<string, BassPattern>();
  /** How a part changes figure at a beat: a bar late as a whole, or line by line. */
  private stage = new Map<string, 'late' | 'lines'>();
  /** Chords changes (beats) that glide slowly while the lines sound one at a time. */
  private features = new Set<number>();
  /** Speed: how much longer than at medium a transition takes (`changeScale`). */
  private readonly slower: number;
  /** Speed: bars a handover spreads over (texture staging, the bass, level moves). */
  private readonly hand: number;
  /** Speed: bars of a phrase. */
  private readonly phraseBars: number;

  constructor(r: ResolvedBrief, brief: ComposeBrief & { now?: string }) {
    this.r = r;
    this.beat = 60 / r.tempo;
    this.meter = r.meter;
    this.barSec = this.beat * r.meter;
    this.has = (p) => r.parts.includes(p);
    this.d = (stream, i = 0) => rand(r.seed, stream, i, Purpose.Compose);
    this.now = brief.now ?? DEFAULT_TIMESTAMP;
    this.lead = this.has('melody') ? null : (LEAD_ORDER.find((p) => this.has(p)) ?? null);
    this.slower = changeScale(r.speed);
    this.hand = r.speed < 1 / 3 ? 2 : 1;
    this.phraseBars = r.speed < 1 / 3 ? 8 : 4;
    const c = r.centre;
    // An unhurried tune sits lower.
    const mel0 = Math.min(84, c + (r.unhurried ? 5 : 9));
    this.reg = {
      chords: [c - 12, c + 12],
      pulse: [c - 2, c + 19],
      bells: [c + 16, c + 34],
      bass: [31, 50],
      melody: [mel0, mel0 + 15],
    };
  }

  /** Seconds of a piece beat. */
  T(beat: number): Seconds {
    return r4(beat * this.beat);
  }

  plan(): { chords: ComposedChord[]; sections: ComposedSection[] } {
    const chords = this.sections.flatMap((s) =>
      s.chords.map((c) => ({
        t: this.T(c.beat),
        symbol: c.symbol,
        num: c.num,
        key: c.key,
        root: c.root,
        pcs: c.pcs,
      })),
    );
    const sections = this.sections.map((s) => ({
      name: s.name,
      at: this.T(s.bar0 * this.meter),
      end: this.T((s.bar0 + s.bars) * this.meter),
      energy: s.energy,
      parts: this.r.parts.filter((p) => s.on[p]),
    }));
    return { chords, sections };
  }

  run(): Composition<string> {
    this.form();
    this.harmony();
    this.parts();
    this.voicePool();
    const texs = new Map<BlockPart, PhraseTex[]>();
    for (const p of BLOCK_PARTS) {
      if (!this.has(p)) continue;
      this.blocks.set(p, this.blockList(p));
      texs.set(p, this.phraseTextures(p));
    }
    this.arpBudget(texs);
    for (const [p, t] of texs) this.spans.set(p, this.toSpans(t));
    if (this.lead === 'chords' || this.lead === 'pulse' || this.lead === 'bells')
      this.topLine(this.lead);
    this.glideFeatures();
    this.staging();
    this.write();
    return this.steps();
  }

  // -------------------------------------------------------------------------------------------
  // Form
  // -------------------------------------------------------------------------------------------

  private form(): void {
    const { r, d } = this;
    const melodyBars = r.melody
      ? Math.max(
          2,
          Math.ceil(
            r6(
              r.melody[r.melody.length - 1].at + r.melody[r.melody.length - 1].dur - r.melody[0].at,
            ) /
              this.barSec -
              1e-3,
          ),
        )
      : 0;
    const total = Math.max(8, Math.round(r.length / this.barSec));
    // Slower pieces lean to the longer intro and outro.
    const long = clamp(1 - r.speed, 0.15, 0.85);
    const intro = r.melody || total < 20 ? 2 : d('intro') < long ? 4 : 2;
    let outro = total < 20 ? 2 : d('outro') < long ? 4 : 3;
    // Sections: 4-bar units, about 2 to a section at medium speed (slow ~3.5, fast ~1.4); a given
    // melody sets the section size.
    const unit = r.melody ? Math.ceil(melodyBars / 4) * 4 : 4;
    const body = Math.max(unit, total - intro - outro);
    const units = Math.max(1, Math.floor(body / unit));
    outro += Math.max(0, total - intro - outro - units * unit);
    const journey = r.shape.journey >= 0.5;
    const perSection = 2 * exp2((0.5 - r.speed) * (r.speed < 0.5 ? 1.6 : 1));
    let count = r.melody ? units : Math.max(1, Math.round(units / perSection));
    if (journey && units >= 3) count = Math.max(3, count);
    count = Math.min(count, units);
    const sizes = Array.from(
      { length: count },
      (_, i) => unit * (Math.floor(units / count) + (i < units % count ? 1 : 0)),
    );

    // Labels: Journey A … B … A; otherwise A B A B, with a C bridge now and then.
    const labels: Label[] = sizes.map((_, i) => (i % 2 === 0 ? 'A' : 'B'));
    if (journey && count >= 3) {
      const a = Math.ceil(count / 3);
      const b = Math.max(1, count - 2 * a);
      for (let i = 0; i < count; i++) labels[i] = i < a ? 'A' : i < a + b ? 'B' : 'A';
    } else if (count >= 4 && d('bridge') < 0.4) labels[count - 2] = 'C';
    if (r.melody) for (let i = 0; i < count; i++) labels[i] = i % 2 === 0 ? 'A' : 'B';

    const key0 = keyOf(r.key.tonic, r.key.mode);
    const all = intro + sizes.reduce((a, b) => a + b, 0) + outro;
    const mk = (
      name: string,
      kind: Kind,
      label: Label | null,
      bar0: number,
      bars: number,
    ): Section => {
      let e = 0;
      for (let k = 0; k < 8; k++) e += energyAt(r, (bar0 + ((k + 0.5) * bars) / 8) / all);
      return {
        name,
        kind,
        label,
        bar0,
        bars,
        energy: Math.round((e / 8) * 1000) / 1000,
        key: key0,
        on: { chords: false, bass: false, melody: false, pulse: false, bells: false },
        chords: [],
      };
    };
    const secs: Section[] = [mk('Intro', 'intro', null, 0, intro)];
    let bar = intro;
    const seen: Record<Label, number> = { A: 0, B: 0, C: 0 };
    sizes.forEach((n, i) => {
      const l = labels[i];
      const k = seen[l]++;
      const name = k <= 3 ? l + ['', '′', '″', '‴'][k] : `${l}${k + 1}`;
      secs.push(mk(name, 'body', l, bar, n));
      bar += n;
    });
    secs.push(mk('Outro', 'outro', null, bar, outro));
    this.allBars = all;
    for (const s of secs) {
      const n = s.kind === 'body' ? Math.max(1, Math.round(s.bars / this.phraseBars)) : 1;
      for (let q = 0; q < n; q++) {
        const b0 = s.bar0 + Math.round((q * s.bars) / n);
        const b1 = s.bar0 + Math.round(((q + 1) * s.bars) / n);
        let e = 0;
        for (let k = 0; k < 4; k++) e += energyAt(r, (b0 + ((k + 0.5) * (b1 - b0)) / 4) / all);
        this.phrases.push({ bar0: b0, bars: b1 - b0, energy: r3(e / 4), section: s });
      }
    }

    // A lift: the last body section and the outro up a step (Build and Arc, sometimes).
    if (
      !r.given.key &&
      !r.melody &&
      count >= 3 &&
      r.shape.build + r.shape.arc >= 0.5 &&
      d('lift') < 0.25
    ) {
      const up = d('lift-by') < 0.5 ? 1 : 2;
      const k = keyOf(r.key.tonic + up, r.key.mode);
      secs[secs.length - 2].key = k;
      secs[secs.length - 1].key = k;
    }
    this.sections = secs;
  }

  // -------------------------------------------------------------------------------------------
  // Harmony
  // -------------------------------------------------------------------------------------------

  private theory(key: Key): Theory {
    return theoryOf(key) ?? theoryOf({ tonic: key.tonic, scale: 'major' })!;
  }

  /**
   * Beats per chord: at medium speed a chord lasts about 1.5–6 s (unhurried: a bar or more, up
   * to 8.5 s). Slower stretches those bounds and leans to the longer chords (four bars too);
   * faster shrinks them and leans to the shorter.
   */
  private chordBeats(): number {
    const { meter, d, r } = this;
    const k = exp2((0.5 - r.speed) * 1.8);
    const bars = meter === 3 || r.unhurried ? [1, 2] : [0.5, 1, 2];
    if (r.speed < 0.4) bars.push(4);
    const opts = bars.map((h) => h * meter);
    // Fast allows chords down to ~0.8 s (half bars at Driving tempos).
    const shortest = 1.5 * exp2(Math.min(0, (0.5 - r.speed) * 1.8));
    const ok = opts.filter(
      (b) => b * this.beat >= shortest && b * this.beat <= (r.unhurried ? 8.5 : 6.2) * k,
    );
    const list =
      ok.length > 0
        ? ok
        : [
            opts.reduce((a, b) =>
              Math.abs(b * this.beat - 3) < Math.abs(a * this.beat - 3) ? b : a,
            ),
          ];
    const tilt = 4 * (0.5 - r.speed);
    const w = list.map(
      (b) =>
        (b === meter
          ? 3
          : b < meter
            ? 1.5 * r.density
            : (r.unhurried ? 3 : 1.5) * (1 - r.density)) * exp2(tilt * log2(b / meter)),
    );
    return list[pickIndex(w, d('harmonic-rhythm'))];
  }

  /** A loop of `n` chords drawn by the theory ranking, starting on `first`. */
  private drawLoop(th: Theory, first: string, n: number, colour: number, tag: string): string[] {
    const { d } = this;
    const seq = [first];
    let colours = 0;
    for (let i = 1; i < n; i++) {
      const ranked = rankNext(th, seq).filter(
        (c) =>
          !seq.includes(c.num) &&
          (c.job !== 'colour' || (colours === 0 && d(`${tag}-col`, i) < colour)),
      );
      if (ranked.length === 0) break;
      const top = ranked.slice(0, 6);
      // The last chord should lead back to the first.
      const w = top.map((c) => {
        let s = c.score;
        if (i === n - 1) s *= transition(th, c.num, first);
        return s * s;
      });
      const pick = top[pickIndex(w, d(`${tag}-pick`, i))];
      if (pick.job === 'colour') colours++;
      seq.push(pick.num);
    }
    return seq;
  }

  /** Beats for a loop of `n` chords at `h` beats per chord. */
  private loopBeats(n: number, h: number): number[] {
    // Four-bar chords (slow) aren't doubled.
    const h2 = h >= 4 * this.meter ? h : 2 * h;
    if (n === 1) return [2 * h2];
    if (n === 2) return [h2, h2];
    if (n === 3) return [h, h, h2];
    if (n >= 8 && h >= this.meter && this.meter % 2 === 0) return Array<number>(n).fill(h / 2);
    return Array<number>(n).fill(h);
  }

  private harmony(): void {
    const { r, d } = this;
    const h = this.chordBeats();
    const home = (th: Theory): string => (th.family === 'major' ? 'I' : 'i');
    const loops = new Map<string, Loop>();
    const loopFor = (s: Section): Loop => {
      const id = `${s.label ?? 'A'}|${s.key.tonic}`;
      const hit = loops.get(id);
      if (hit) return hit;
      const th = this.theory(s.key);
      let nums: string[];
      if (r.progression) nums = [...r.progression.chords];
      else {
        const n = [2, 3, 4][pickIndex([0.15, 0.1, 0.75], d(`loop-n-${s.label}`))];
        const jobs = th.chords.filter((c) => !c.num.includes('/'));
        let first = home(th);
        if (s.label === 'A' && d('loop-a-first') < 0.2) {
          first = jobs.find((c) => c.job === 'soft')?.num ?? first;
        } else if (s.label === 'B' || s.label === 'C') {
          const want = s.label === 'B' ? ['lift', 'soft'] : ['lift', 'colour', 'tension'];
          const cands = jobs.filter(
            (c) => want.includes(c.job) && (s.label === 'C' || !c.num.includes('°')),
          );
          if (cands.length > 0)
            first = cands[Math.floor(d(`loop-${s.label}-first`) * cands.length)].num;
        }
        const colour = s.label === 'A' ? 0.2 : 0.35;
        nums = this.drawLoop(th, first, n, colour, `loop-${s.label}`);
        // B must differ from A.
        const a = loops.get(`A|${s.key.tonic}`);
        if (a && a.map((c) => c.num).join() === nums.join())
          nums = this.drawLoop(th, first, n, 1, `loop-${s.label}-again`);
      }
      // A section in half time now and then (a named progression keeps its order either way).
      const hh =
        s.label === 'B' && d('half-time') < 0.3 && h * 2 * this.beat <= 7 * this.slower ? h * 2 : h;
      const beats = this.loopBeats(nums.length, hh);
      const loop = nums.map((num, i) => ({ num, beats: beats[i] }));
      loops.set(id, loop);
      return loop;
    };

    // A given melody: its own chords under the A sections.
    const melodyLoop = r.melody ? this.harmoniseMelody() : null;
    // A lone part leads: its progression develops (a new loop for A′, a substitute on repeats).
    const develop = this.lead !== null && !r.progression;
    const seen = new Map<string, number>();

    let beat = 0;
    let last: string | null = null;
    for (const s of this.sections) {
      const th = this.theory(s.key);
      const len = s.bars * this.meter;
      let seq: Loop;
      if (s.kind === 'outro') {
        const hm = home(th);
        if (r.progression || last === hm || last === null) seq = [{ num: hm, beats: len }];
        else {
          // A cadence into home, then home held.
          const cands = th.chords.filter(
            (c) => c.num !== hm && c.num !== last && !c.num.includes('/'),
          );
          let best = cands[0]?.num ?? hm;
          let bw = -Infinity;
          for (const c of cands) {
            const w =
              transition(th, last, c.num) *
              transition(th, c.num, hm) *
              (c.job === 'colour' ? 0.5 : 1);
            if (w > bw) {
              bw = w;
              best = c.num;
            }
          }
          const pre = Math.min(len / 2, Math.max(this.meter, h));
          seq =
            transition(th, last, hm) >= 2.5
              ? [{ num: hm, beats: len }]
              : [
                  { num: best, beats: pre },
                  { num: hm, beats: len - pre },
                ];
        }
      } else if (s.kind === 'intro') {
        seq = melodyLoop ?? loopFor({ ...s, label: 'A' });
      } else if (melodyLoop && s.label === 'A') seq = melodyLoop;
      else {
        seq = loopFor(s);
        if (develop) {
          const id = `${s.label}|${s.key.tonic}`;
          const k = seen.get(id) ?? 0;
          seen.set(id, k + 1);
          if (k > 0) seq = this.varyLoop(th, seq, `${s.name}`);
        }
      }
      // Fill the section by repeating the loop (developing: every other time with a substitute).
      let b = 0;
      for (let rep = 0; b < len; rep++) {
        const loop =
          develop && s.kind === 'body' && rep % 2 === 1
            ? this.substitute(th, seq, `sub-${s.name}-${rep}`)
            : seq;
        for (const c of loop) {
          if (b >= len) break;
          const beats = Math.min(c.beats, len - b);
          s.chords.push(this.chord(s.key, c.num, beat + b, beats));
          b += beats;
        }
      }
      beat += len;
      last = s.chords[s.chords.length - 1].num;
    }
    if (!r.progression) this.turnarounds(melodyLoop !== null);
  }

  /** A new loop for a section's return (A′): the same first chord, a new way round. */
  private varyLoop(th: Theory, loop: Loop, tag: string): Loop {
    const nums = loop.map((c) => c.num);
    if (nums.length >= 3) {
      const drawn = this.drawLoop(th, nums[0], nums.length, 0.3, `vary-${tag}`);
      if (drawn.length === nums.length && drawn.join() !== nums.join())
        return drawn.map((num, i) => ({ num, beats: loop[i].beats }));
    }
    return this.substitute(th, this.substitute(th, loop, `vary-${tag}-a`), `vary-${tag}-b`);
  }

  /** The loop with one chord (not the first) swapped for one sharing two of its tones. */
  private substitute(th: Theory, loop: Loop, tag: string): Loop {
    const n = loop.length;
    if (n < 2) return loop;
    const tri = (num: string): readonly number[] => chordOf(th, num)?.triad ?? [];
    const first = 1 + Math.floor(this.d(`${tag}-slot`) * (n - 1));
    for (let k = 0; k < n - 1; k++) {
      const i = 1 + ((first - 1 + k) % (n - 1));
      const at = loop[i].num;
      const prev = loop[i - 1].num;
      const next = loop[(i + 1) % n].num;
      const cands = th.chords.filter(
        (c) =>
          !c.num.includes('/') &&
          c.num !== at &&
          c.num !== prev &&
          c.num !== next &&
          c.triad.filter((pc) => tri(at).includes(pc)).length >= 2,
      );
      if (cands.length === 0) continue;
      const w = cands.map((c) => {
        const x = transition(th, prev, c.num) * transition(th, c.num, next);
        return x * x * (c.job === 'colour' ? 0.4 : 1);
      });
      const pick = cands[pickIndex(w, this.d(`${tag}-pick`))];
      return loop.map((c, j) => (j === i ? { num: pick.num, beats: c.beats } : c));
    }
    return loop;
  }

  /**
   * The harmony leads into each section: a section's last chord becomes the best chord into the
   * next section's first (a pre-dominant or dominant), or a last chord of four bars or more
   * gives its second half to one. A section that already ends on the next one's chord, reached
   * by a strong move, keeps it (an anticipation). Not into the outro (its cadence is planned),
   * across a key change, or under a given melody.
   */
  private turnarounds(melody: boolean): void {
    const secs = this.sections;
    for (let i = 0; i + 1 < secs.length; i++) {
      const s = secs[i];
      const n = secs[i + 1];
      if (n.kind === 'outro' || s.key.tonic !== n.key.tonic) continue;
      if (melody && (s.kind === 'intro' || s.label === 'A')) continue;
      const th = this.theory(s.key);
      const target = n.chords[0].num;
      const k = s.chords.length - 1;
      const last = s.chords[k];
      if (last.num !== target && transition(th, last.num, target) >= 2.5) continue;
      // An anticipation: the next section's chord arrives early, by a strong move, and carries
      // across the boundary.
      if (last.num === target && k > 0 && transition(th, s.chords[k - 1].num, target) >= 2)
        continue;
      const split = last.beats >= 4 * this.meter;
      const prev = split ? last.num : k > 0 ? s.chords[k - 1].num : null;
      // The step into the new section matters most.
      const into = (x: string): number =>
        Math.sqrt(prev !== null ? transition(th, prev, x) : 1) * transition(th, x, target) ** 2;
      let best: string | null = null;
      // Better than keeping the chord as it is, by a margin.
      const keep = split
        ? transition(th, last.num, target) ** 2
        : into(last.num) * (last.num === target ? 0.15 : 1);
      let bw = keep * (last.num === target ? 1 : 1.15);
      for (const c of th.chords) {
        if (c.num.includes('/') || c.num === target || c.num === prev) continue;
        const w = into(c.num) * (c.job === 'colour' ? 0.5 : 1);
        if (w > bw) {
          bw = w;
          best = c.num;
        }
      }
      if (best === null) continue;
      if (split) {
        const half = this.meter * Math.floor(last.beats / this.meter / 2);
        s.chords[k] = this.chord(s.key, last.num, last.beat, half);
        s.chords.push(this.chord(s.key, best, last.beat + half, last.beats - half));
      } else s.chords[k] = this.chord(s.key, best, last.beat, last.beats);
    }
  }

  /** A planned chord: its symbol (a seventh when the brief wants them) and pitch classes. */
  private chord(key: Key, num: string, beat: number, beats: number): PlanChord {
    const th = this.theory(key);
    const tc = chordOf(th, num);
    let symbol = num;
    if (tc) symbol = chordSymbolOf(num, tc.quality, this.r.sevenths && !num.includes('/'));
    let p = parseChord(symbol, key);
    if (!p.ok) {
      symbol = num;
      p = parseChord(symbol, key);
    }
    const pcs = p.ok ? p.pcs : [pitchClassOfKey(key)];
    const root = p.ok ? p.root : pcs[0];
    return { beat, beats, num, symbol, key, root, pcs };
  }

  /** The best chord per bar under a given melody (a Viterbi path over the key's chords). */
  private harmoniseMelody(): Loop {
    const { r, meter } = this;
    const notes = r.melody!;
    const t0 = notes[0].at;
    const key = keyOf(r.key.tonic, r.key.mode);
    const th = this.theory(key);
    const scale = new Set(scalePcs(key));
    const end = notes[notes.length - 1].at + notes[notes.length - 1].dur - t0;
    const bars = Math.max(2, Math.ceil(end / this.barSec - 1e-3));
    const span = Math.ceil(bars / 4) * 4;
    const cands = th.chords.filter((c) => !c.num.includes('/'));
    const fit = (bar: number, ci: number): number => {
      const c = cands[ci];
      const a = bar * this.barSec;
      const b = a + this.barSec;
      let s = 0;
      for (const n of notes) {
        const x0 = Math.max(a, n.at - t0);
        const x1 = Math.min(b, n.at - t0 + n.dur);
        if (x1 <= x0) continue;
        const strong =
          Math.abs(n.at - t0 - a) < 1e-3 || Math.abs(n.at - t0 - a - this.barSec / 2) < 1e-3;
        const pc = mod(n.pitch, 12);
        const w = (x1 - x0) * (strong ? 1.6 : 1);
        s +=
          w *
          (c.triad.includes(pc) ? 1 : c.seventh.includes(pc) ? 0.3 : scale.has(pc) ? -0.35 : -1);
      }
      return s / this.barSec + (c.job === 'colour' ? -0.4 : 0);
    };
    const hm = th.family === 'major' ? 'I' : 'i';
    const N = cands.length;
    let score = cands.map((c, i) => fit(0, i) + (c.num === hm ? 0.8 : 0));
    const back: number[][] = [];
    for (let bar = 1; bar < span; bar++) {
      const next: number[] = [];
      const from: number[] = [];
      for (let j = 0; j < N; j++) {
        let best = -Infinity;
        let bi = 0;
        for (let i = 0; i < N; i++) {
          const t = i === j ? -0.25 : 0.5 * log2(transition(th, cands[i].num, cands[j].num));
          const v = score[i] + t;
          if (v > best) {
            best = v;
            bi = i;
          }
        }
        let f = fit(bar, j) + 0.02 * this.d('harm-noise', bar * N + j);
        if (bar === span - 1 && cands[j].num === hm) f += 0.6;
        next.push(best + f);
        from.push(bi);
      }
      back.push(from);
      score = next;
    }
    let j = 0;
    for (let i = 1; i < N; i++) if (score[i] > score[j]) j = i;
    const path = [j];
    for (let bar = span - 1; bar >= 1; bar--) {
      j = back[bar - 1][j];
      path.unshift(j);
    }
    // Repeated chords become one longer chord.
    const loop: Loop = [];
    for (const i of path) {
      const last = loop[loop.length - 1];
      if (last && last.num === cands[i].num) last.beats += meter;
      else loop.push({ num: cands[i].num, beats: meter });
    }
    return loop;
  }

  // -------------------------------------------------------------------------------------------
  // Which parts play where
  // -------------------------------------------------------------------------------------------

  private parts(): void {
    const { r, d } = this;
    const secs = this.sections;
    const bodies = secs.filter((s) => s.kind === 'body');
    // Slower: a part that plays stays on until the energy falls a little below its threshold.
    const stay = Math.max(0, 0.2 * (0.5 - r.speed));
    for (const p of r.parts) {
      const th = ENTER[p] + (d(`enter-${p}`) - 0.5) * 0.16;
      let was = false;
      for (const s of secs) {
        let on: boolean = s.energy >= (was ? th - stay : th);
        if (p === 'melody') on = on && s.kind === 'body';
        if (p === 'melody' && r.melody)
          on = s.kind === 'body' && (s.label === 'A' || s.energy >= th);
        if (p === 'bass' && s.kind === 'intro') on = on && s.energy >= 0.35;
        if (p === 'pulse' && s.kind === 'outro') on = on && s.energy >= 0.45;
        s.on[p] = on;
        was = on;
      }
      // Every part plays somewhere: in the liveliest body section (or the last section).
      if (!secs.some((s) => s.on[p])) {
        const pool = bodies.length > 0 ? bodies : secs;
        let best = pool[0];
        for (const s of pool) if (s.energy > best.energy) best = s;
        best.on[p] = true;
      }
    }
    // Every section sounds.
    for (const s of secs) {
      if (!r.parts.some((p) => s.on[p])) {
        const lead = LEAD_ORDER.find((p) => this.has(p) && (p !== 'melody' || s.kind === 'body'));
        s.on[lead ?? r.parts[0]] = true;
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------------------------

  private voicePool(): void {
    const { r } = this;
    const add = (
      part: ComposePart,
      n: number,
      range: [Pitch, Pitch],
      gain: number,
      pans: number[],
      sends: VoiceDef['sends'],
    ) => {
      this.partVoices.set(part, n);
      for (let i = 0; i < n; i++) {
        this.voices.push({
          id: `v${this.voices.length + 1}`,
          part: PART_NAME[part],
          timbre: r.sounds[part],
          pan: pans[i] ?? 0,
          gain: r3(gain * (TRIM[r.sounds[part]] ?? 1)),
          range: [Math.max(24, range[0]), Math.min(103, range[1])],
          sends,
        });
      }
    };
    const spread = (n: number, w: number): number[] =>
      Array.from({ length: n }, (_, i) => (n === 1 ? 0 : r3(-w + (2 * w * i) / (n - 1))));
    const c = r.centre;
    if (this.has('bass')) add('bass', 1, [28, 52], 2.2, [0], { reverb: 0.15, delay: 0 });
    if (this.has('chords')) {
      // 3 lines for triads, 4 for sevenths; one more in busy pieces, now and then a wide 6.
      const n = Math.min(
        6,
        (r.sevenths ? 4 : 3) +
          (r.density > 0.55 && this.d('chords-more') < 0.6 ? 1 : 0) +
          (this.d('chords-wide') < 0.15 ? 1 : 0),
      );
      add('chords', n, [c - 14, c + 16], 1.5, spread(n, 0.5), { reverb: 0.45, delay: 0.1 });
    }
    if (this.has('pulse'))
      add('pulse', 2 + Math.floor(this.d('pulse-n') * 3), [c - 4, c + 22], 1.6, spread(4, 0.6), {
        reverb: 0.35,
        delay: 0.2,
      });
    if (this.has('melody')) {
      const [a, b] = this.reg.melody;
      add('melody', 1, [a - 3, b + 4], 2.3, [0.05], { reverb: 0.4, delay: 0.2 });
    }
    if (this.has('bells')) {
      const n = Math.min(4, 1 + Math.floor((0.5 * this.d('bells-n') + 0.5 * r.density) * 3.5));
      add('bells', n, [c + 12, c + 38], 1.25, spread(n, 0.7), { reverb: 0.6, delay: 0.35 });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Chord blocks and the lead's top line
  // -------------------------------------------------------------------------------------------

  /** A part's pool voices; ordered voice leading keeps them in pitch order. */
  private idsOf(p: ComposePart): string[] {
    return this.voices.filter((v) => v.part === PART_NAME[p]).map((v) => v.id);
  }

  private sectionAtBeat(beat: number): Section {
    let s = this.sections[0];
    for (const x of this.sections) if (x.bar0 * this.meter <= beat) s = x;
    return s;
  }

  private phraseAtBeat(beat: number): number {
    let q = 0;
    this.phrases.forEach((P, i) => {
      if (P.bar0 * this.meter <= beat) q = i;
    });
    return q;
  }

  /**
   * A part's chord blocks: the opening, each change while it plays, its entries. The lead also
   * gets a new voicing half way through a chord of two bars or more, so its top line moves on.
   */
  private blockList(p: BlockPart): Block[] {
    const secs = this.sections;
    const out: Block[] = [];
    secs.forEach((s, si) => {
      const prev = si > 0 ? secs[si - 1] : null;
      s.chords.forEach((c, ci) => {
        if (c.beat === 0) {
          out.push({ beat: 0, beats: 0, c, reg: this.reg[p], open: true });
          return;
        }
        if (!s.on[p]) return;
        const before = ci > 0 ? s.chords[ci - 1] : prev?.chords[prev.chords.length - 1];
        const entering = ci === 0 && prev !== null && !prev.on[p];
        if (!entering && before && before.symbol === c.symbol && before.key.tonic === c.key.tonic)
          return;
        out.push({ beat: c.beat, beats: 0, c, reg: this.reg[p] });
      });
    });
    const end = this.allBars * this.meter;
    out.forEach((b, i) => (b.beats = (i + 1 < out.length ? out[i + 1].beat : end) - b.beat));
    if (this.lead !== p) return out;
    const full: Block[] = [];
    for (const b of out) {
      full.push(b);
      const bars = Math.floor(b.beats / this.meter);
      const mid = b.beat + this.meter * Math.floor(bars / 2);
      if (bars < 2 || !this.sectionAtBeat(mid).on[p]) continue;
      full.push({ beat: mid, beats: b.beats - (mid - b.beat), c: b.c, reg: b.reg, revoice: true });
      b.beats = mid - b.beat;
    }
    return full;
  }

  /** The tops a close voicing of `c` can have on part `p` (each with its window), low to high. */
  private voiceTops(p: BlockPart, c: PlanChord): { top: Pitch; reg: [Pitch, Pitch]; d: number }[] {
    const vs = this.voices.filter((v) => v.part === PART_NAME[p]);
    const k = vs.length;
    const [lo, hi] = vs[0].range;
    const [a, b] = this.reg[p];
    const out = new Map<Pitch, { top: Pitch; reg: [Pitch, Pitch]; d: number }>();
    for (let d = -7; d <= 7; d++) {
      const reg: [Pitch, Pitch] = [a + d, b + d];
      const v = voiceNotes({
        notes: { kind: 'chord', symbol: c.symbol },
        k,
        mode: 'close',
        register: reg,
        key: c.key,
        current: [],
        voices: [],
      });
      if (!v.ok || v.targets.length !== k || new Set(v.targets).size !== k) continue;
      if (v.targets[0] < lo || v.targets[k - 1] > hi) continue;
      const top = v.targets[k - 1];
      const had = out.get(top);
      if (!had || Math.abs(d) < Math.abs(had.d)) out.set(top, { top, reg, d });
    }
    return [...out.values()].sort((x, y) => x.top - y.top);
  }

  /**
   * The lead's top line moves like a tune: each block's voicing window is chosen so the top
   * voice moves mostly by step, follows a contour per phrase (arch, rise, fall or dip, never the
   * same twice running), avoids what it played over the same chord a phrase earlier, and rests
   * on the root or third at a section's end (the root at the very end). Viterbi per phrase.
   */
  private topLine(p: BlockPart): void {
    const blocks = this.blocks.get(p)!;
    const cands = blocks.map((b) => {
      const c = this.voiceTops(p, b.c);
      return c.length > 0 ? c : [{ top: NaN, reg: b.reg, d: 0 }];
    });
    const groups: number[][] = this.phrases.map(() => []);
    blocks.forEach((b, i) => groups[this.phraseAtBeat(b.beat)].push(i));
    const z = cands[0].find((x) => x.d === 0) ?? cands[0][Math.floor(cands[0].length / 2)];
    const anchor0 = Number.isFinite(z.top) ? z.top : this.reg[p][1] - 4;
    const byBeat = new Map<number, number>();
    blocks.forEach((b, i) => byBeat.set(b.beat, i));
    const pick: number[] = blocks.map(() => 0);
    const move = (a: Pitch, b: Pitch, revoice: boolean): number => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
      const iv = Math.abs(b - a);
      if (revoice && iv === 0) return 50;
      return iv === 0
        ? 0.7
        : iv <= 2
          ? 0
          : iv <= 4
            ? 0.5
            : iv === 5
              ? 1.3
              : iv <= 7
                ? 2.2
                : 4 + 0.3 * iv;
    };
    let prevTop: Pitch | null = null;
    let prevPrev: Pitch | null = null;
    let lastShape = -1;
    groups.forEach((idx, q) => {
      if (idx.length === 0) return;
      const P = this.phrases[q];
      let shape = Math.floor(this.d('contour', q) * 4);
      if (shape === lastShape) shape = (shape + 1) % 4;
      lastShape = shape;
      const anchor = anchor0 + Math.round((P.energy - 0.5) * 6);
      const amp = 4 + 6 * P.energy;
      const b0 = P.bar0 * this.meter;
      const len = P.bars * this.meter;
      const contour = (beat: number): number => {
        const x = clamp((beat - b0) / len, 0, 1);
        const v =
          shape === 0
            ? 2 * sinPi(x) - 1
            : shape === 1
              ? 2 * x - 1
              : shape === 2
                ? 1 - 2 * x
                : 1 - 2 * sinPi(x);
        return anchor + 0.5 * amp * v;
      };
      const local = (i: number, j: number): number => {
        const b = blocks[i];
        const c = cands[i][j];
        if (!Number.isFinite(c.top)) return 0;
        let cost =
          0.22 * Math.abs(c.top - contour(b.beat)) +
          0.05 * Math.abs(c.d) +
          0.15 * this.d(`top-${p}`, i * 16 + j);
        const ago = byBeat.get(b.beat - len);
        if (ago !== undefined && blocks[ago].c.symbol === b.c.symbol) {
          if (cands[ago][pick[ago]].top === c.top) cost += 0.8;
        }
        const pc = mod(c.top, 12);
        const next = blocks[i + 1];
        if (!next) cost += pc === b.c.root ? -1.2 : 0;
        else if (
          this.sectionAtBeat(next.beat) !== this.sectionAtBeat(b.beat) &&
          (pc === b.c.pcs[0] || pc === b.c.pcs[1])
        )
          cost -= 0.5;
        return cost;
      };
      // Second order: (the pick before, this pick), so a line that turns straight back costs.
      const tops = (n: number): Pitch[] => cands[idx[n]].map((c) => c.top);
      const rev = (n: number): boolean => blocks[idx[n]].revoice === true;
      const turn = (a: Pitch | null, b: Pitch, c: Pitch): number => {
        if (a === null || !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c))
          return 0;
        if (a === c && b !== a) return 0.6;
        const up = b - a;
        const on = c - b;
        return up * on > 0 && Math.abs(on) <= 2 ? -0.15 : 0;
      };
      const t0 = tops(0);
      // score[h][j]: best cost with pick h at n − 1 and j at n (n = 0: h unused, one row).
      let score: number[][] = [
        t0.map(
          (c, j) =>
            local(idx[0], j) +
            (prevTop === null ? 0 : move(prevTop, c, rev(0)) + turn(prevPrev, prevTop, c)),
        ),
      ];
      const back: number[][][] = [];
      for (let n = 1; n < idx.length; n++) {
        const a = n >= 2 ? tops(n - 2) : null;
        const b = tops(n - 1);
        const c = tops(n);
        const next: number[][] = b.map(() => c.map(() => Infinity));
        const from: number[][] = b.map(() => c.map(() => 0));
        b.forEach((bt, h) => {
          c.forEach((ct, j) => {
            const m = move(bt, ct, rev(n)) + local(idx[n], j);
            score.forEach((row, g) => {
              const v = row[h] + m + turn(a ? a[g] : n === 1 ? prevTop : null, bt, ct);
              if (v < next[h][j]) {
                next[h][j] = v;
                from[h][j] = g;
              }
            });
          });
        });
        back.push(from);
        score = next;
      }
      let bh = 0;
      let bj = 0;
      score.forEach((row, h) =>
        row.forEach((v, j) => {
          if (v < score[bh][bj]) {
            bh = h;
            bj = j;
          }
        }),
      );
      for (let n = idx.length - 1; n >= 0; n--) {
        pick[idx[n]] = bj;
        if (n > 0) {
          const g = back[n - 1][bh][bj];
          bj = bh;
          bh = g;
        }
      }
      prevPrev =
        idx.length >= 2 ? cands[idx[idx.length - 2]][pick[idx[idx.length - 2]]].top : prevTop;
      prevTop = cands[idx[idx.length - 1]][pick[idx[idx.length - 1]]].top;
    });
    // Each block takes its window; a new voicing that found no new top is dropped.
    const kept: Block[] = [];
    blocks.forEach((b, i) => {
      b.reg = cands[i][pick[i]].reg;
      const prev = kept[kept.length - 1];
      if (b.revoice && prev && cands[i][pick[i]].top === cands[i - 1][pick[i - 1]].top) {
        prev.beats += b.beats;
        return;
      }
      kept.push(b);
    });
    this.blocks.set(p, kept);
  }

  // -------------------------------------------------------------------------------------------
  // Textures
  // -------------------------------------------------------------------------------------------

  /**
   * A part's texture per phrase: a backing part keeps its section's texture; the lead's follows
   * each phrase's energy, never the same for more than two phrases running when its energy band
   * offers another.
   */
  private phraseTextures(p: BlockPart): PhraseTex[] {
    let prevSig = '';
    let run = 0;
    return this.phrases.map((P, q) => {
      const s = P.section;
      if (!s.on[p]) {
        prevSig = 'off';
        run = 0;
        return { on: false, tex: null };
      }
      let tex: Tex | null;
      if (this.lead === p) {
        const opts = this.leadTextures(p, P, q);
        const w = opts.map((o) => o.w);
        let i = pickIndex(w, this.d(`lead-tex-${p}`, q));
        if (JSON.stringify(opts[i].tex) === prevSig && run >= 2 && opts.length > 1) {
          w[i] = 0;
          i = w.some((x) => x > 0) ? pickIndex(w, this.d(`lead-tex2-${p}`, q)) : i;
        }
        tex = opts[i].tex;
      } else tex = this.sectionTexture(p, s);
      const sig = JSON.stringify(tex);
      run = sig === prevSig ? run + 1 : 1;
      prevSig = sig;
      return { on: true, tex };
    });
  }

  /** Phrase textures merged into spans where they stay the same. */
  private toSpans(texs: PhraseTex[]): Span[] {
    const out: Span[] = [];
    this.phrases.forEach((P, q) => {
      const { on, tex } = texs[q];
      const from = P.bar0 * this.meter;
      const to = (P.bar0 + P.bars) * this.meter;
      const last = out[out.length - 1];
      if (
        last &&
        last.on === on &&
        JSON.stringify(last.on ? last.tex : 'off') === JSON.stringify(on ? tex : 'off')
      ) {
        last.to = to;
        last.last = P.energy;
      } else out.push({ from, to, on, tex, energy: P.energy, last: P.energy });
    });
    return out;
  }

  /**
   * Arpeggios are one texture among several (PLAN M12 listening notes, round 2): where they fill
   * more than a quarter of the piece, the quietest phrases' arpeggios become broken chords
   * (every other step a rest), so they stay where the energy rises.
   */
  private arpBudget(texs: Map<BlockPart, PhraseTex[]>): void {
    const arpAt = (q: number): boolean =>
      [...texs.values()].some((a) => a[q].on && isArp(a[q].tex, this.beat));
    let used = 0;
    const qs: number[] = [];
    this.phrases.forEach((P, q) => {
      if (!arpAt(q)) return;
      used += P.bars;
      qs.push(q);
    });
    qs.sort((a, b) => this.phrases[a].energy - this.phrases[b].energy || b - a);
    for (const q of qs) {
      if (used <= ARP_SHARE * this.allBars) break;
      for (const a of texs.values())
        if (a[q].on && isArp(a[q].tex, this.beat)) a[q] = { on: true, tex: thinned(a[q].tex!) };
      used -= this.phrases[q].bars;
    }
  }

  /**
   * A backing part's texture in a section. Chords: higher in its band, a livelier texture; one
   * draw per section label, so a section returns with its texture at the same energy. The outro
   * settles.
   */
  private sectionTexture(p: BlockPart, s: Section): Tex | null {
    if (p === 'chords') {
      const id = s.label ?? s.kind;
      const e = s.kind === 'outro' ? Math.min(s.energy, 0.4) : s.energy;
      const { opts, lo, hi } = this.chordChoices(e, `chords-${id}`, false);
      const u = clamp(0.6 * ((e - lo) / (hi - lo)) + 0.4 * this.d(`chord-tex-${id}`), 0, 0.999);
      return opts[
        pickIndex(
          opts.map((o) => o.w),
          u,
        )
      ].tex;
    }
    if (p === 'pulse') return this.pulseTexture(s.energy, `pulse-${s.label ?? s.kind}`, 0.55);
    return this.bellTexture(s, s.energy, `bells-${s.label ?? s.kind}`);
  }

  /** The textures the lead may take in a phrase, by its energy, with weights. */
  private leadTextures(p: BlockPart, P: Phrase, q: number): { tex: Tex | null; w: number }[] {
    const e = P.energy;
    if (p === 'pulse') return [{ tex: this.pulseTexture(e, `pulse-q${q}`, 0.45), w: 1 }];
    if (p === 'bells') return [{ tex: this.bellTexture(P.section, e, `bells-q${q}`), w: 1 }];
    // The outro settles.
    const ec = P.section.kind === 'outro' ? Math.min(e, 0.4) : e;
    return this.chordChoices(ec, `chords-q${q}`, true).opts;
  }

  /**
   * The Chords textures for an energy, weighted by the mood, in order of activity: held (a struck
   * sound re-strikes each bar), broken chords, breathing, arpeggios, repeated chords; and the
   * energy band they serve. Arpeggios lean on the mood (Bright and Driving like them; Dark hardly
   * ever) and rising energy, and are never the default; an unhurried piece takes nothing quicker
   * than a beat. A backing Chords part under a Pulse part moves less.
   */
  private chordChoices(
    e: number,
    tag: string,
    lead: boolean,
  ): { opts: { tex: Tex | null; w: number }[]; lo: number; hi: number } {
    const { r } = this;
    const a = r.arp;
    const busy = this.has('pulse') && !lead ? 0.4 : 1;
    const opts: { tex: Tex | null; w: number }[] = [];
    const add = (tex: Tex | null, w: number): void => {
      if (w > 0) opts.push({ tex, w });
    };
    const hold = this.struck('chords') ? { pulse: this.breathe(this.barSec) } : null;
    if (e < 0.3) {
      add(hold, 3);
      add({ pulse: this.broken(tag) }, 0.5 + 0.5 * (1 - r.pace));
      return { opts, lo: 0, hi: 0.3 };
    }
    if (e < 0.5) {
      add(hold, 1.5);
      add({ pulse: this.broken(tag) }, 1.5);
      add({ pulse: this.breathe() }, 1);
      add({ pulse: this.arp('down') }, 1.5 * a);
      return { opts, lo: 0.3, hi: 0.5 };
    }
    if (e < 0.72) {
      add(hold, 0.3);
      add({ pulse: this.broken(tag) }, 1);
      add({ pulse: this.breathe() }, 1.5);
      add({ pulse: this.arp('up') }, 1.5 * a * busy);
      add({ pulse: this.arp('updown') }, 2.5 * a * busy);
      add(this.repeated(this.d(`${tag}-floor`)), 0.6 * (0.3 + r.pace) * busy);
      return { opts, lo: 0.5, hi: 0.72 };
    }
    add({ pulse: this.broken(tag) }, 0.4);
    add({ pulse: this.breathe() }, 1);
    add({ pulse: this.arp('updown') }, 3 * a * busy);
    add(this.repeated(this.d(`${tag}-floor`)), (0.8 + 1.2 * r.pace) * busy);
    return { opts, lo: 0.72, hi: 1 };
  }

  /** All lines together, a swell every half bar (every bar in 3/4), or every `step` s. */
  private breathe(
    step = this.meter === 4 ? this.barSec / 2 : this.barSec,
  ): NonNullable<Tex['pulse']> {
    const half = this.meter === 4 && Math.abs(step - this.barSec / 2) < 1e-9;
    return {
      step: r6(step),
      pattern: half ? [1, 0.7] : [1],
      decay: r3(Math.min(1.6, step * 1.1)),
      floor: 0.5,
      mode: 'together',
      strike: this.struck('chords'),
    };
  }

  /** A sparse broken chord: one line at a time on every other beat, ringing on. */
  private broken(tag: string): NonNullable<Tex['pulse']> {
    const lv = (i: number) => [0.6, 0.7, 0.8][Math.floor(this.d(`${tag}-brk`, i) * 3)];
    const n = this.meter === 4 ? 4 : 6;
    const pattern = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : i % 2 === 0 ? lv(i) : 0));
    const step = this.beat;
    return {
      step: r6(step),
      pattern,
      decay: r3(Math.min(1.4, step * 2.2)),
      floor: 0.25,
      mode: this.d(`${tag}-brk-mode`) < 0.6 ? 'up' : 'random',
      strike: true,
    };
  }

  /** An arpeggio over the part's lines, restarting each bar (quarters when unhurried). */
  private arp(mode: PulseMode): NonNullable<Tex['pulse']> {
    const step = this.beat * (this.r.tempo > 100 || this.r.unhurried ? 1 : 0.5);
    return {
      step: r6(step),
      pattern: this.meter === 3 ? [1, 0.6, 0.75] : [1, 0.6, 0.8, 0.6],
      decay: r3(Math.min(0.6, step * 1.6)),
      floor: 0.12,
      mode,
      restart: r6(this.barSec),
      strike: true,
    };
  }

  /** Repeated chords, all lines together (unhurried: on the beat, a gentle throb). */
  private repeated(u: number): Tex {
    const slow = this.r.unhurried;
    const step = this.beat * (this.r.density > 0.75 && !slow ? 0.5 : 1);
    return {
      pulse: {
        step: r6(step),
        pattern: this.meter === 3 ? [1, 0.55, 0.7] : [1, 0.55, 0.8, 0.55],
        decay: r3(Math.min(slow ? 1.6 : 1.2, step * 1.5)),
        floor: r3((slow ? 0.6 : 0.45) + 0.15 * u),
        mode: 'together',
        strike: this.struck('chords'),
      },
    };
  }

  /**
   * Writes a part's textures, its pulse and its walk each merged over the spans where it stays
   * the same. A change staged a bar late (`staging`) moves the whole part; one staged line by
   * line goes: rising, the new figure comes in on the upper lines while the lower ones carry the
   * old one a bar longer; falling, the lower lines settle first and the top keeps the old figure
   * for that bar.
   */
  private writeTextures(p: BlockPart): void {
    const ids = this.idsOf(p);
    const n = ids.length;
    for (const kind of ['pulse', 'walk'] as const) {
      type Val = Tex[typeof kind] | null;
      const runs: {
        from: number;
        to: number;
        on: boolean;
        val: Val;
        energy: number;
        last: number;
      }[] = [];
      for (const sp of this.spans.get(p)!) {
        const val: Val = sp.on ? (sp.tex?.[kind] ?? null) : null;
        const prev = runs[runs.length - 1];
        if (prev && prev.on === sp.on && JSON.stringify(prev.val) === JSON.stringify(val)) {
          prev.to = sp.to;
          prev.last = sp.last;
        } else
          runs.push({ from: sp.from, to: sp.to, on: sp.on, val, energy: sp.energy, last: sp.last });
      }
      const fig = (v: Val): string => figureOf(v ? { [kind]: v } : null);
      const starts = runs.map((ru) => ids.map(() => ru.from));
      for (let i = 1; i < runs.length; i++) {
        const a = runs[i - 1];
        const b = runs[i];
        const how = this.stage.get(`${p}|${b.from}`);
        if (!how || !a.on || !b.on || fig(a.val) === fig(b.val)) continue;
        const by = this.hand * this.meter;
        if (how === 'late') {
          for (let l = 0; l < n; l++) starts[i][l] = b.from + by;
          continue;
        }
        if (n < 2) continue;
        const late = Math.floor(n / 2);
        const rising = b.energy >= a.last;
        for (let l = 0; l < n; l++)
          if (rising ? l < late : l >= n - late) starts[i][l] = b.from + by;
      }
      runs.forEach((ru, i) => {
        if (!ru.val) return;
        const from = starts[i];
        const to = ids.map((_, l) => (i + 1 < runs.length ? starts[i + 1][l] : ru.to));
        // One moment per stretch where the same lines play it: all of them between handovers.
        const cuts = [...new Set([...from, ...to])].sort((x, y) => x - y);
        for (let k = 0; k + 1 < cuts.length; k++) {
          const ls = ids.flatMap((_, l) => (from[l] <= cuts[k] && to[l] >= cuts[k + 1] ? [l] : []));
          if (ls.length === 0) continue;
          const target: VoiceSelector =
            ls.length === n ? this.target(p) : { voices: ls.map((l) => ids[l]) };
          const at = this.T(cuts[k]);
          const until = this.T(cuts[k + 1]);
          if (kind === 'pulse')
            this.put({
              type: 'pulse',
              at,
              target,
              until,
              ...(ru.val as NonNullable<Tex['pulse']>),
            });
          else
            this.put({ type: 'walk', at, target, until, ...(ru.val as NonNullable<Tex['walk']>) });
        }
      });
    }
  }

  /**
   * Where textures change figure, the change spreads over a bar (two when slow): part by part
   * when several parts change (rising, the highest part first, the others later; falling, the
   * lowest first), line by line when one part changes alone.
   */
  private staging(): void {
    const at = new Map<number, { p: BlockPart; e0: number; e1: number }[]>();
    for (const [p, spans] of this.spans) {
      for (let i = 1; i < spans.length; i++) {
        const a = spans[i - 1];
        const b = spans[i];
        if (!a.on || !b.on || b.to - b.from < (this.hand + 1) * this.meter) continue;
        if (figureOf(a.tex) === figureOf(b.tex)) continue;
        at.set(b.from, [...(at.get(b.from) ?? []), { p, e0: a.last, e1: b.energy }]);
      }
    }
    const high: BlockPart[] = ['bells', 'pulse', 'chords'];
    for (const [beat, list] of at) {
      if (list.length === 1) {
        this.stage.set(`${list[0].p}|${beat}`, 'lines');
        continue;
      }
      const rising = list[0].e1 >= list[0].e0;
      const order = (rising ? high : [...high].reverse()).filter((p) =>
        list.some((x) => x.p === p),
      );
      for (const p of order.slice(1)) this.stage.set(`${p}|${beat}`, 'late');
    }
  }

  /**
   * How much a texture lowers a part's loudness, undone: 1 / the RMS of one line's pulse
   * envelope (an arpeggio, one line at a time with a low floor, sits ~10 dB under held chords).
   * 1 to 1.6.
   */
  private texGain(p: BlockPart, tex: Tex | null): number {
    const pu = tex?.pulse;
    if (!pu) return 1;
    const n = this.partVoices.get(p) ?? 1;
    const all = pu.mode === 'together';
    const K = 8;
    let sum = 0;
    let cnt = 0;
    for (let l = 0; l < n; l++) {
      let a = 1;
      let t0 = -Infinity;
      for (let k = 0; k < 2 * n * pu.pattern.length; k++) {
        const acc = pu.pattern[k % pu.pattern.length];
        if (acc > 0 && (all || k % n === l)) {
          a = acc;
          t0 = k * pu.step;
        }
        for (let j = 0; j < K; j++) {
          const u = (k + j / K) * pu.step - t0;
          const fall = pu.decay > 0 && u < pu.decay ? (1 - u / pu.decay) ** 3 : 0;
          const env = a * (pu.floor + (1 - pu.floor) * fall);
          sum += env * env;
          cnt++;
        }
      }
    }
    return r3(clamp(1 / Math.sqrt(sum / cnt), 1, 1.6));
  }

  /**
   * A chord-block part's levels, phrase by phrase: its section's level times its texture's
   * `texGain`, so a texture change keeps the loudness; entries fade in, exits fade out over the
   * bar before. A change staged a bar late moves its level a bar late too.
   */
  private blockLevels(p: BlockPart, fade: Seconds): void {
    const spans = this.spans.get(p)!;
    let prev: number | null = null;
    this.phrases.forEach((P, q) => {
      const s = P.section;
      const b = P.bar0 * this.meter;
      const sp = spans.find((x) => x.from <= b && b < x.to);
      const L = s.on[p] ? r3(this.levelOf(p, s) * this.texGain(p, sp?.tex ?? null)) : null;
      if (q === 0) {
        if (L !== null) this.enter(p, 0, L, this.opening());
      } else if (L !== null && prev === null) this.enter(p, this.T(b), L, fade);
      else if (L === null && prev !== null) this.level(p, r4(this.T(b) - fade), 0, r3(fade));
      else if (L !== null && prev !== null && Math.abs(L - prev) > 0.04) {
        const late = this.stage.get(`${p}|${b}`) === 'late' ? this.hand * this.meter : 0;
        this.level(p, this.T(b + late), L, r3(this.hand * this.barSec));
      }
      prev = L;
    });
  }

  /**
   * True when the part's lines sound one at a time at `beat`, or a handover before (a staged
   * change carries the old figure that long), while it plays.
   */
  private oneAtATimeAt(p: BlockPart, beat: number): boolean {
    const back = Array.from({ length: this.hand + 1 }, (_, i) => beat - i * this.meter);
    return back.some((b) => {
      const sp = this.spans.get(p)?.find((x) => x.from <= b && b < x.to);
      return sp !== undefined && sp.on && oneAtATime(sp.tex);
    });
  }

  /**
   * Arpeggiated notes gliding through a chord change are a feature moment, not a habit: where the
   * Chords lines sound one at a time, its changes glide briefly, except at one change (two in a
   * piece of 2½ minutes or more): the liveliest phrase starts, at least 16 bars apart.
   */
  private glideFeatures(): void {
    if (!this.has('chords') || this.r.glide < 0.3) return;
    const starts = new Set(this.phrases.map((P) => P.bar0 * this.meter));
    const cands = this.blocks
      .get('chords')!
      .filter((b) => !b.open && !b.revoice && this.oneAtATimeAt('chords', b.beat))
      .map((b, i) => ({
        beat: b.beat,
        score:
          this.phrases[this.phraseAtBeat(b.beat)].energy +
          (starts.has(b.beat) ? 0.5 : 0) +
          0.1 * this.d('glide-feature', i),
      }))
      .sort((a, b) => b.score - a.score);
    const n = this.r.length >= 150 ? 2 : 1;
    for (const c of cands) {
      if (this.features.size >= n) break;
      if ([...this.features].every((f) => Math.abs(f - c.beat) >= 16 * this.meter))
        this.features.add(c.beat);
    }
  }

  /** True when the part's texture holds (no pulse) at `beat`, while it plays. */
  private holdsAt(p: BlockPart, beat: number): boolean {
    const sp = this.spans.get(p)?.find((x) => x.from <= beat && beat < x.to);
    return sp !== undefined && sp.on && sp.tex === null;
  }

  // -------------------------------------------------------------------------------------------
  // Writing the moments
  // -------------------------------------------------------------------------------------------

  private put(m: NewMoment, phase: 'structure' | 'detail' = 'structure'): NewMoment {
    if ('at' in m) (m as { at: number }).at = r4(Math.max(0, m.at));
    this.moments.push({ m, phase, order: this.order++ });
    return m;
  }

  private target(p: ComposePart): { part: string } {
    return { part: PART_NAME[p] };
  }

  /** Level of a part in a section: its energy, from 0.55 to 1. */
  private levelOf(p: ComposePart, s: Section): number {
    const base = p === 'bells' ? 0.85 : 1;
    return r3(base * (0.55 + 0.45 * s.energy));
  }

  /**
   * The glide of a chord change on part `p` at `beat`. Under Chords lines sounding one at a time
   * it is brief, but for the chosen feature changes (`glideFeatures`), which glide at least 0.5 s.
   */
  private changeGlide(p: ComposePart, beats: number, beat: number): Partial<Glide> {
    const { r } = this;
    const room = beats * this.beat * 0.6;
    let length = p === 'chords' ? r.glide : Math.min(0.2, r.glide * 0.5);
    let stagger = p === 'chords' ? r.stagger : Math.min(0.06, r.stagger);
    if (p === 'chords' && this.features.has(beat)) length = Math.max(length, 0.5);
    else if (p === 'chords' && this.oneAtATimeAt('chords', beat)) {
      length = Math.min(length, Math.max(0.08, 0.25 * this.beat));
      stagger = Math.min(stagger, 0.04);
    }
    if (length + stagger > room) {
      const k = room / (length + stagger);
      length *= k;
      stagger *= k;
    }
    return {
      length: r3(Math.max(0.06, length)),
      stagger: r3(stagger),
      jitter: p === 'chords' ? 0.15 : 0,
      land: true,
      ease: 'smootherstep',
    };
  }

  private write(): void {
    const { r } = this;
    const secs = this.sections;
    const first = secs[0];
    const c0 = first.chords[0];

    // The opening at 0:00: every part comes in on its first notes; a part that waits sits at
    // level 0 until its entry ramp.
    for (const p of r.parts) {
      if (p === 'chords' || p === 'pulse' || p === 'bells') {
        this.put({
          type: 'chord',
          at: 0,
          target: this.target(p),
          notes: { kind: 'chord', symbol: c0.symbol },
          voicing: 'close',
          register: this.blocks.get(p)![0].reg,
          assign: 'ordered',
          count: this.partVoices.get(p),
        });
      } else if (p === 'bass' && !first.on.bass) {
        this.put({
          type: 'unison',
          at: 0,
          target: this.target(p),
          pitch: this.bassRoot(c0.root, 40),
          octaves: false,
        });
      } else if (p === 'melody' && !first.on.melody) {
        const [a, b] = this.reg.melody;
        const tonic = pitchClassOfKey(first.key);
        const pitch = pitchesWithPcs([tonic], a, b)[0] ?? a;
        this.put({ type: 'unison', at: 0, target: this.target(p), pitch, octaves: false });
      }
    }
    // Levels at 0:00: everything starts at 0; what plays first fades in.
    this.put({ type: 'level', at: 0, gain: 0, over: 0 });
    // Entries and exits fade over about a bar (longer when slow, shorter when fast).
    const fade = clamp(this.barSec * this.slower, 1, 3 * this.slower);
    const block = (p: ComposePart): p is BlockPart =>
      (BLOCK_PARTS as readonly string[]).includes(p);
    for (const p of r.parts) {
      if (first.on[p] && !block(p)) this.enter(p, 0, this.levelOf(p, first), this.opening());
    }
    this.flushLevels();

    secs.forEach((s, si) => {
      const prev = si > 0 ? secs[si - 1] : null;
      const start = s.bar0 * this.meter;
      if (prev && prev.key.tonic !== s.key.tonic) {
        this.put({ type: 'key', at: this.T(start), key: s.key });
      }
      // Levels: entries fade in from the section's start, exits fade out over the bar before; a
      // part that plays on moves to its new level over a bar. (Chord-block parts: `blockLevels`.)
      if (prev) {
        for (const p of r.parts) {
          if (block(p)) continue;
          const was = prev.on[p];
          const L = this.levelOf(p, s);
          if (s.on[p] && !was) this.enter(p, this.T(start), L, fade);
          else if (s.on[p] && Math.abs(L - this.levelOf(p, prev)) > 0.04)
            this.level(p, this.T(start), L, r3(this.hand * this.barSec));
          else if (!s.on[p] && was) this.level(p, r4(this.T(start) - fade), 0, r3(fade));
        }
      }
    });
    for (const p of BLOCK_PARTS) if (this.has(p)) this.blockLevels(p, fade);
    this.flushLevels();

    // Chord blocks, then textures, for each harmonic part.
    for (const p of BLOCK_PARTS) {
      if (!this.has(p)) continue;
      for (const b of this.blocks.get(p)!) {
        if (b.open) continue;
        this.put({
          type: 'chord',
          at: this.T(b.beat),
          target: this.target(p),
          notes: { kind: 'chord', symbol: b.c.symbol },
          voicing: 'close',
          register: b.reg,
          assign: 'ordered',
          glide: this.changeGlide(p, b.revoice ? b.beats : b.c.beats, b.beat),
        });
      }
      this.writeTextures(p);
    }

    let bassLast = 40;
    let melodyLast: Pitch | undefined;
    const themes = new Map<string, number>();
    secs.forEach((s, si) => {
      const prev = si > 0 ? secs[si - 1] : null;
      const next = si + 1 < secs.length ? secs[si + 1] : null;
      const start = s.bar0 * this.meter;
      const end = start + s.bars * this.meter;
      if (this.has('bass') && s.on.bass) bassLast = this.bassLine(s, start, prev, bassLast, next);
      if (this.has('melody') && s.on.melody) {
        const rest = !next || !next.on.melody;
        melodyLast = this.melody(s, start, end, rest, melodyLast, themes);
      }
    });
  }

  /** The opening fade-in, s: two bars, 2–5 s at medium speed. */
  private opening(): Seconds {
    return r3(clamp(2 * this.barSec * this.slower, 2, 5 * this.slower));
  }

  /** True when the part's sound is struck and dies away (pluck, piano, mallets, bells). */
  private struck(p: ComposePart): boolean {
    return STRUCK.has(this.r.sounds[p]);
  }

  /** A part's entry at `at`: a fade from silence (a struck sound from 40 %, so its first hit sounds). */
  private enter(p: ComposePart, at: Seconds, gain: number, over: Seconds): void {
    if (this.struck(p)) this.level(p, at, r3(0.4 * gain), 0);
    this.level(p, at, gain, r3(over));
  }

  /** Level moves, batched: parts moving to the same level at the same time share a moment. */
  private levels = new Map<string, { at: Seconds; gain: number; over: Seconds; ps: string[] }>();
  private level(p: ComposePart, at: Seconds, gain: number, over: Seconds): void {
    const k = `${at}|${gain}|${over}`;
    const m = this.levels.get(k) ?? { at, gain, over, ps: [] };
    m.ps.push(PART_NAME[p]);
    this.levels.set(k, m);
  }

  private flushLevels(): void {
    for (const m of this.levels.values())
      this.put({
        type: 'level',
        at: m.at,
        target: m.ps.length === 1 ? { part: m.ps[0] } : { parts: m.ps },
        gain: m.gain,
        over: m.over,
      });
    this.levels.clear();
  }

  /** A seeded accent pattern of `n` steps: the first a downbeat, rests by density. */
  private accents(n: number, tag: string, rests: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        out.push(1);
        continue;
      }
      const u = this.d(`${tag}-acc`, i);
      const onBeat = i % 2 === 0;
      if (u < rests * (onBeat ? 0.5 : 1)) out.push(0);
      else out.push([0.45, 0.6, 0.8][Math.floor(this.d(`${tag}-lvl`, i) * 3)]);
    }
    return out;
  }

  /**
   * A seeded level gate over the Pulse lines, with a walk inside when it's lively. Mostly all
   * lines together (a level-gate rhythm); one at a time now and then. Unhurried: on the beat (every
   * other beat when quiet), soft and long, with a slow walk.
   */
  private pulseTexture(e: number, tag: string, walkFrom: number): Tex {
    const { d, r } = this;
    const slow = r.unhurried;
    const fast = !slow && r.density > 0.8 && r.tempo < 112 && e > 0.6;
    const step = this.beat * (fast ? 0.25 : slow ? (e < 0.45 && this.meter === 4 ? 2 : 1) : 0.5);
    const n = Math.round(this.barSec / step);
    const modes: PulseMode[] = ['together', 'random', 'up', 'updown'];
    const mode =
      modes[pickIndex(slow ? [0.55, 0.3, 0.15, 0] : [0.35, 0.2, 0.25, 0.2], d(`${tag}-mode`))];
    const tex: Tex = {
      pulse: {
        step: r6(step),
        // Unhurried, one line at a time is a broken chord: every other step rests.
        pattern: this.accents(n, tag, 0.35 * (1 - r.density) + (slow ? 0.15 : 0)).map((x, i) =>
          slow && mode !== 'together' && i % 2 === 1 ? 0 : x,
        ),
        decay: slow
          ? r3(clamp(step * (0.8 + 1.2 * d(`${tag}-decay`)), 0.3, 1.2))
          : r3(clamp(step * (1.2 + 1.5 * d(`${tag}-decay`)), 0.1, 0.45)),
        floor: r3((slow ? 0.1 : 0.04) + 0.1 * d(`${tag}-floor`)),
        mode,
        ...(mode === 'up' || mode === 'updown' ? { restart: r6(this.barSec) } : {}),
        strike: true,
      },
    };
    // Level-gate rhythm with a walk inside, when it's lively.
    if (e > walkFrom + (slow ? 0.15 : 0)) {
      tex.walk = {
        grid: r6(this.beat * (slow ? 2 : 1)),
        density: r3(0.25 + 0.35 * r.density),
        steps: [-1, 1],
        stepGlide: 0.04,
        over: 'chord',
        glide: { stagger: 0, jitter: 0, ease: 'smoothstep' },
      };
    }
    return tex;
  }

  /** Sparse struck bells, with a slow walk over the chord. */
  private bellTexture(s: Section, e: number, tag: string): Tex {
    const { d, r } = this;
    const quick = !r.unhurried && e >= 0.6 && r.density > 0.5;
    const step = this.beat * (quick ? 0.5 : 1);
    const n = Math.round((2 * this.barSec) / step);
    const pattern: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = d(`${tag}-hit`, i);
      pattern.push(
        i === 0
          ? 1
          : r.unhurried && i % 2 === 1
            ? 0
            : u < 0.35 + 0.3 * r.density
              ? [0.5, 0.7, 0.85][Math.floor(d(`${tag}-lvl`, i) * 3)]
              : 0,
      );
    }
    const modes: PulseMode[] = ['random', 'up', 'down'];
    const tex: Tex = {
      pulse: {
        step: r6(step),
        pattern,
        decay: r3(1.2 + 1.3 * d(`${tag}-decay`)),
        floor: 0,
        mode: modes[Math.floor(d(`${tag}-mode`) * 3)],
        strike: true,
      },
    };
    if (s.kind === 'body' || e > 0.3) {
      tex.walk = {
        grid: r6(this.beat * (quick ? 1 : 2)),
        density: r3(0.3 + 0.25 * d(`${tag}-walk`)),
        steps: [-1, 1, -2, 2],
        stepGlide: 0.05,
        over: 'chord',
        glide: { stagger: 0, jitter: 0, ease: 'smoothstep' },
      };
    }
    return tex;
  }

  /** The root pitch class in the bass register, nearest `near`. */
  private bassRoot(pc: number, near: Pitch): Pitch {
    const [lo, hi] = this.reg.bass;
    const cands = pitchesWithPcs([pc], lo, hi);
    let best = cands[0] ?? lo;
    for (const p of cands) if (Math.abs(p - near) < Math.abs(best - near)) best = p;
    // Drift back toward the middle of the register.
    if (Math.abs(best - 40) > 7) {
      for (const p of cands) if (Math.abs(p - 40) < Math.abs(best - 40)) best = p;
    }
    return best;
  }

  /** The bass's pattern for an energy (a draw `u` picks among the fitting ones). */
  private bassPattern(e: number, outro: boolean, u: number): BassPattern {
    const { r } = this;
    // Unhurried: held roots, fifths and root–fifth–octave; no walking or driving.
    if (r.unhurried)
      return outro || e < 0.4
        ? 'hold'
        : e < 0.7
          ? u < 0.6
            ? 'halves'
            : 'hold'
          : u < 0.6
            ? 'rfo'
            : 'halves';
    return outro || e < 0.35
      ? 'hold'
      : e < 0.55
        ? u < 0.5
          ? 'halves'
          : 'rfo'
        : e < 0.75
          ? u < 0.55
            ? 'rfo'
            : 'walk'
          : r.density > 0.6 && u < 0.6
            ? 'drive'
            : u < 0.5
              ? 'walk'
              : 'rfo';
  }

  /** The leading bass's pattern per phrase: by energy, never the same two phrases running. */
  private leadBass: BassPattern[] | null = null;
  private leadBassAt(beat: number): BassPattern {
    if (!this.leadBass) {
      let prev: BassPattern | null = null;
      this.leadBass = this.phrases.map((P, q) => {
        const e = P.energy;
        const opts: BassPattern[] =
          P.section.kind === 'outro'
            ? ['hold']
            : this.r.unhurried
              ? e < 0.45
                ? ['hold', 'halves']
                : ['halves', 'rfo', 'hold']
              : e < 0.35
                ? ['hold', 'halves']
                : e < 0.55
                  ? ['halves', 'rfo', 'walk']
                  : e < 0.75
                    ? ['rfo', 'walk']
                    : ['walk', 'drive', 'rfo'];
        let i = Math.floor(this.d('lead-bass', q) * opts.length);
        if (opts[i] === prev && opts.length > 1) i = (i + 1) % opts.length;
        prev = opts[i];
        return opts[i];
      });
    }
    return this.leadBass[this.phraseAtBeat(beat)];
  }

  /**
   * The bass's tune for a section: the root on every chord change, a pattern between. A new
   * pattern comes in a handover late (the bass carries the old figure across the boundary); the
   * leading bass changes pattern phrase by phrase.
   */
  private bassLine(
    s: Section,
    start: number,
    prev: Section | null,
    near: Pitch,
    next: Section | null,
  ): Pitch {
    const { d, meter } = this;
    const own = this.bassPattern(s.energy, s.kind === 'outro', d(`bass-pat-${s.label ?? s.kind}`));
    this.bassPats.set(s.name, own);
    const was = prev?.on.bass ? this.bassPats.get(prev.name) : undefined;
    const patAt = (beat: number): BassPattern =>
      this.lead === 'bass'
        ? this.leadBassAt(beat)
        : was !== undefined && was !== own && beat < start + this.hand * meter
          ? was
          : own;
    const notes: { pitch: number | null; beats: number }[] = [];
    let last = near;
    s.chords.forEach((c, ci) => {
      const pat = patAt(c.beat);
      const root = this.bassRoot(c.root, last);
      last = root;
      const nb = c.beats;
      const hi = this.reg.bass[1];
      const fifth = root + 7 <= hi ? root + 7 : root - 5;
      const oct = root + 12 <= hi + 2 ? root + 12 : root;
      const following = s.chords[ci + 1] ?? next?.chords[0] ?? null;
      const push = (pitch: number, beats: number): void => {
        if (beats > 0) notes.push({ pitch, beats });
      };
      if (pat === 'hold' || nb < 2) push(root, nb);
      else if (pat === 'halves') {
        const a = Math.ceil(nb / 2);
        push(root, a);
        push(fifth, nb - a);
      } else if (pat === 'rfo') {
        for (let b = 0; b < nb; b += meter) {
          const len = Math.min(meter, nb - b);
          if (len < meter) push(root, len);
          else if (meter === 3) {
            push(root, 2);
            push(fifth, 1);
          } else {
            push(root, 2);
            push(fifth, 1);
            push(oct, 1);
          }
        }
      } else if (pat === 'walk') {
        const tones = pitchesWithPcs(c.pcs, root - 7, root + 12).filter(
          (p) => p !== root && p >= this.reg.bass[0] - 3 && p <= this.reg.bass[1] + 2,
        );
        for (let b = 0; b < nb; b++) {
          if (b === 0) push(root, 1);
          else if (b === nb - 1 && following) {
            const to = this.bassRoot(following.root, root);
            const by = to >= root ? -1 : 1;
            push(stepByScale(to, by, c.key) === to ? to + by : stepByScale(to, by, c.key), 1);
          } else
            push(tones[Math.floor(d('bass-walk', start + b + ci * 16) * tones.length)] ?? root, 1);
        }
      } else {
        // Drive: eighths on the root, the octave on the off-beats of 2 and 4.
        for (let b = 0; b < nb * 2; b++) push(b % 4 === 3 ? oct : root, 0.5);
      }
    });
    // Merge held repeats only for 'hold' (the others re-strike on purpose).
    this.put({
      type: 'tune',
      at: this.T(start),
      target: this.target('bass'),
      notes: this.tuneNotes(notes),
      glide: { length: r3(Math.min(0.16, this.beat * 0.25)), land: true, ease: 'smoothstep' },
    });
    return last;
  }

  /**
   * Tune notes from beat lengths. Equal lengths are equal numbers (short share links); the
   * rounding drifts under a millisecond over a section's tune.
   */
  private tuneNotes(notes: { pitch: number | null; beats: number }[]): TuneNote[] {
    const out: TuneNote[] = [];
    for (const n of notes) {
      const len = r6(n.beats * this.beat);
      if (len <= 0) continue;
      out.push(n.pitch === null ? { rest: true, len } : { pitch: n.pitch, len });
    }
    return out;
  }

  private melody(
    s: Section,
    start: number,
    end: number,
    rest: boolean,
    near: Pitch | undefined,
    themes: Map<string, number>,
  ): Pitch | undefined {
    const { r } = this;
    const glide = {
      length: r3(clamp(this.beat * 0.15, 0.05, 0.12)),
      land: true,
      ease: 'smoothstep' as const,
    };
    if (r.melody && s.label === 'A') {
      // The given melody, kept as it is: its notes, gaps as rests.
      const notes: TuneNote[] = [];
      const t0 = r.melody[0].at;
      r.melody.forEach((n, i) => {
        const nx = r.melody![i + 1];
        const len = nx ? Math.min(n.dur, nx.at - n.at) : n.dur;
        if (len > 0) notes.push({ pitch: n.pitch, len: r6(len) });
        if (nx && nx.at - n.at - len > 1e-6)
          notes.push({ rest: true, len: r6(nx.at - n.at - len) });
      });
      const used = r.melody[r.melody.length - 1].at + r.melody[r.melody.length - 1].dur - t0;
      const left = r6(this.T(end) - this.T(start) - used);
      if (left > 1e-3) notes.push({ rest: true, len: left });
      this.put({ type: 'tune', at: this.T(start), target: this.target('melody'), notes, glide });
      return r.melody[r.melody.length - 1].pitch;
    }
    const to = rest ? end - 1 : end;
    const chords: MelodyChord[] = s.chords
      .filter((c) => c.beat < to)
      .map((c) => ({ t: this.T(c.beat), pcs: c.pcs, bass: c.root }));
    const keys: KeyChange[] = [{ t: 0, key: s.key }];
    // A theme returns with its section label (the same seed, the same chords: the same tune);
    // from its third time on, now and then a variation.
    const id = `${s.label}|${s.bars}|${s.key.tonic}`;
    const times = (themes.get(`${id}|n`) ?? 0) + 1;
    themes.set(`${id}|n`, times);
    const fresh = times >= 3 && this.d(`theme-vary-${s.name}`) < 0.5;
    const seed =
      !fresh && themes.has(id)
        ? themes.get(id)!
        : mix32(r.seed, themes.size, 0x6d65, Purpose.Melody);
    if (!themes.has(id)) themes.set(id, seed);
    const fitted = fitMelody({
      seed,
      from: this.T(start),
      to: this.T(to),
      chords,
      keys,
      beat: this.beat,
      meter: this.meter,
      register: this.reg.melody,
      start: near,
      slow: r.unhurried,
    });
    if (fitted.length === 0) return near;
    const notes: TuneNote[] = fitted.map((n) => ({ pitch: n.pitch, len: n.len }));
    if (rest) notes.push({ rest: true, len: r6(this.T(end) - this.T(to)) });
    this.put({ type: 'tune', at: this.T(start), target: this.target('melody'), notes, glide });
    return fitted[fitted.length - 1].pitch;
  }

  // -------------------------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------------------------

  private base(): Piece {
    const { r } = this;
    const voices = this.voices;
    const mix = defaultMix();
    const delayBeats = this.d('delay') < 0.5 ? 0.75 : 1;
    mix.delay = {
      ...mix.delay,
      time: r4(this.beat * delayBeats),
      feedback: 0.3,
      returnLevel: 0.14,
    };
    const big = r.mood.dreamy + r.mood.calm;
    mix.reverb = {
      ...mix.reverb,
      size: r3(0.65 + 0.2 * big),
      decay: r3(2.8 + 1.8 * big),
      returnLevel: 0.32,
    };
    const total = this.sections.reduce((a, s) => a + s.bars, 0);
    const at = r3(this.T(total * this.meter));
    return {
      format: PIECE_FORMAT,
      version: PIECE_VERSION,
      meta: { title: composedTitle(r), created: this.now, modified: this.now },
      seed: r.seed,
      tuning: { referenceHz: 440, system: { kind: '12tet' } },
      key: keyOf(r.key.tonic, r.key.mode),
      defaults: { glide: defaultGlide() },
      voices,
      moments: [],
      timbres: builtinTimbresFor(voices),
      mix,
      end: { at, fade: r3(clamp(2 * this.barSec * this.slower, 3, 8)) },
      view: { ...defaultView(), gridBpm: r.tempo, meter: this.meter },
    };
  }

  private sectionAt(t: Seconds): Section {
    let s = this.sections[0];
    for (const x of this.sections) if (this.T(x.bar0 * this.meter) <= t + 1e-6) s = x;
    return s;
  }

  private steps(): Composition<string> {
    const base = canonicalPiece(this.base());
    // Ids count up from a seeded prefix: unique, and share links omit them (app/share v2).
    const prefix = base62Id(mix32(this.r.seed, 0, 0, Purpose.ComposeId)).slice(0, 2);
    let k = 0;
    const id = (): string => `${prefix}${String(++k).padStart(4, '0')}`;
    const sorted = this.moments
      .filter((x) => x.phase === 'structure')
      // At equal times a key change comes first and a level after the notes it acts on.
      .sort(
        (a, b) =>
          a.m.at - b.m.at ||
          Number(b.m.type === 'key') - Number(a.m.type === 'key') ||
          Number(a.m.type === 'level') - Number(b.m.type === 'level') ||
          a.order - b.order,
      );
    const steps: ComposeStep<string>[] = [];
    const labelled = new Set<string>();
    for (const { m } of sorted) {
      const s = this.sectionAt(m.at);
      const moment = canonicalMoment({ id: id(), ...m } as Moment);
      if (!labelled.has(s.name) && m.type !== 'level') {
        labelled.add(s.name);
        moment.label = s.name;
      }
      steps.push({ kind: 'add', moment, section: s.name, phase: 'structure' });
    }
    // Detail (optional): upper neighbours on held chords, one left-to-right sweep.
    const structure = composedPiece({ base, steps, sections: [] });
    for (const m of this.details(structure)) {
      const moment = canonicalMoment({ id: id(), ...m } as Moment);
      steps.push({ kind: 'add', moment, section: this.sectionAt(m.at).name, phase: 'detail' });
    }
    const sections: GeneratedSection<string>[] = this.sections.map((s) => ({
      name: s.name,
      at: r3(this.T(s.bar0 * this.meter)),
    }));
    return { base, steps, sections };
  }

  /**
   * Neighbour notes on the Chords part's top line, only where they help: a long chord held
   * still (no texture, no tune over it) in a quiet section. Often none. The leading Chords part's
   * top line already moves, so it gets none.
   */
  private details(piece: Piece): NewMoment[] {
    if (!this.has('chords') || this.lead === 'chords') return [];
    const score = compile(piece);
    const chordVoices = score.voices.filter((v) => v.part === PART_NAME.chords);
    const out: NewMoment[] = [];
    let n = 0;
    for (const s of this.sections) {
      if (!s.on.chords || s.on.melody || s.energy >= 0.5 || out.length >= 4) continue;
      s.chords.forEach((c, ci) => {
        if (out.length >= 4 || c.beats < 2 * this.meter || !this.holdsAt('chords', c.beat + 1))
          return;
        if (this.d('detail', n++) > 0.5 || ci % 2 === 1) return;
        const at = this.T(c.beat + 1);
        const back = r3(this.beat);
        const pitches = chordVoices
          .map((v) => pitchAt(v, at))
          .filter((p): p is number => p !== null && Number.isFinite(p));
        if (pitches.length === 0) return;
        const top = Math.round(Math.max(...pitches));
        const to = stepByScale(top, 1, c.key);
        if (pitches.some((p) => Math.round(p) === to) || to > this.reg.chords[1] + 4) return;
        // Its glides done well before the next chord.
        if (this.T(c.beat + 1) + 0.3 + this.beat + 0.6 > this.T(c.beat + c.beats) - 0.4) return;
        out.push({
          type: 'note',
          at,
          target: this.target('chords'),
          from: top,
          to,
          back,
          glide: { length: r3(Math.min(0.3, this.beat * 0.4)), stagger: 0, jitter: 0 },
        });
      });
    }
    return out.sort((a, b) => a.at - b.at);
  }
}

function pitchClassOfKey(key: Key): number {
  return pitchClassOf(key.tonic);
}
