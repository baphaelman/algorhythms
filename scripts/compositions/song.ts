/**
 * Beat-grid helpers for the bundled compositions (docs/composing.md §1). Ported from the owner's
 * Python generators (renders/demos-2026-11-20/songs/generators/song.py) to revision 9: parts,
 * `tune`, `pulse` and `glide.land` replace the hundreds of `pin` and `level` moments.
 *
 * The songs start on bar 1 at t = 0 (the Python lead-ins are gone) so `view.gridBpm` and
 * `view.meter` line up with the music and Snap to beats works.
 */
type Json = Record<string, unknown>;
export type Target =
  { part: string } | { voices: string[] } | { rank: [number, number] } | undefined;

const r3 = (x: number): number => Math.round(x * 1e3) / 1e3;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export interface VoiceSpec {
  part: string;
  timbre: string;
  range: [number, number];
  gain: number;
  pan: number;
  sends?: { reverb?: number; delay?: number };
}

/** A pitch (MIDI) held for some beats; consecutive equal pitches are one held note. */
export type Note = [pitch: number, beats: number];

/** Notes written `pitch:beats`, space-separated; `|` marks bar lines and is ignored. */
export function notes(text: string): Note[] {
  return text
    .split(/[\s|]+/)
    .filter((t) => t !== '')
    .map((t) => {
      const [p, b] = t.split(':').map(Number);
      return [p, b];
    });
}

export class Song {
  readonly voices: Json[] = [];
  readonly moments: Json[] = [];
  readonly mix: Json = {
    reverb: { size: 0.75, decay: 3.5, damping: 0.45, preDelay: 0.02, returnLevel: 0.35 },
    delay: { time: 0.375, feedback: 0.35, returnLevel: 0 },
    sends: { reverb: 0.5, delay: 0.25 },
    tone: { tilt: 0, lowpassHz: 20000 },
    limiter: { ceilingDb: -1 },
    panAuto: 'index',
  };
  end: Json = { fade: 6 };
  readonly beat: number;

  constructor(
    readonly title: string,
    /** Two characters that start the moment ids. */
    readonly code: string,
    readonly seed: number,
    readonly key: { tonic: string; scale: string },
    readonly bpm: number,
    readonly meter: number,
  ) {
    this.beat = 60 / bpm;
  }

  /** Adds a voice; returns its id (v1, v2, …). */
  voice(s: VoiceSpec): string {
    const id = `v${this.voices.length + 1}`;
    this.voices.push({
      id,
      part: s.part,
      timbre: s.timbre,
      pan: s.pan,
      gain: r4(s.gain),
      range: s.range,
      ...(s.sends ? { sends: s.sends } : {}),
    });
    return id;
  }

  /** Time of a bar and beat (both 0-based). */
  T(bar: number, beat = 0): number {
    return r4((bar * this.meter + beat) * this.beat);
  }

  /**
   * Adds a moment (at clamped to ≥ 0, rounded to 1 ms). `id` keeps an old moment's seed; the
   * others are numbered in time order by `toJson` (`<code>0001`…: 6 base62 characters, and
   * far shorter in a share link than random ids).
   */
  m(type: string, at: number, fields: Json = {}, id?: string): Json {
    const { label, ...rest } = fields;
    const d: Json = { id: id ?? '', type, at: r3(Math.max(0, at)), ...rest };
    if (label !== undefined) d.label = label;
    this.moments.push(d);
    return d;
  }

  /** Ramps the target's level to `gain` over `over` s. */
  level(at: number, target: Target, gain: number, over: number, label?: string): Json {
    return this.m('level', at, {
      ...(target ? { target } : {}),
      gain: r4(gain),
      over: r4(over),
      label,
    });
  }

  /**
   * Chord changes that land on their downbeats (`glide.land`). `seq`: (pitches, beats). A chord
   * equal to the one before it is skipped unless it carries a label.
   */
  chords(
    part: string,
    bar0: number,
    seq: [readonly number[], number][],
    glide: Json,
    label?: string,
  ): void {
    let b = 0;
    seq.forEach(([ps, beats], i) => {
      const lab = i === 0 ? label : undefined;
      const same = this.lastChord.get(part)?.join() === ps.join();
      if (!same || lab !== undefined) {
        this.m('chord', this.T(bar0, b), {
          target: { part },
          notes: { kind: 'pitches', pitches: [...ps] },
          assign: 'ordered',
          glide: { ...glide, land: true },
          label: lab,
        });
      }
      this.lastChord.set(part, ps);
      b += beats;
    });
  }
  readonly lastChord = new Map<string, readonly number[]>();

  /** A `tune` on `part` from bar0, starting `early` s ahead of the beat (as the old pins did). */
  tune(
    part: string,
    bar0: number,
    seq: Note[] | string,
    glide: Json,
    early: number,
    label?: string,
  ): Json {
    if (typeof seq === 'string') seq = notes(seq);
    const out: { pitch: number; len: number }[] = [];
    let beats = 0;
    for (const [pitch, b] of seq) {
      const last = out[out.length - 1];
      if (last && last.pitch === pitch) beats += b;
      else {
        if (last) last.len = r4(beats * this.beat);
        out.push({ pitch, len: 0 });
        beats = b;
      }
    }
    out[out.length - 1].len = r4(beats * this.beat);
    // A tune that would start before 0 starts at 0 with its first note shortened, so the
    // later notes keep their times.
    const at = this.T(bar0) - early;
    if (at < 0) out[0].len = r4(out[0].len + at);
    return this.m('tune', at, {
      target: { part },
      notes: out,
      glide,
      label,
    });
  }

  /** A repeating accent pattern from bar0 for `bars` bars, one hit per `step` beats. */
  pulse(target: Target, bar0: number, bars: number, step: number, p: Json, label?: string): Json {
    return this.m('pulse', this.T(bar0), {
      target,
      until: r3(this.T(bar0 + bars)),
      step: r6(step * this.beat),
      ...p,
      label,
    });
  }

  toJson(): Json {
    const moments = this.moments
      .map((m, i) => ({ m, i }))
      .sort((a, b) => (a.m.at as number) - (b.m.at as number) || a.i - b.i)
      .map(({ m }) => m);
    let n = 0;
    for (const m of moments) if (m.id === '') m.id = `${this.code}${String(++n).padStart(4, '0')}`;
    return {
      format: 'algorhythms',
      version: 2,
      meta: {
        title: this.title,
        author: 'AlgoRhythms examples',
        created: '2026-11-20T00:00:00.000Z',
        modified: '2026-11-21T00:00:00.000Z',
        license: 'CC0-1.0',
      },
      seed: this.seed,
      tuning: { referenceHz: 440, system: { kind: '12tet' } },
      key: this.key,
      defaults: {
        glide: {
          length: 3,
          jitter: 0.2,
          stagger: 0.8,
          arrive: 'together',
          order: 'random',
          ease: 'smootherstep',
        },
      },
      voices: this.voices,
      moments,
      mix: this.mix,
      end: this.end,
      view: { window: 20, colors: 'pitch', hud: true, gridBpm: this.bpm, meter: this.meter },
    };
  }
}

/** The opening chord: every voice on its own pitch (as the version 1 `start` migrated). */
export function start(song: Song, pitches: number[]): void {
  song.m(
    'chord',
    0,
    { notes: { kind: 'pitches', pitches }, voicing: 'even', assign: 'ordered', byVoice: true },
    'start0',
  );
}
