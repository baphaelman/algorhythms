# AlgoRhythms: Project Plan

**Status:** revision 2, approved by the owner on 2026-11-19 (answers in §16). Implementation is under way, milestone by milestone (§15). The project is named **AlgoRhythms**.
**Date:** 2026-11-19 (revision 2: 2026-11-19)
**Audience:** an engineer or agent reviewing this plan before implementation starts.

---

## 0. How to review this document

This is a plan, not a spec that has been tested. The owner's decisions in §2 are fixed unless you find a strong technical reason against one; say so explicitly if you do. Everything else is the author's proposal and open to challenge.

The most useful feedback is concrete:
- contradictions between sections;
- missing pieces a builder would hit;
- technical assumptions that are wrong (browser APIs, audio DSP, MIDI);
- risks that are underestimated;
- scope that doesn't serve the goals in §1.

Please propose a fix with each problem. §17 lists the reviewer questions, with the first review's resolutions and the questions still open. §18 is the changelog, so a second reviewer can focus on what is new.

---

## 1. What AlgoRhythms is

AlgoRhythms is a free, open-source website that is both an **instrument** and a **composer** for pitch-line music. A set of voices glide continuously between pitches. They are drawn as lines, with time on the x-axis and pitch on the y-axis. The picture and the sound come from the same data, so the lines on screen are exactly the pitches you hear.

You compose by placing **moments** on a timeline, for example:
- "all voices to unison"
- "split into five voices"
- "move to D minor 9"
- "shift everything up a fourth"
- "walk freely for 8 seconds"

The engine works out every voice's path from those moments. You can also play it live from a computer keyboard or a MIDI controller.

**Inspiration.** The YouTube video *"Listen to this algorithm · Nebula"* (channel: Bounce Gravity, published 2026-10-24) shows this technique. Commenters asked for the software, and the creator has not responded. AlgoRhythms is an independent implementation of the general technique; §13 sets out the attribution rules.

### Goals
- **G1 Instrument quality.** Pleasant timbres, expressive glides, and no clicks, so that it's worth playing for its own sake.
- **G2 Easy composition.** Moments can be placed, dragged and edited on a timeline, and notes, chords and timbre are chosen with simple controls.
- **G3 Sound and visuals together** at all times on the website.
- **G4 Audio out.** A WAV mix, per-voice stems, and MIDI to take into a DAW.
- **G5 Maximum accessibility.** Free, no install, no account, open source under a permissive license.

### Non-goals for v1
- DAW plugins (VST3/AU/CLAP). The owner has scrapped these.
- A native or desktop app.
- Video export. It moves to "Later" because it is low priority to the owner.
- Accounts, a backend, cloud storage, or real-time collaboration.
- Exporting standard music notation.
- Editing on phones. Phones get playback and view controls only.

---

## 2. Decisions

| # | Decision | Source | Rationale / notes |
|---|---|---|---|
| D1 | Website only. No plugin. | Owner | Everything ships in the browser. MIDI and stem export are the bridge into DAWs. |
| D2 | **TypeScript everywhere. No Rust or WASM.** | Owner said to drop Rust if it didn't make sense; author recommends dropping it | Rust paid off only for a native plugin. In the browser, a TypeScript DSP in an AudioWorklet handles ≤32 voices comfortably (§8.9). One language and toolchain lowers the build and maintenance burden. A WASM DSP module could replace the TS one later behind the same interface if profiling demands it. |
| D3 | Music before video. | Owner | It sets the order of milestones (§15). |
| D4 | Audio export is high priority; video export is low. | Owner | |
| D5 | Sound and visuals are always together on the site. | Owner | The score view (the lines) is the main UI surface, not an optional visualizer. |
| D6 | The name is **AlgoRhythms**. | Owner | Plural, everywhere. The owner proceeds even if the name is taken elsewhere (§16). |
| D7 | License: **MIT**. | Author, based on the owner's priority of being "most easily accessible" | Confirmed by the owner (§16). There are no copyleft constraints now that the plugin is gone. The owner does not expect outside contributors. |
| D8 | Static site with no backend. | Author | Pieces are small JSON documents (§5), so local storage and share-by-URL are enough. |
| D9 | The model's time unit is seconds. A BPM grid is optional and used only for snapping. | Owner | Confirmed (§16). |
| D10 | React + Vite + Zustand for the UI. | Author, open | The reviewer is invited to challenge this (§17). |

---

## 3. Starting point: the prototype

**File:** `prototype/glissando-score.html`. It was published as a claude.ai artifact (a private link that only the owner can open). It is an HTML fragment because the host adds `<html>`/`<head>`; it still runs if opened locally.

### What it does
- It generates a roughly 150-second, 12-voice piece from a seed and a mode (Dorian, Aeolian, Lydian or Pentatonic). The piece has eight sections, which are hard-coded in `compose()`.
- It plays the piece through Web Audio, with one oscillator per voice and a frequency and gain curve for each, using `AudioParam.setValueCurveAtTime`.
- It draws the lines on a canvas with:
  - a follow camera and a fixed playhead;
  - Hz labels, with ×N for doubled voices;
  - rings on voices that are moving;
  - an octave grid, section markers and a HUD (on-screen text overlay).
- It eases into a whole-score overview at the start and end.
- Controls: play, pause and resume, a scrub bar, a time-window slider (4 s to the whole piece, also by pinch or keys), line colors (ink, per voice, or by pitch), new seed, and mode.

### Code worth reusing (by function name)
- `assign(p, q)`: an order-preserving dynamic program (DP) that matches *a* sorted voices to *k ≥ a* sorted targets with minimum total movement.
- `retarget(t, targets, o)`: voice leading plus births. A new voice forks from its nearest parent **at the moment the parent starts moving**, so the branch stays attached to the line.
- Smootherstep easing applied in pitch space (MIDI note numbers), not in Hz.
- The Walk algorithm: each beat a random subset of voices steps one or two scale degrees, and a step is taken only if the voice stays strictly between its neighbours. The bass leaps 5–12 semitones.
- The camera blend in `draw()`: log-interpolated pixels-per-second between the follow and overview cameras, and a user window that eases into the overview as it approaches the whole piece.
- The scrubbing UX: silent while dragging, then resume on release if it was playing.
- The fixed per-voice detune (`osc.detune`, about ±1.5–4 cents by voice index). In the prototype it makes converged voices beat. We keep it as per-voice colour; the unison lock (§8.4) now makes converged voices steady, and the beating is the opt-in `wobble` setting.

Note that the prototype's random stagger and durations already let lines cross mid-glide; §7.2 defines what the real compiler guarantees.

### Prototype limitations the real design must fix
1. **One random stream.** Changing anything early reshuffles everything that follows.
2. **Moves are queued.** A move waits until the voice's previous glide ends, so there is no interruption or retargeting mid-glide.
3. **Curves are baked into 100 Hz arrays.** A hold costs as much as a glide, which is wasteful for editing and long pieces.
4. **`setValueCurveAtTime` has no hot-swap.** Edits can't be heard while playing, and every seek rebuilds all the nodes.
5. **The reverb impulse uses `Math.random()`**, so renders aren't reproducible.
6. **The composition is hard-coded.** There is no data model to edit.

---

## 4. Architecture

```
Piece (JSON; what the user edits: voices, moments, timbres, mix, view)
   │
   │  compile(piece) → pure, deterministic, a few ms
   ▼
CompiledScore (per-voice pitch segments, life spans, timbre timeline, diagnostics)
   ├──► DSP graph (pure TS, no Web Audio inside)
   │       ├─ hosted in an AudioWorkletProcessor ─► speakers (live playback)
   │       └─ hosted in a Web Worker ────────────► WAV mix / stems (export)
   ├──► Renderer (pure Canvas 2D function) ──────► score view, editor overlay
   └──► Exporters ────────────────────────────────► MIDI (per-voice / MPE / notes-only), JSON

Live input (computer keyboard, on-screen piano, Web MIDI)
   └──► the same voice-leading functions ──► live segments posted to the worklet
                                         └─► optionally recorded as moments
```

### Principles
- **P1 One source of truth.** Audio, picture and MIDI all read the compiled segments. None of them computes pitch independently.
- **P2 Deterministic.**
  - The same Piece JSON gives an identical CompiledScore on any engine. This holds only because the compiler follows the numeric rules in §7.11; the spec does not guarantee identical `Math.sin`/`Math.pow` results across engines.
  - The same CompiledScore, rendered from t = 0 at the same sample rate in fixed 128-frame blocks, gives byte-identical audio within one browser engine. It may differ by tiny amounts across engines. Voices are coupled once per block by the unison lock (§8.4); its inputs are block-start state with no time source, so this still holds.
  - Live playback matches an export only when it runs from t = 0 at the same sample rate with no seek, loop or hot-swap. Those operations change the DSP state (phases, smoothers, FX buffers), so they are inaudibly different, not byte-identical.
- **P3 Pure core.** `core/` and `dsp/` import nothing from the DOM or Web Audio, so they run and are tested in Node.
- **P4 Small documents.** A piece stores moments, not curves; a typical piece is a few KB. That keeps undo snapshots, autosave and share-by-URL cheap.

---

## 5. Data model

```ts
type Seconds = number;
type Pitch = number;            // fractional MIDI note number; 69 = A4. Hz only at synthesis time.
type VoiceId = string;          // stable id, e.g. "v1"; never used for ordering (see pool index below)
type MomentId = string;         // stable random id, 6 base62 chars, assigned at creation.
                                // Load-bearing: it seeds the moment's randomness (§7.7).

interface Piece {
  format: 'algorhythms';
  version: 1;                   // migrations keyed on this
  meta: { title: string; author?: string; created: string; modified: string };
  seed: number;                 // piece seed; per-moment seeds derive from it (§7.7)
  tuning: {
    referenceHz: number;        // default 440 for pitch 69
    system: { kind: '12tet' } | { kind: 'scala'; scl: string; kbm?: string };  // scala: Later
  };
  key: Key;                     // initial key, e.g. { tonic: 'A', scale: 'dorian' }; `key` moments change it (§6.2)
  defaults: { glide: Glide };                            // moments may omit glide
  voices: VoiceDef[];           // the voice pool (max 32); not all need to be active.
                                // A voice's index in this array is its *pool index*, used for every tie-break.
  start: { voice: VoiceId; pitch: Pitch }[];             // voices active at t = 0
  moments: Moment[];            // array order breaks ties between moments with equal `at`
  timbres: Record<string, Timbre>;                       // presets referenced by name
  mix: MixSettings;             // master FX (§8.6)
  end: { at?: Seconds; fade: Seconds };                  // at omitted: last activity + 4 s
  view: ViewSettings;           // window, colors, HUD flags, grid BPM (snapping only)
}

interface Key { tonic: PitchClass; scale: ScaleRef }

interface VoiceDef {
  id: VoiceId;
  name?: string;
  color?: string;               // used when view.colors = 'custom'
  timbre: string;               // key into Piece.timbres
  pan: number | 'auto';         // -1..1, or auto (by index or by pitch, see mix)
  gain: number;                 // linear, default 1
  range: [Pitch, Pitch];        // out-of-range targets fold by octave (§7.8)
  mute?: boolean;
  solo?: boolean;
}

interface Glide {
  length: Seconds;              // glide duration per voice
  jitter: number;               // 0..1, length varies by ±jitter·length (seeded)
  stagger: Seconds;             // spread of start times across affected voices
  order: 'random' | 'low-first' | 'high-first' | 'center-out' | 'outside-in';
  ease: EaseRef;
}
type EaseRef = 'smootherstep' | 'smoothstep' | 'cosine' | 'linear' | 'expo'
             | { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number };

type VoiceSelector =
  | 'all'                                   // all active voices at the moment's time
  | { voices: VoiceId[] }
  | { rank: [number, number] };             // by pitch order at that time; 0 = lowest

type NoteSet =
  | { kind: 'pitches'; pitches: Pitch[] }   // explicit notes
  | { kind: 'chord'; symbol: string }       // "Am9", "F#m7b5", "Csus2" (chord parser)
  | { kind: 'degrees'; degrees: number[] }  // scale degrees in Piece.key, 0-based
  | { kind: 'current' };                    // pitch classes sounding at that time
```

### Example piece (abridged)

```json
{
  "format": "algorhythms", "version": 1,
  "meta": { "title": "First Light", "created": "2026-11-19T00:00:00Z", "modified": "2026-11-19T00:00:00Z" },
  "seed": 2611,
  "tuning": { "referenceHz": 440, "system": { "kind": "12tet" } },
  "key": { "tonic": "A", "scale": "dorian" },
  "defaults": { "glide": { "length": 3, "jitter": 0.2, "stagger": 0.8, "order": "random", "ease": "smootherstep" } },
  "voices": [ { "id": "v1", "timbre": "glass", "pan": "auto", "gain": 1, "range": [38, 86] } ],
  "start": [ { "voice": "v1", "pitch": 57 } ],
  "moments": [
    { "id": "k3f9", "type": "split",  "at": 9,  "count": 3, "notes": { "kind": "chord", "symbol": "Am7" } },
    { "id": "p0x2", "type": "split",  "at": 17, "count": 8, "notes": { "kind": "current" } },
    { "id": "q7aa", "type": "chord",  "at": 26, "notes": { "kind": "degrees", "degrees": [3, 5, 7, 9] } },
    { "id": "u1zz", "type": "unison", "at": 40, "pitch": 64, "glide": { "length": 4.5, "jitter": 0.1, "stagger": 0.9, "order": "outside-in", "ease": "smootherstep" } },
    { "id": "r2kd", "type": "key",    "at": 50, "key": { "tonic": "D", "scale": "aeolian" } },
    { "id": "w8mm", "type": "walk",   "at": 52, "until": 70, "grid": 0.5, "density": 0.45 }
  ],
  "timbres": { "glass": { "...": "§8.5" } },
  "mix": { "...": "§8.6" },
  "end": { "fade": 6 },
  "view": { "window": 20, "colors": "pitch", "hud": true }
}
```

The `voices` array above is abridged; a real piece lists the whole pool, for example `v1`–`v12`.

**Schema and validation.** Zod schemas generate both the runtime validators and the published JSON Schema (`docs/file-format.md`).
- **Unknown fields are preserved** on load and save, so newer files survive a round trip through older builds where possible. Zod strips unknown keys by default, so every object schema is declared passthrough (`.passthrough()` in Zod 3, `z.looseObject` in Zod 4). A round-trip test with injected unknown fields at every level enforces this.
- **Files from a newer version** (`version` greater than the build supports) open with a warning that features may be missing. They are not autosaved over the original, and saving writes a copy. Migrations only run forward.

---

## 6. Moments

### 6.1 Fields common to every moment

```ts
interface MomentBase {
  id: MomentId;
  type: MomentType;
  at: Seconds;
  target?: VoiceSelector;       // default 'all'
  glide?: Partial<Glide>;       // merged over Piece.defaults.glide
  seed?: number;                // explicit override; otherwise derived (§7.7)
  label?: string;
  muted?: boolean;              // skipped by the compiler, still shown on the lane
}
```

### 6.2 Catalog for v1

| Type | Specific fields | What it does |
|---|---|---|
| **chord** | `notes: NoteSet`, `voicing: 'even' \| 'close' \| 'nearest'`, `register?: [Pitch, Pitch]`, `assign: 'ordered' \| 'free'` | Moves the targeted voices to a voicing of `notes` (§7.3) by voice leading (§7.2). The voice count is unchanged; doubling happens if there are fewer notes than voices. |
| **unison** | `pitch: Pitch \| 'center' \| 'tonic'`, `octaves: boolean` | All targeted voices go to one pitch. With `octaves`, each goes to the nearest octave of that pitch class instead. |
| **split** | `count: number`, `notes?: NoteSet` (default `current`), `voicing` | Raises the active count to `count` by activating dormant voices from the pool. Each newborn forks from its nearest parent (§7.4). |
| **merge** | `count: number`, `which: 'top' \| 'bottom' \| 'inner' \| 'outer' \| 'random'`, `fade: Seconds` | Lowers the active count. Each dying voice glides into its nearest surviving neighbour's pitch, then fades out and becomes dormant; a later split can revive it. |
| **shift** | `by: number`, `unit: 'semitones' \| 'scaleSteps'` | Transposes the targeted voices. Scale steps are counted in `Piece.key`; off-scale pitches snap to the scale first. |
| **spread** | `factor: number`, `around: Pitch \| 'mean' \| 'median'`, `snap: 'scale' \| 'chromatic' \| 'none'` | Each pitch becomes c + factor·(p − c), then snaps. A factor above 1 widens the voicing; below 1 squeezes it. |
| **walk** (region) | `until: Seconds`, `grid: Seconds`, `density: 0..1`, `steps: number[]` (scale steps, default [-2,-1,1,2]), `stepGlide: Seconds`, `bass?: { leap: [number, number] }` | Independent stepwise melodies until `until`. It keeps pitch order (no crossing or touching), and the bass leaps. This is the prototype's algorithm. |
| **pin** | `voice: VoiceId`, `pitch: Pitch` | Moves one voice to an exact pitch. It is the hand-editing escape hatch and may cross other voices. |
| **key** | `key: Key` | Changes the key from `at` onwards; no pitch effect. Everything that depends on the key (shift by scale steps, walk, `snap: 'scale'`, `degrees`, Roman numerals) reads the key in effect at its own time. The compiler emits a key timeline. Without it, "move to D minor 9" followed by a walk would walk in the initial key. |
| **level** | `gain: number`, `over: Seconds` | Ramps the targeted voices' gain to `gain` over `over` seconds: swells, fades, "breath". Moved up from M6 because dynamics are central to G1. |

### 6.3 Planned for later milestones
- **timbre** (M6): `preset`, `fade`. Crossfades the targeted voices to another timbre; no pitch effect.
- **Later:** **mirror** (reflect around an axis), **arpeggio** (region; voices step through a pattern), **drift** (region; slow microtonal wander off the scale), **camera** (view-only zoom and follow keyframes).

---

## 7. Compiler

`compile(piece: Piece): CompiledScore` is pure and synchronous, and runs on the main thread (§7.10).

### 7.1 Algorithm: an event simulation
Moments overlap. A chord can land inside a walk region, and a moment can arrive before an earlier moment's staggered moves have started. If each moment computed all of its moves up front, a walk processed first would schedule steps from a state that a later chord changes, and those steps would then overwrite the chord. So the compiler runs a discrete-event simulation over a priority queue, and every decision reads the state at the time it is made.

**Voice state.** Each voice holds:
- its current segment;
- its **committed destination**: the pitch it will reach once the moves already scheduled for it finish (its current pitch when idle);
- its **pending moves**: moves scheduled but not yet started, usually because of stagger.

**Events,** in time order. At equal times: moment events in `moments` array order, then move starts by pool index, then walk ticks in `moments` array order.
- **moment** at `at`, one per unmuted moment.
- **move-start** at a move's start time t₀.
- **tick** at `at`, `at + grid`, … while `< until`, for each region moment (walk).

**Steps:**
1. Validate and normalise the piece, merging the glide defaults.
2. Initialise voice state: the `start` voices are active and holding their pitches; all others are dormant. Push the moment and tick events.
3. Pop events in order:
   - **moment:**
     - resolve `target` at this time;
     - cancel the pending moves of the targeted voices;
     - run the moment's function on the voices' committed destinations. It returns moves (`{voice, t0, duration, toPitch, ease}`), births and deaths;
     - push one move-start event per move.
   - **move-start:**
     - read the voice's *actual* pitch and velocity at t₀;
     - if it is mid-glide, apply the interruption rule (§7.5);
     - write the segment and update the committed destination.
   - **tick:** run one walk step (rules below).
4. Close all voices at `end`, applying the end fade.
5. Emit segments, life spans, key, timbre and level timelines, moment spans (for the editor's glide bars) and diagnostics.

**Births and deaths are never cancelled.** A voice counts as active from the event time of the moment that births it, even if it becomes audible later. If a later moment cancels a newborn's pending move, the newborn holds its birth pitch until the later moment moves it.

**Walks and other moments:**
- At a tick, a voice steps only if it is in the walk's target, active and idle: no glide in progress and no pending move from another moment.
- A voice that a point moment moves inside the region resumes walking from its new pitch at the first tick after that glide ends.
- A voice born inside the region joins at the first tick after its birth glide ends, if the walk's target includes it (`'all'` does).
- The "strictly between neighbours" check uses the neighbours' committed destinations.
- When two walks target the same voice, the one that started later drives it and the other skips it.
- If `stepGlide` is longer than `grid`, a voice simply skips the ticks it is still gliding through.

### 7.2 Voice leading (assignment)
Sort the active targeted voices by committed destination (§7.1), breaking ties by pool index. (Sorting by id string would put `"v10"` before `"v2"`.) Their pitches are `p[0..a)`. Sort the targets as `q[0..k)`.

- **`ordered`** (default; lines never cross):
  - **k = a:** identity map.
  - **k > a:** injective, order-preserving map minimising Σ|p_i − q_f(i)|, by DP in O(a·k) (the prototype's `assign`). Unmatched targets are filled by births when the moment allows them (split), or dropped with a diagnostic.
  - **k < a:** surjective, non-decreasing map (every target gets at least one voice) minimising the same cost, by DP in O(a·k). The prototype doesn't have this; it is new.
- **`free`:** the Hungarian algorithm on |p − q|, which allows crossings. When k ≠ a, pad with duplicated targets (for k < a) or dummy columns (for k > a).

**Crossing guarantee under `ordered`.** An order-preserving assignment keeps the start and end points in order, but that is not enough. Stagger and jitter give neighbouring voices different start times and durations, so a fast low voice can pass a slow high one mid-glide. The prototype already does this. The guarantee is therefore enforced, not assumed:
- **Rule:** after stagger and jitter are drawn, the compiler checks each adjacent pair of moving targeted voices for a mid-glide crossing by sampling both curves (64 points). If they would cross, the overtaking voice adopts the overtaken voice's start time and duration. Repeat until no pair crosses. This converges, since in the worst case the whole group shares one timing.
- **Why this works:** two voices with the same timing and the same ease, whose endpoints are in order, cannot cross. Their difference is (b₀ − a₀)(1 − e) + (b₁ − a₁)·e, which is ≥ 0. The interruption velocity term (§7.5) can break this, so the sampled check, not the algebra, is the authority. Where adopting timing doesn't remove a crossing caused by carried velocity, the overshoot clamp in §7.5 is tightened to the gap.
- **Scope:** the guarantee covers the targeted voices only. A `rank` or `voices` selector may move a subset through a voice outside the target; the compiler reports that as an `info` diagnostic. `pin` and `free` are exempt.
- **Musical cost:** merged timings make staggered fan-outs more uniform where voices are close together. This is an open question for the second review (§17).

### 7.3 Voicing: from a NoteSet to k target pitches
- **`pitches`:**
  - if there are fewer notes than k, assign voices by the surjective DP (doubling);
  - if there are more, choose k evenly spaced notes.
- **`chord`, `degrees`, `current`:** resolve to pitch classes, then list every candidate pitch in the register (by default, the union of the targeted voices' ranges). Then pick k of them by the `voicing` mode:
  - **`even`:** k indices evenly spaced over the candidates (the prototype's method).
  - **`close`:** k consecutive candidates centred on the register's middle.
  - **`nearest`:** each voice takes its nearest candidate, giving minimal motion; voices may double.
- **Chord parser:** handles triads, 6/7/9/11/13 chords, sus2/sus4, add9, dim, aug, m7b5, slash bass (e.g. `C/E`), and Roman numerals relative to the key (`ii7`, `V9`). Invalid input becomes a diagnostic and the chord is not applied.

### 7.4 Births and deaths
- **Birth:**
  - A dormant voice becomes active and its life span opens.
  - The parent is the active voice nearest to the birth target, measured at the moment's time.
  - The newborn starts at the parent's pitch, at the parent's departure time (the start of the parent's move in this moment), or at the moment's time plus a seeded stagger if the parent doesn't move.
  - Gain fades in over `max(0.5 s, glide length / 2)`.
  - The newborn starts exactly on its parent's pitch. The unison lock (§8.4) joins the two in one group with a shared phase and group gain, so they neither cancel nor double.
- **Death (merge):**
  - The voice glides to its chosen absorber's target pitch.
  - Its gain fades out over `fade`, starting when the glide ends.
  - Its life span closes and it becomes dormant again.
- **Pool exhausted:** the split is truncated and a diagnostic is raised.

### 7.5 Interruption (new; replaces the prototype's queuing)
A move can start at time tᵢ while the voice is mid-glide in a segment S (t0 < tᵢ < t1):
1. Truncate S at tᵢ.
2. Read the current pitch pᵢ = S(tᵢ) and the velocity vᵢ = S′(tᵢ), in semitones per second.
3. Build the new segment over duration d, keeping the **ease the moment asked for** and adding a velocity term that dies away:

   p(x) = p₀ + (p₁ − p₀)·e(x) + m₀·H(x),  with H(x) = x³ − 2x² + x and x ∈ [0, 1]

   - p₀ = pᵢ and p₁ is the target.
   - m₀ = vᵢ·d − (p₁ − p₀)·e′(0). The second term matters only for eases with a nonzero starting slope, such as `linear` or some béziers. For smootherstep, e′(0) = 0.
   - H(0) = H(1) = 0, H′(0) = 1 and H′(1) = 0. So the endpoints are exact, the start slope is vᵢ (C¹ at the join), and the end behaves like the chosen ease.

This form is still valid when p₁ = p₀, for example when a voice is interrupted and sent back to its own pitch. A "normalised ease" form, p₀ + (p₁ − p₀)·h(x), cannot represent that case, and it would also discard the user's ease.

**Overshoot limit.** When vᵢ points away from the target, the curve overshoots. A little is musical. The compiler limits it to L = min(1 semitone, the gap to the nearest neighbour under `ordered`) beyond the range [min(p₀, p₁), max(p₀, p₁)]:
- sample the curve at 64 points;
- if the overshoot exceeds L, scale m₀ down by bisection until it fits.

When the clamp applies, the join is C⁰ with a reduced jump in velocity. The segment is flagged `clamped`, and the C¹ property test skips flagged joins.

### 7.6 Easing
Easing is applied in pitch space: p(t) = p₀ + (p₁ − p₀)·e(x), with x = (t − t₀)/(t₁ − t₀).
- `smootherstep`: e(x) = 6x⁵ − 15x⁴ + 10x³. This is the default.
- `smoothstep`, `cosine` and `linear` are standard.
- `expo` is ease-in-out exponential.
- `bezier` uses CSS cubic-bezier semantics.

Because pitch is logarithmic in Hz, every interval moves at the same perceived speed.

### 7.7 Randomness
- **Moment seed:** a moment's effective seed is `seed ?? hash32(piece.seed, moment.id)`.
- **Counter-based draws, not a stream.** Every random value is computed directly from its key:

  `rand(momentSeed, voiceId, step, purpose) = toUnit(mix32(momentSeed, hash32(voiceId), step, purposeCode))`

  `mix32` is a fixed integer hash (for example the murmur3 finaliser), and `step` is the walk tick index or 0. A sequential PRNG would hand out draws in order, so an earlier edit that changes the voice count would shift every later draw in a walk. With keyed draws, voice v7's step at tick 12 changes only if v7's own state changes.
- **Consequence:** moving or editing moment A never changes moment B's random draws. B's *result* can still change if it depends on the state A leaves behind. That is inherent to state-dependent moments; `pin` and Freeze (§11.3) exist for when it matters.
- **Reroll** sets a new explicit `seed` on a moment.
- **Duplicating a moment** gives it a new id but copies the original's effective seed into `seed`, so the copy behaves the same as the original until rerolled. An Alt-dragged walk is the same walk, which is what users expect.

### 7.8 Ranges and quantisation
- **Out-of-range targets** fold by octave into the voice's range, with a diagnostic if folding is impossible because the range is narrower than an octave.
- **`snap: 'scale'`** snaps to the nearest scale tone of `Piece.key`; ties go downward.
- **Walk and shift by scale steps** operate on scale-degree indices. Off-scale pitches snap before stepping.

### 7.9 Output and query API

```ts
interface CompiledScore {
  duration: Seconds;
  voices: CompiledVoice[];
  momentSpans: { id: MomentId; start: Seconds; end: Seconds }[];  // earliest move start .. latest move end
  diagnostics: Diagnostic[];    // { momentId?, level: 'info'|'warn'|'error', message }
}
interface CompiledVoice {
  id: VoiceId;
  lives: { born: Seconds; died?: Seconds; fadeIn: Seconds; fadeOut?: Seconds }[];
  segments: Segment[];          // sorted, contiguous within each life; a hold is p0 === p1
  timbre: { t: Seconds; preset: string; fade: Seconds }[];
  level: { t: Seconds; gain: number; over: Seconds }[];
}
// p(x) = p0 + (p1 − p0)·ease(x) + m0·(x³ − 2x² + x), x = (t − t0)/(t1 − t0)   (§7.5)
interface Segment {
  t0: Seconds; t1: Seconds; p0: Pitch; p1: Pitch;
  ease: EaseRef;
  m0?: number;                  // carried velocity term from an interruption; 0 if absent
  clamped?: boolean;            // overshoot clamp reduced m0, so the join is C⁰ only
  momentId?: MomentId;
}
// Plus a piece-level key timeline: { t: Seconds; key: Key }[]
// and a harmony timeline: harmony?: { t, pitch classes, bass, label }[], one entry per applied
// moment that changes the chord (a written chord symbol always starts one; walk, key and level don't)

pitchAt(voice, t): Pitch | null           // binary search, O(log n); null when dormant
motionAt(voice, t): number                // 0..1, sin(π·x) during a glide, 0 while holding
sample(voice, t0, t1, maxStep): [t, p][]  // holds emit 2 points; glides are sampled adaptively
chordAt(score, t): HarmonyChange | null   // the chord in effect at t (HUD), O(log n)
```

### 7.10 Performance target
A 5-minute piece with 24 voices and 200 moments should compile in a median of ≤ 5 ms on the CI machine in Node. If it exceeds 10 ms in the browser, compilation moves to a worker; the API is already pure, so that is a mechanical change. The crossing checks and overshoot clamps (64-point samples per pair) are included in this budget and must be measured in M1.

### 7.11 Numeric rules for cross-engine determinism
The spec doesn't guarantee that `Math.sin`, `Math.cos`, `Math.pow`, `Math.exp` or `Math.log` give identical results across engines. If any compiler decision (a tie break, the "strictly between neighbours" check, a crossing check, an overshoot clamp, `snap` ties) branches on such a value, a share link could compile differently in Safari than in Chrome. Rules:
- `core/` uses only `+ − × ÷`, `Math.sqrt`, `Math.floor`/`round`/`abs`/`min`/`max` and integer operations. These are exact under IEEE 754, so they agree on every engine.
- Where a transcendental is needed (the `cosine` and `expo` eases, `bezier` solving), `core/math.ts` provides in-house polynomial and rational approximations built only from those operations.
- An ESLint rule bans `Math.sin`, `cos`, `pow`, `exp` and `log` (and `**` on non-integer exponents) inside `core/`.
- The DSP is exempt. It may use native `Math` for audio, because audio doesn't need cross-engine byte-identity (P2).
- A golden test compiles every example piece in Node, Chromium, Firefox and WebKit and requires identical output.

---

## 8. Sound engine

### 8.1 Hosting
The **DSP graph is pure TypeScript**: oscillators, envelopes, per-voice processing and master FX. Web Audio is used only to get samples to the speakers. It runs in two hosts:
- **Live:** an `AudioWorkletProcessor` running the graph, connected to `ctx.destination`. There are no other Web Audio nodes.
- **Export:** a Web Worker running the same graph faster than real time and writing PCM (§12).

Both hosts run the same code in **fixed 128-frame blocks**: the export worker processes its ~1 s chunks as runs of 128-frame blocks, and per-block parameter updates happen on the same boundaries. Played from t = 0 at the same sample rate, the preview and the export are therefore identical. After a seek, loop or hot-swap they differ inaudibly (P2). The context's sample rate is the device's (often 48 kHz, sometimes 44.1 kHz), and an export at a different rate uses different wavetable mips.

### 8.2 Messages

**Main thread → worklet:**
- `load { score, mix }`, where `score` is the flattened compiled score (§8.11)
- `tables { timbre, mips }`: wavetables built in a worker (§8.11)
- `play { from: Seconds }`
- `pause`
- `seek { to: Seconds }`
- `loop { start, end } | null`
- `swap { score }` (hot-swap after an edit)
- `live { segments }` (§9)
- `param { path, value }`

**Worklet → main thread:**
- `anchor { contextTime, pieceTime }` on every play, seek, loop wrap and swap (§8.3)
- `pos { frame, time }` about every 250 ms, for drift correction only
- `ended`
- `meter { peakL, peakR, rms }` about every 50 ms
- `error`

Compiled scores are small (segments, not samples). They are posted as typed arrays in the transfer list, so the audio thread receives a few buffers instead of a graph of objects to allocate. **SharedArrayBuffer is avoided**, because it needs cross-origin isolation headers (COOP/COEP) that GitHub Pages cannot set; message passing is enough.

### 8.3 Clock and sync
The worklet runs on the context clock, so the playhead is derived from that clock rather than from a stream of position messages:
- On every play, seek, loop wrap and swap, the worklet posts an `anchor { contextTime, pieceTime }`.
- Each frame, the main thread computes `pieceTime = anchor.pieceTime + (heardContextTime − anchor.contextTime)`, wrapping at loop ends.
- `heardContextTime` comes from `ctx.getOutputTimestamp().contextTime` where available. Otherwise it falls back to `ctx.currentTime − (outputLatency || baseLatency)`, as the prototype does.
- `pos` messages only correct drift. The worklet stays the authority on position.

**Latency hint.** The player creates its context with `latencyHint: 'playback'`. Larger buffers mean fewer dropouts, particularly on Safari and Firefox, and the extra latency is invisible because the playhead compensates for it. Live mode (§9) needs `'interactive'`. The hint is fixed when a context is created, so entering live mode creates a new context and reloads the worklet; this takes well under a second and happens only on that switch.

### 8.4 Per-voice DSP, per sample
- **Frequency:** `f = Hz(p(t)) · 2^(detuneCents/1200) · vibrato(t)`, where `Hz(p) = referenceHz · 2^((p − 69)/12)` under 12-TET.
- **Detune.** Each voice has a fixed offset in cents, seeded by voice id, in the prototype's pattern: alternating sign, about 1.5–4 cents. A timbre's `detuneSpread` can widen it. Within a locked group the offsets are averaged into the group's pitch.
- **Unison lock (owner decision 2026-11-20: converged voices are steady by default).** Voices on exactly the same frequency would otherwise freeze their phase difference wherever it happens to be, so a unison would sit anywhere from near silence to +6 dB, merges could cancel the survivor, and a seek would change the level.
  - **Group pass, once per 128-frame block**, on each voice's block-start state. Two voices pair with weight w: full at ≤ 2 cents apart, none at ≥ 20 cents, zero if either timbre has `wobble` > 0. Voices moving apart quickly leave early.
  - **Per voice,** a lock amount λ (smoothed) pulls its modulated pitch, phase and vibrato phase toward the group's amplitude-weighted mean. Arriving voices converge onto a held one, which keeps its pitch. Level drift and vibrato jitter fade by λ.
  - **Group gain** h = √(Σw²A²)/|Σ w·A·e^{iφ}| from the measured phases (≤ +3 dB, smoothed): a coherent group sits at the level of an incoherent chord. It is applied per voice, so stems carry it.
  - **Parting:** the accumulated phase correction unwinds as voices separate, so they leave with unrelated phases (only for partings without a warp, below).
  - **Glide warp into and out of a unison (owner-approved 2026-11-20).** A glide that ends where another voice holds (within 20 cents for 0.2 s), or starts from one, is warped near that pitch: it sits on the unison early and moves 2–3× faster through the zone where it would beat slowly. The zone is the distance that beats at 12 Hz (about 100 cents at A2, 47 at A4), capped by the glide's span. That bends the written glide by up to ~60 cents (A2–A3) or ~35 cents (A4), landing 0.2–0.4 s early. Crossings, passing glides, distinct intervals and `wobble` timbres are never warped. Warping pairs capture phase from 60 cents and join the group gain h until they beat faster than 20 Hz. h uses block-end phase prediction with 2 ms smoothing, and the phase pull is full strength beyond a quarter cycle. Tunable via `WARP_HZ` / `WARP_MAX` (src/dsp/voice.ts).
  - **Fresh voices** (seek, birth, unmute) snap to their group's phase at zero amplitude, so a seek re-locks with no level change.
  - **Measured (M3):** a held unison of 2–32 voices sits at 0.95× one voice with envelope variation ≤ 0.002; merges stay within 0.80–1.19× one voice.
  - **Wobble:** a timbre with `wobble` = c cents (§8.5) never locks and scales the detune to a mean of c cents, giving the old slow beating. The `wobble` preset uses it.
- **Pitch evaluation:** per sample from segments. The segment cursor advances monotonically and is reset on seek. If profiling demands it, pitch can be evaluated at control rate (every 16 samples) and interpolated linearly in Hz.
- **Sine table:** one shared 4096-point table with linear interpolation serves FM, vibrato, LFOs and the additive path (M6). The DSP never calls `Math.sin` per sample.
- **Oscillator:**
  - **Band-limited wavetable**, one mip table per octave, holding only harmonics below Nyquist. Lookup interpolates linearly, with a crossfade between adjacent mips by the fractional log₂ f, so long glides don't produce zipper noise. Because timbres have at most 32 harmonics, mips only start dropping partials above about 750 Hz at 48 kHz (32 · f > 24 kHz), so only the top few octaves need distinct tables.
  - **Optional 2-operator phase modulation (M6):** the wavetable carrier is read at a modulated phase, y = table(φc + I·sin(2π·φm)).
    - φm is a **separate phase accumulator** advancing by r·f/fs. Writing the modulator as sin(2π·r·φc) with a wrapped φc would make it jump on every carrier cycle whenever r isn't an integer, which clicks.
    - The index I is scaled down as f rises to limit aliasing.
  - **Optional breath noise (M6):** white noise through a band-pass tracking f, scaled by an envelope.
- **Amplitude:** `gain_voice · life(t) · level(t) · (1 + accent·motion(t)) · articulation(t) · loudness(p)`.
  - `articulation(t)`: an optional attack–decay envelope triggered when a glide ends at a new pitch. Turned up, it makes the lines sound plucked.
  - `loudness(p)`: a gentle equal-loudness tilt; the prototype uses 2^(−(p−57)/48).
- **Vibrato:** only after a voice arrives at a pitch; rate, depth in cents, and onset delay. Zero during glides.
- **Pan:** equal-power, set per voice or `auto` (by index or by pitch, per mix setting).
- **Starting phase:** a seeded random phase per voice, for determinism only. Unison phase-summing is handled by the lock above.
- **Sum normalisation:** every voice is multiplied by the same gain, `g_n(t) = 1/√(Σ life weights)` (as in the prototype), smoothed over 50 ms. It is applied per voice, before the dry/send split (§8.6), so stems can carry it exactly (§12).

### 8.5 Timbre model

```ts
interface Timbre {
  harmonics: number[];          // amplitudes 1..32, used to build wavetables
  stretch: number;              // inharmonicity: partial n at n^(1+stretch); bells
  fm?: { ratio: number; index: number; indexTrack: number };
  noise?: { level: number; bandwidth: number };
  brightness: { tilt: number; track: number };  // dB/oct tilt; how tilt follows pitch
  detuneSpread: number;         // cents across voices
  accent: number;               // motion accent amount
  articulation: { amount: number; attack: Seconds; decay: Seconds };
  vibrato: { rate: number; depthCents: number; delay: Seconds };
  wobble?: number;              // cents, 0–100; > 0 opts out of the unison lock (§8.4) and beats
}
```

Built-in presets:
- **M2 (wavetable and articulation only):** sine, glass, organ, reed, choir-ish (formant-weighted harmonics), pluck (high articulation).
- **M3:** wobble (soft glass-like, `wobble` 3: converged voices beat slowly).
- **M6:** bell (stretch + FM), plus further presets.

**Inharmonic timbres (resolved).** `stretch ≠ 0` makes the partials inharmonic, so a single-cycle wavetable can't represent them. Such timbres use an **additive path** instead: up to 16 partials, each with its own phase accumulator, read from the shared sine table, with partials above Nyquist skipped individually. The cost is 24 voices × 16 partials × 48k ≈ 18M table lookups per second, which is affordable. It ships in M6 with `stretch`.

### 8.6 Master FX, pure TS: send-based topology
Every effect except the master tone and limiter is a send, so the signal flow can be split into stems that sum exactly (§12).

```
voice i ─► × g_n(t) ─┬─────────────────────────────► dry bus ──┐
                     ├─ × reverbSend_i ─► reverb ─► return ─────┤
                     └─ × delaySend_i  ─► delay  ─► return ─────┤
                                                                ▼
                                       master: sum ─► tone ─► limiter ─► out
```

- **Reverb:** a feedback delay network with 8 lines, a Householder matrix and damping. Settings: size, decay, damping, pre-delay, return level. It is deterministic and has no impulse responses.
- **Delay:** stereo ping-pong, timed in seconds, on its own send.
- **Tone:** a tilt EQ plus a low-pass filter. It is linear, so applying it to each stem separately gives the same sum.
- **Limiter:** look-ahead peak limiter (5 ms) with a −1 dBFS ceiling. It is the only nonlinear stage; its gain curve is shared with the stems in §12.

### 8.7 Hot-swap, seek and loop
- **Hot-swap:** applied at a block boundary.
  - If a voice's new pitch differs from its old pitch at the current time by more than 0.5 semitones, the old and new signals crossfade over 20 ms.
  - Smaller differences are slewed.
  - Life-span changes ramp the gain over 20 ms.
- **Seek:** a 5 ms fade out, a jump, then a 5 ms fade in. FX state is kept by default, so the reverb tail continues. Oscillator phases after a seek differ from a render from t = 0. Because locked groups re-take a shared phase and the group gain holds their level (§8.4), this changes no audible level. Exact phase restore (storing cumulative cycles per segment at compile time) is Later.
- **Loop:** wraps with the same 5 ms crossfade.

### 8.8 Loudness and safety
The limiter is always on. The meter is shown in the transport. Exports peak at ≤ −1 dBFS. True-peak and LUFS normalisation are Later.

### 8.9 Performance budget
There is one number, a **real-time factor (RTF)**: RTF ≥ 10× for 24 voices plus FX at 48 kHz, measured in Node on the CI machine. That is about 10% of one core. It leaves 2× headroom for the live budget of ≤ 20% of a core on a 2020-era laptop and for browser overhead. M2 gates on this number.
- **A rough cost:** a wavetable voice with mip crossfade, pitch evaluation, envelopes, vibrato and pan is about 50–100 operations per sample. 24 voices × 48k × 100 ≈ 115M operations per second, plus the FDN and limiter. That should fit in a JIT-compiled AudioWorklet, but it must be measured in M2.
- **Fallbacks, in order:**
  1. Control-rate pitch evaluation (§8.4).
  2. Fewer mip partials.
  3. A 16-voice cap with a warning.
  4. A WASM DSP behind the same interface (D2).

### 8.10 Determinism
There is no `Math.random`, `Date` or wall-clock time in the DSP. Every random value (phases, noise) comes from seeded PRNGs keyed by voice id and piece seed. Both hosts process in fixed 128-frame blocks (§8.1).

### 8.11 Worklet discipline (allocation-free)
Garbage-collection pauses on the audio thread cause dropouts, especially on Safari. Rules for everything the worklet runs:
- **No allocation in `process()`.** No object or array literals, closures, `for…of`, spread, destructuring of arrays, or string building. All buffers are preallocated at `load`.
- **Flat scores.** The compiled score is flattened into typed arrays before posting: per voice, a `Float64Array` of segment records (t0, t1, p0, p1, easeCode, m0, ...), plus arrays for lives, levels and timbre changes. These are sent as transferables, so a `swap` hands over buffers instead of building objects on the audio thread.
- **Wavetables are built off the audio thread.** A worker generates a timbre's mip tables, and `tables` transfers the Float32Arrays to the worklet. A timbre edit during playback then can't glitch the audio. The worklet keeps the old tables until the new ones arrive.
- **Message handlers** copy what they need into preallocated state and return. The worklet applies changes at the next block boundary.
- **Verification:** a Node DSP test runs `process()` for 60 s of audio after a warm-up, under `--trace-gc`, and fails if any scavenge occurs during the run.

---

## 9. Live instrument mode

- **Inputs:**
  - Computer keyboard, with the usual DAW "musical typing" layout: `A W S E D F T G Y H U J K`, and `Z`/`X` to change octave.
    - **Musical typing is a mode.** Those letters collide with the editor's moment shortcuts (§11.3): S, W, T, U and K. The mode is toggled by a transport button or the `` ` `` key, shows a clear indicator, and is on by default only while the Live drawer is open.
    - While it is on, letter keys play notes and the single-letter editor shortcuts are disabled. Space (play/pause), Escape and modified shortcuts (⌘/Ctrl-Z and so on) still work.
  - The on-screen piano ruler.
  - Web MIDI on Chromium and Firefox. Firefox asks the user to install a site-permission add-on the first time; the help explains this. Safari has no Web MIDI, so the keyboard is the fallback there.
- **Behaviour:**
  - The set of held notes H defines a live target.
  - **No debounce delay.** The glide starts on the first key. If more keys arrive within 15 ms (a chord press), the voices are re-targeted through the interruption rule (§7.5), which is smooth because of the carried velocity. A debounce would add its 15 ms to every note and break the M7 latency target.
  - When recording, notes that arrive within 15 ms of each other are merged into one moment, so a chord press records as one chord.
  - |H| = 1 means unison (or octaves, depending on a setting). |H| > 1 means a chord, voiced either as "exact notes" (surjective doubling) or "across the range" (`even` voicing).
  - Releasing all notes either holds, fades out, or returns to the tonic, per a setting.
  - Glide length, stagger and order come from the live panel.
  - Mod wheel (CC1) sets glide length, sustain (CC64) holds, and pitch bend shifts all voices by ±2 semitones continuously.
- **Engine path:**
  1. The main thread keeps a mirror of the live voice state by evaluating the live segments it has sent.
  2. On each change it runs the same `core` voice-leading functions and posts `live { segments }` with the start time set to "now".
  3. The worklet stamps the actual frame.
- **Recording:**
  - With Record armed, the transport runs over the timeline (silent where nothing is written) and each live change is written as a `chord` or `unison` moment at its time, with the glide settings in effect.
  - Recorded moments are ordinary, editable moments.
  - v1 does not layer live playing over playback of existing moments. "Record into silence" is the v1 scope (resolved in review, §17).
- **Latency:** worklet-side latency is ≤ one block (128 samples) plus message latency, on top of the device's output latency. Live mode uses an `'interactive'` context (§8.3). Glides tolerate latency well.

---

## 10. Visuals: the renderer

### Interface
`drawScore(ctx2d, compiled, camera, style, t, size, dpr)` is a pure function. It is reused by the player, the editor and, later, by export.

### Drawing rules
- **Holds** are drawn as single straight line segments. **Glides** are sampled about every 2 px at the current scale. This is a big saving over the prototype's 100 Hz arrays.
- **Layers, back to front:**
  1. Background and octave grid (A lines labelled with Hz).
  2. Moment and section markers.
  3. Lines: the past at full opacity; the future as a ghost at a configurable opacity, 0 during playback by default.
  4. Heads: a dot per voice; a ring while moving, with opacity equal to `motionAt`; and Hz labels de-duplicated with ×N counts.
  5. Playhead.
  6. HUD, including the chord being played (`chordAt`; e.g. `ii7 · Dm7`, `Am7/E`), owner request 2026-11-20.
  7. Editor overlay (§11).
- **Colors:** by pitch (the default: a vertical gradient, low cool to high warm); ink; or custom per voice (`VoiceDef.color`, falling back to ink). An HSL fallback covers browsers without OKLCH. The per-voice hue mode was removed (owner, 2026-11-20); old files with `"voice"` load as `"pitch"`.

### Camera
- The time window runs from 2 s to the whole piece on a log scale, set by slider, pinch, ⌘/Ctrl-scroll, or `−`/`=`.
- The playhead sits at a fixed x, 78% across by default.
- The follow camera blends into the overview as the window approaches the whole piece (the prototype's formula).
- When paused, dragging pans the view. Vertical framing auto-fits the used range; manual vertical zoom is Later.

### Budget
≤ 4 ms per frame at 1080p with 24 voices. If the past lines become expensive, cache them to an offscreen canvas per camera scale.

---

## 11. Website and editor

### 11.1 Structure
- `/` opens the instrument straight away, with a featured example piece loaded but not playing (browser autoplay rules).
- `/#p=…` opens a shared piece.
- Menus give access to **Examples** (4–6 handmade pieces, CC0), **My pieces** (stored in IndexedDB), **New** (empty, or from a template), **Generate**, **Import/Export**, and **Help** (shortcuts).

### 11.2 Layout (desktop)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▶ ⟲ ⟳loop ●rec  01:42.3 / 05:00  ▁▃▅ meter   A dorian · 12 voices  ⋯ menu │
├────┬───────────────────────────────────────────────────┬─────────────────┤
│ A5 │                                                   │ CHORD   @ 0:42  │
│    │   score view: lines, playhead, moment overlay     │ notes   Dm9 ▾   │
│ A4 │                                                   │ voicing even    │
│    │                                                   │ glide   3.0 s   │
│ A3 │                                                   │ stagger 1.2 s   │
├────┼───────────────────────────────────────────────────┤ order   low→hi  │
│    │ moments ◆split  ◆chord━━━  ▭▭▭ walk ▭▭▭  ◆unison━ │ ease    ⌒       │
│    │ ─────── scrubber ───────────────────────────────  │ voices  all     │
├────┴───────────────────────────────────────────────────┤ seed    ⟳       │
│ window ──●── 20 s   lines [ink|voice|pitch]   grid ♩=90 │                 │
└────────────────────────────────────────────────────────┴─────────────────┘
  drawers: Voices · Sound (timbres, FX) · Live
```

### 11.3 Interactions
- **Add a moment:** from a palette (click or drag), or by shortcut at the playhead: `C` chord, `U` unison, `S` split, `M` merge, `T` shift, `P` spread, `W` walk, `I` pin, `K` key, `L` level. These shortcuts are disabled while musical typing is on (§9).
- **Edit on the lane:**
  - Drag a marker to move the moment; it snaps to the grid when one is enabled, and Alt disables snapping.
  - Drag a span end to change the glide length; Shift-drag changes the stagger.
  - Alt-drag duplicates. The copy keeps the original's effective seed (§7.7).
  - Delete or Backspace deletes.
  - Arrow keys nudge by one grid step, or by 0.1 s with no grid.
  - Select several with Shift-click or a marquee; copy and paste.
- **Selection feedback:** selecting a moment highlights the segments it produced in the score view, using `Segment.momentId`. Hovering a line shows its voice, note name and Hz.
- **Piano ruler:** with a chord or pin moment selected, clicking keys toggles notes in its NoteSet. In live mode, clicking plays.
- **Inspector:** a form for each moment type, including:
  - a chord-symbol field with live parse feedback;
  - a degree picker;
  - a preview of the easing curve;
  - a Reroll button;
  - a **Freeze** button: it replaces the moment's result with absolute targets (a `pitches` NoteSet with `assign: 'ordered'`, plus an explicit seed), so later edits to earlier moments no longer change what this moment does;
  - diagnostics for that moment shown inline.
- **Voices drawer:** pool size (1–32) and active voices at start; per voice color, timbre, pan, gain, range, mute and solo.
- **Sound drawer:** timbre presets and an editor (harmonic sliders, FM, noise, accent, articulation, vibrato), plus master FX.
- **Generate:** seed, mode, length, voice count and density produce a piece made of **moments**. This is the prototype composer ported to emit moments, so the result is fully editable. Generate ships in M3, before the editor, as the first way to make a new piece to export. Length is 30–900 s, default 2:30, with an optional "natural length" (owner, 2026-11-20).

### 11.3a UI implementation: React and the canvas
React re-renders must never sit on the per-frame or per-pointer-move path.
- **Score view:** one canvas drawn by `drawScore` in a `requestAnimationFrame` loop that reads the store directly, outside React.
- **Moment lane:** DOM/SVG, not canvas, so roving tabindex and screen-reader labels work (§11.5). A few hundred elements is fine. During a drag, pointer handlers write the marker's CSS transform directly and update a transient Zustand slice that React doesn't subscribe to. The piece is committed, which triggers a React render, an undo entry and a recompile, once per animation frame while dragging and once on release.
- **Playhead, time readout and meter** update by direct DOM writes from the animation loop, not React state.
- **React** renders panels, inspector, drawers and menus.

### 11.3b Touch editing (tablets)
Tablets such as iPads are wider than 900 px, so they get the editor. Touch rules:
- Tap selects; drag moves; dragging a span end changes the glide length.
- Long-press opens a context menu with duplicate, delete, snap on/off and stagger editing, replacing Alt and Shift.
- Nothing depends on hover. Voice, note and Hz info appears on tap.
- Pinch zooms the time window (as in the player); two-finger drag pans.

### 11.4 State, undo and persistence
- **State:** a Zustand store holding `{ piece, selection, view, transport, live }`. Each piece change triggers a recompile, coalesced per animation frame, followed by a `swap` to the worklet.
- **Undo and redo:** a history of immutable piece snapshots with structural sharing, capped at 200 entries. A whole drag counts as one entry.
- **Autosave:** to IndexedDB, debounced by 500 ms, with "My pieces" listing everything saved.
- **Storage can be evicted.** Safari deletes script-writable storage, including IndexedDB, for a site the user hasn't interacted with in 7 days of Safari use. Other browsers may evict under storage pressure. With no backend, that would silently wipe "My pieces". Mitigations:
  - call `navigator.storage.persist()` on the first save, and show whether it was granted;
  - show a "not saved to a file" marker on pieces that only live in the browser, and a one-click "Download all" (a zip of `.algorhythms.json` files);
  - on Safari, say plainly in "My pieces" that the browser may clear them after a week away;
  - on Chromium, offer to link a piece to a file on disk via the File System Access API, so autosave also writes there.
- **Files:** import and export as `.algorhythms.json`.
- **Share links:** `#p=` + base64url(deflate-raw(JSON)), compressed with `CompressionStream`.
  - **Defaults are stripped before encoding:** built-in timbres that are unchanged, a default `mix`, `view`, and any field equal to its default are omitted and restored on decode. Moment ids are 6 characters. Without stripping, a typical piece would be 3–5k characters; the target after stripping is ≤ 2,000 characters for the example pieces, checked in M5.
  - Some chat apps truncate long links, so when the URL exceeds about 2,000 characters the UI warns and offers a file instead.
  - The fragment never reaches a server.

### 11.5 Mobile, accessibility and theming
- **Priority (owner, 2026-11-20):** desktop is the focus. Phones get a usable layout, without phone-specific testing or polish beyond what exists.
- **Mobile:** below about 900 px wide the layout is player-only (transport, score view, scrubber and view controls). Editing shows a "use a larger screen" note. Tablets get the editor with touch (§11.3b).
- **iOS silent switch:** on iPhones, the ring/silent switch mutes Web Audio by default, so "phones: playback" would be silent for many users. Where supported, set `navigator.audioSession.type = 'playback'` before starting audio. Where it isn't, show a one-line hint ("turn off silent mode to hear sound") on iOS.
- **Keyboard and screen readers:**
  - Everything on the lane can also be done in the inspector with the keyboard.
  - Lane items use a roving tabindex.
  - An ARIA live region announces moment moves and edits.
  - Focus is always visible.
- **Motion and theme:** the UI respects `prefers-reduced-motion`. Light and dark themes come from tokens, carried over from the prototype.

---

## 12. Export (music first)

| Export | Milestone | Details |
|---|---|---|
| **WAV mix** | M2 | 44.1 or 48 kHz; 16-bit PCM (TPDF dither), 24-bit PCM, or **32-bit float** (what DAW users usually want). Rendered in a worker in about 1 s chunks, with progress and cancel. |
| **Stems** | M3 | One stereo (panned) WAV per voice, one FX-return stem, and the mix, delivered as a streamed `.zip` (fflate, store mode). The stems plus the FX return sum to the mix exactly (below). |
| **MIDI (per-voice tracks)** | M3 | Default. Type-1 Standard MIDI File, 960 PPQ at a tempo of 60 BPM (1 beat = 1 s), or the grid BPM if set. One monophonic track per voice, with a user-chosen pitch-bend range. Details below. |
| **MIDI (MPE)** | M3 | Option, for one polyphonic MPE synth. Details below. |
| **MIDI (notes only)** | M3 | Each arrival becomes a note; glides are dropped. Intended for notation and non-MPE synths. |
| **Piece JSON** | M4 | `.algorhythms.json` |
| Poster PNG/SVG | Later | The same renderer with the overview camera at 4K. |
| Video (MP4) | Later | WebCodecs `VideoEncoder` and `AudioEncoder` with an MP4 muxer, rendering frames offline for exact sync, in 16:9, 9:16 and 1:1. |

### MIDI details

**Shared rules (both glide-carrying modes):**
- **Notes:** note-on at birth, with the note number being the rounded starting pitch. Note-off at death.
- **Bend before note-on:** the pitch bend for a note's starting offset (the fractional part of its pitch) is sent *before* its note-on, at the same tick. Before any re-strike, the bend is reset to match the new note.
- **Glides:** pitch bend is written only during glides, at ≥ 200 events per second.
- **Out-of-range glides:** if a glide would leave the bend range, the note is ended and re-struck on a new note number nearer the glide's current pitch.
- **Options:** re-strike on each arrival (better for plucked DAW sounds); CC11 for life and level gain.

**Per-voice tracks (default).** Each voice is one track. Each track uses its own channel, wrapping after 16, because DAWs split a Type-1 file into tracks on import whatever the channels are. Every track opens with RPN 0 setting its bend range. The user chooses ±2, ±12, ±24 or ±48 semitones (default ±24), because many synths don't support ±48. There is no voice limit. In the DAW, each track gets a monophonic synth with the matching bend range.

**MPE (option).** For playing every voice through one MPE synth:
- **Layout:** an MPE lower zone, with channel 1 as the manager and channels 2–16 as members. Each voice gets one member channel and one track.
- **Zone setup:** the file starts with the MPE Configuration Message (RPN 6 on channel 1, value 15 member channels). Many synths and DAWs don't recognise an MPE zone without it.
- **Pitch-bend range:** ±48 semitones per member channel, the MPE default, also set explicitly with RPN 0 on each member channel.
- **More than 15 voices:** the export is split into several `.mid` files, each a complete MPE zone, zipped together.

### Stems: exact sums and memory
**Exact sums.** Two stages act on the whole mix: the normalisation gain g_n(t) and the nonlinear limiter. Rendering each voice "dry" would not sum to the mix whenever the limiter engages, so stems are made like this:
1. **Pass 1, full mix:** render the mix and record the limiter's per-sample gain-reduction curve g_L(t) as a Float32Array. That is about 58 MB for 5 minutes at 48 kHz.
2. **One pass per voice:** voice i × g_n(t) (computed per voice anyway, §8.4) → master tone (linear, so it distributes over the sum) → delayed by the limiter's 5 ms look-ahead, exactly as the mix is → × g_L(t). Every other voice still runs its controls and phase silently, because the unison lock couples voices (§8.4); muted voices do the same. This makes a 24-voice stems export cost about 0.46× real time of CPU (later: skip voices that can never join voice i's group).
3. **FX return stem:** the reverb and delay returns → tone → the same 5 ms delay → × g_L(t).

The voice stems plus the FX return then sum to the mix up to floating-point error. The panning and the voice's sends are the same as in the mix.

**Memory.** 24 stereo voices × 5 min × 48 kHz × 24-bit is about 2 GB, so stems must stream:
- Render one voice per pass, so memory holds one stem at a time, plus the g_L curve.
- Stream into the zip.
- On Chromium, write straight to disk with the File System Access API (`showSaveFilePicker`).
- Elsewhere, use a Blob built from parts. Offer mono stems and 16-bit as smaller options, and warn when the estimated size is above about 1 GB.
- **Formats:** 24-bit PCM or 32-bit float.
- **ZIP64:** 32 float stereo stems over 10 minutes pass 4 GB. Check in M3 whether fflate writes ZIP64. If it doesn't, write a small in-house store-mode ZIP64 writer (store mode needs no compression code, so it is a few hundred lines), or split the export into several zips under 4 GB each.

---

## 13. Attribution, naming and licensing

- **Credit:** the README credits the inspiring video with a link and states that AlgoRhythms is an independent implementation with no affiliation.
- **What not to use:** the video's title, the channel's name or branding, its section names, its piece, or look-alike thumbnails, in product naming or marketing. The general technique (pitch-versus-time lines that drive oscillators) can't be owned, but the site keeps its own visual identity.
- **Name check:** "AlgoRhythms" and close variants are likely already used by other projects. Before launch, check GitHub, npm, the domain and obvious trademark conflicts in music software. This is an owner task (§16).
- **Code license:** MIT. Dependencies must be MIT, BSD, ISC, Apache-2.0 or similar; no GPL dependencies.
- **Example pieces:** CC0.
- **FAQ statement:** "Music you make with AlgoRhythms is yours. The license covers the code, not your output."

---

## 14. Technology, repository and testing

### Stack
- TypeScript (strict), Vite, React, Zustand, Zod.
- fflate for deflate and zip.
- Small in-house WAV and SMF writers, about 150 lines each, to avoid unnecessary dependencies.
- Tooling: pnpm, Node 22 LTS, ESLint + Prettier.
- CI on GitHub Actions; deploys to GitHub Pages from `main`. WebKit end-to-end tests run on a macOS runner, because Playwright's WebKit on Linux is not Safari and may lack working audio output.
- **AudioWorklet build:** bundling a TypeScript worklet module with Vite is fiddly. The module has to be emitted as its own file and loaded by URL (`audioWorklet.addModule(new URL('./worklet.ts', import.meta.url))` or a `?worker&url`-style import), and it behaves differently in dev and production. M0 proves the pipeline: a TS worklet that plays a sine in both `vite dev` and the deployed build.

### Browser support
- **Desktop:** the latest two versions of Chrome, Edge, Firefox and Safari.
- **Phones:** Safari on iOS and Chrome on Android, for playback only.
- **Tablets:** iPad Safari and Chrome on Android tablets, with touch editing (§11.3b).
- **Web MIDI:** Chromium and Firefox only (Firefox via its site-permission add-on prompt).

### Repository layout

```
algorhythms/
  PLAN.md  README.md  LICENSE  CONTRIBUTING.md (short)
  prototype/glissando-score.html
  src/
    core/     types, zod schema + migrations, tuning, scales, chord parser, rng,
              math (portable approximations, §7.11), voice-leading, moments/*,
              compiler (event queue), query API, flatten (typed-array score)
                                                                   (no DOM, no Web Audio)
    dsp/      wavetables, oscillators, envelopes, voice, fx/*, graph (pure TS)
    audio/    worklet processor, main-thread bridge, export worker, wav + zip writers
    render/   drawScore, camera, palettes, hud
    midi/     smf writer, mpe + notes-only export, live input (Web MIDI, keyboard)
    app/      React UI: components, store, persistence, share links
  examples/   *.algorhythms.json
  tests/      unit, property, golden, dsp, e2e
  docs/       concepts.md, moments.md, file-format.md (generated schema)
```

**Import boundaries,** enforced with ESLint `no-restricted-imports`:
- `core` imports nothing internal;
- `dsp` imports only types from `core`;
- `render` and `midi` import `core`;
- `audio` imports `core` and `dsp`;
- `app` may import anything.

### Testing
- **Property tests** (Vitest + fast-check) on `core`:
  - determinism;
  - C⁰ continuity everywhere, and C¹ at interruptions except joins flagged `clamped` (§7.5);
  - **no crossings within the targeted set under `ordered`**, checked by sampling every pair of moving voices (§7.2); crossings of untargeted voices must come with an `info` diagnostic;
  - overshoot never exceeds its limit L (§7.5);
  - ranges respected;
  - pool limits respected;
  - **seed isolation:** moving moment A doesn't change moment B's draws when B's input state is unchanged, including when A changes the voice count elsewhere in the piece (§7.7);
  - **overlap semantics:** a point moment inside a walk region is never overwritten by walk steps scheduled before it (§7.1);
  - unknown fields survive load and save at every level (§5).
- **Golden tests:** each example piece's compiled output is snapshotted, and must be identical in Node, Chromium, Firefox and WebKit (§7.11).
- **Lint:** `core/` may not call non-portable `Math` functions (§7.11); import boundaries as above.
- **DSP tests** in Node:
  - no NaN or Inf;
  - peak ≤ −1 dBFS after the limiter;
  - a click detector (maximum sample-to-sample delta compared with the local signal level) on seek, swap, loop and FM fixtures;
  - unison and merge fixtures: the level of N converged voices stays within a set band of the incoherent sum (√N), never near silence (§8.4);
  - real-time factor (§8.9);
  - no garbage collection in the render loop (§8.11);
  - byte-identical repeat renders, and identical output whatever the export chunk size (§8.1);
  - stems plus the FX return sum to the mix (§12).
- **End-to-end tests** (Playwright on Chromium, WebKit and Firefox; WebKit on macOS): load, play, seek, window and colors, generate, export a WAV and MIDI, add/move/undo a moment, round-trip a share link.

---

## 15. Milestones

Sizes are relative: S < M < L < XL. Every milestone ends with a deployable site.

**Ordering rationale (revision 2).** D4 makes audio export a high priority. MIDI export needs only `core` (M1), stems need only the engine (M2), and Generate already exists in the prototype. So Generate and all audio exports ship in M3, before the editor. The first public release is then useful on its own: generate a piece, hear and see it, and take it into a DAW. The former XL editor milestone is split in two (M4, M5).

**M0. Scaffold (S)**
- Repo, LICENSE, README stub, CI (including a macOS runner for WebKit), and a GitHub Pages deploy of a placeholder page; the prototype is committed.
- The AudioWorklet build pipeline is proven (§14).
- *Accept when:* CI is green, the site is live, and a TypeScript AudioWorklet plays a sine in both `vite dev` and the deployed site on Chromium, Firefox and WebKit.

**M1. Core compiler (L)**
- Types, schema (passthrough objects, version policy), tuning (12-TET), scales, chord parser, counter-based RNG (§7.7), portable math (§7.11).
- The event-simulation compiler with overlap rules (§7.1).
- Voice leading: ordered injective and surjective, plus free; crossing enforcement (§7.2).
- Interruption with carried velocity and the overshoot clamp (§7.5).
- Voicings; moments chord, unison, split, merge, shift, spread, walk, pin, key and level; diagnostics; query API; flattening to typed arrays (§8.11).
- The prototype composer ported as `generate(seed, opts) → Piece`.
- **Example pieces:** 4–6 pieces, made with `generate()` and then hand-edited as JSON, released as CC0. They feed the golden tests and the M3 gallery, so they can't wait for the editor.
- *Accept when:*
  - the property and golden tests pass, including the cross-engine golden test;
  - the compile target in §7.10 is met;
  - for 20 seeds, `generate()` produces the same section sequence and the same active-voice count per section as the prototype's `compose()`, and compiles with no `error` diagnostics;
  - the owner listens to five generated pieces (rendered with a temporary Web Audio harness) and judges them at least as musical as the prototype's.

**M2. Sound engine and WAV export (L)**
- The DSP graph (§8.4) with always-on detune, the six M2 presets (§8.5), the send-based FX (§8.6), tone and limiter.
- The worklet host and bridge: play, pause, seek, loop, hot-swap, clock anchors and latency hint (§8.3), the allocation-free discipline and wavetable worker (§8.11).
- The export worker with WAV output (16-bit, 24-bit, 32-bit float).
- An internal fixture page for listening tests (not linked publicly).
- *Accept when:*
  - the DSP tests pass, including the unison/merge level and no-GC tests;
  - the real-time factor is ≥ 10× in Node with 24 voices and FX (§8.9);
  - two exports of the same piece are byte-identical, and so are exports with different chunk sizes;
  - there are no audible clicks on seek, loop or swap, checked both with the click detector and by ear on fixtures.

**M3. Player, Generate and audio export: first public release (L)**
- The renderer, camera, window, colors, scrubber and HUD.
- Transport with a meter; examples gallery; load from a file or link; themes; phone layout; the iOS audio session (§11.5).
- The Generate panel (§11.3).
- Exports: stems with exact sums, streamed (§12); MIDI as per-voice tracks, MPE and notes-only; export options and progress UI.
- *Accept when:*
  - 60 fps at 1080p with 24 voices on a mid-range laptop;
  - the Playwright suites pass on all three engines;
  - a first-time visitor can press play and hear a piece within 3 s of the page loading;
  - on an iPhone with the silent switch on, playback is audible, or the hint is shown where the audio session API is missing;
  - 32-bit float stems plus the FX return sum to the mix with a residual ≤ −90 dBFS;
  - the per-voice-track MIDI and the MPE file both play their glides correctly in at least two DAWs (an MPE synth for the MPE file), using whichever DAWs the owner has;
  - a 5-minute, 24-voice stems export stays under about 500 MB of peak memory on Chromium.

**M4. Editor core (L)**
- The lane as DOM/SVG with direct-transform drags (§11.3a), palette, shortcuts, inspector (with Reroll), voices drawer.
- Undo/redo, autosave and My pieces with the eviction safeguards (§11.4), JSON import/export.
- *Accept when:*
  - a new user can build a 1-minute piece from the empty template with the mouse alone;
  - every action can be undone;
  - an edit made during playback is heard within 50 ms, with no clicks;
  - persistent storage is requested and its status shown, and "Download all" exports every piece.

**M5. Editor completion (M)**
- Piano ruler; multi-select, marquee, copy and paste; Freeze (§11.3).
- Share links with default stripping (§11.4).
- Touch editing for tablets (§11.3b).
- *Accept when:*
  - share links round-trip exactly;
  - every example piece's share link is ≤ 2,000 characters;
  - adding, moving, editing and deleting moments works by touch alone on iPad Safari.

**M6. Timbre depth (M)**
- FM with a separate modulator phase, noise, the stretch/additive path, the harmonic editor, per-voice timbre, the `timbre` moment, preset save and load, bell and more presets.
- *Accept when:* preset changes during playback cause no clicks; preset files round-trip; and the click detector passes on FM fixtures with non-integer ratios.

**M7. Live instrument (M)**
- Musical typing mode, Web MIDI input, live voice leading with no debounce delay, the live panel, the switch to an `'interactive'` context, and recording into silence with chord merging (§9).
- *Accept when:*
  - key-to-glide start is ≤ 10 ms plus device output latency;
  - a recorded take plays back with pitch paths matching the live ones within 1 cent and 1 block;
  - while musical typing is on, no editor shortcut fires from a letter key.

**Later, in no order:**
- poster PNG/SVG;
- video export;
- camera moments;
- mirror, arpeggio and drift moments;
- Scala tunings;
- MIDI CC learn;
- PWA and offline use;
- an npm package for `core` with a code-first API;
- localisation.

---

## 16. Open decisions for the owner

**All answered by the owner on 2026-11-19. Implementation is approved and has started.**

1. **License:** MIT, confirmed (D7).
2. **Time model:** seconds, with an optional BPM snap grid, as proposed (D9).
3. **Testing DAWs:** the owner can get FL Studio but has none yet. In M3, MIDI is first verified automatically: the exported files are parsed back and the pitch paths are checked against the compiled score. The DAW check happens when FL Studio is available. A second DAW (for example REAPER's free evaluation) is optional.
4. **Hosting:** GitHub Pages under a github.io address for now.
5. **Name:** proceed even if the name is taken elsewhere. The project is renamed **AlgoRhythms** (plural) everywhere, including file names, the `.algorhythms.json` extension and the `format` field.
6. **Voice pool:** 32 is enough.
7. **Milestone order:** confirmed. The owner wants Claude to manage the implementation through subagents and report at milestones.

---

## 17. Reviewer questions

### 17.1 Resolved in the first review

1. **Moment abstraction.** The set was missing a way to change key, and dynamics were too late. Added the `key` moment and moved `level` into v1 (§6.2). Nothing was found redundant.
2. **Cascading edits.** Acceptable, since it's inherent to state-dependent moments. Added Freeze (§11.3), counter-based draws (§7.7), and duplicates that keep their seed.
3. **Interruption semantics.** Keep velocity carry-over, but as an additive term on the chosen ease, so the ease is kept and p₁ = p₀ works. Overshoot is clamped to min(1 semitone, gap to neighbour) (§7.5).
4. **TypeScript DSP.** The budget is realistic; the op estimate was corrected to 50–100 per sample. One RTF target is set (§8.9) and the allocation-free discipline is spelled out (§8.11).
5. **Wavetables vs additive.** Keep wavetables. With ≤ 32 harmonics, only the top few octaves need distinct mips. Per-sample additive with `Math.sin` would be too expensive (§8.4).
6. **Inharmonic timbres.** Keep `stretch`, on a 16-partial additive path using the shared sine table, in M6 (§8.5).
7. **Clock.** Derive the playhead from context-time anchors; `pos` only corrects drift. Avoiding SharedArrayBuffer is right for GitHub Pages (§8.2–§8.3).
8. **Stems memory.** One pass per voice plus a streaming zip is sound, with a per-sample limiter gain curve for exact sums and a ZIP64 check (§12).
9. **MIDI export.** Per-voice tracks with a user-chosen bend range are now the default. MPE is an option and gains the MPE Configuration Message and bend-before-note-on (§12).
10. **React.** Keep React for panels only. The score is a canvas drawn outside React, and the lane is DOM/SVG with direct-transform drags (§11.3a).
11. **Live mode scope.** "Record into silence" is enough for v1 (§9).
12. **Scope.** M4 was split into M4 (editor core) and M5 (editor completion) (§15).

### 17.2 Second-review questions: integrator defaults (2026-11-19)

The owner approved implementation without a second review. The integrator settled each question below by keeping the plan as written. Each is revisited at the point named, by ear where it is about sound:
1. Keep timing merges. Listen in M1; if fan-outs sound too uniform, add a per-moment `crossings: 'allow'` option.
2. Keep the ordering. M1's property tests cover the overlap cases.
3. Keep min(1 semitone, gap). Tune in M7.
4. Keep the 1-cent floor. Judge the `sine` preset by ear in M2.
5. Keep ±24.
6. Keep the ban. It is cheap and already specified.

The original questions follow for reference.

1. **Crossing enforcement** (§7.2). Merging the timings of voices that would cross makes staggered fan-outs more uniform where voices are close. Is that musically acceptable, or should `ordered` moments get a "let lines cross mid-glide" toggle instead?
2. **Event ordering** (§7.1). At equal times, moment events come before move starts, which come before walk ticks. Is there a case where this gives a surprising result?
3. **Overshoot limit** (§7.5). Is min(1 semitone, gap) the right limit for live play, where fast re-targeting is common?
4. **Detune floor** (§8.4). Does a mandatory ≥ 1 cent detune keep the `sine` preset sounding pure enough?
5. **MIDI default** (§12). Is ±24 semitones the right default bend range for per-voice tracks?
6. **Portable math** (§7.11). Is banning native transcendental functions in `core/` the cheapest way to guarantee cross-engine compiles, or is rounding before comparison enough?
7. **Anything** that contradicts the owner's decisions (§2) or the goals (§1).

---

## 18. Changelog

### Revision 4 (2026-11-20): owner rulings after the first M3 release
- **Unisons (§8.4):** glides into and out of a unison are warped (up to ~60 cents) so approach and parting stay steady.
- **Colors (§10):** "Per voice" removed; "By pitch" is the default. **HUD (§10, §7.9):** shows the current chord (`chordAt`). **Generate (§11.3):** 30–900 s, default 2:30.

### Revision 3 (2026-11-20): unison lock
- **Unisons (P2, §3, §7.4, §8.4, §8.5, §8.7, §12):** converged voices are steady by default (owner decision). A per-block group pass locks pitch and phase and holds the group at the chord level; detune is no longer mandatory as the safeguard. A new Timbre field `wobble` and preset `wobble` give the old beating as an opt-in. Stem passes run every voice silently.

### Revision 2 (2026-11-19): first review incorporated
- **Compiler (§7.1):** replaced the one-pass loop with an event simulation, covering committed destinations, cancellation of pending moves, and walk/moment overlap rules.
- **Crossings (§7.2):** voices are sorted by committed destination and tie-broken by pool index. Mid-glide crossings are enforced against by timing merges, and the guarantee is scoped to the targeted voices.
- **Interruption (§7.5, §7.9):** velocity carry-over is an additive term on the chosen ease, which handles p₁ = p₀. `Segment` gains `m0` and `clamped`; the `HermiteEase` type is gone. Overshoot clamp added.
- **Randomness (§7.7):** counter-based draws keyed by moment, voice, step and purpose. Duplicates keep the original's seed.
- **Determinism (P2, §7.11, §8.1, §8.10):** added portable-math rules for `core/` and a cross-engine golden test. Both hosts use fixed 128-frame blocks. The "preview = export" claim is narrowed to playback from t = 0.
- **Moments (§6.2):** added `key`; moved `level` from M6 into v1.
- **Unisons (§3, §7.4, §8.4):** detune is always on, with a 1-cent floor; the seeded starting phase is no longer claimed to prevent phase-summing.
- **DSP (§8.4–§8.6):** fixed the FM modulator phase, added the shared sine table, moved FX to a send-based topology, and resolved inharmonic timbres with the additive path. Presets are named per milestone.
- **Worklet (§8.2, §8.3, §8.11):** typed-array scores sent as transferables, wavetables built in a worker, clock anchors, `latencyHint`, and allocation-free rules.
- **Performance (§8.9):** a single RTF target (≥ 10×) replaces two inconsistent ones. The op estimate is corrected, and the no-op "32-voice cap" fallback becomes a 16-voice cap.
- **Live mode (§9):** musical typing is a mode, so it can't collide with editor shortcuts. The debounce delay is removed; chord grouping now happens through re-targeting. Firefox Web MIDI prompt noted.
- **Editor (§11.3–§11.5):** added Freeze, the React/canvas split, touch editing for tablets, storage-eviction safeguards, share-link default stripping, and the iOS silent-switch fix.
- **Export (§12):** added 32-bit float. Stems sum exactly via a shared limiter gain curve. MIDI defaults to per-voice tracks, and MPE gains the configuration message and bend-before-note-on. Added a ZIP64 check.
- **Repository and testing (§14):** M0 proves the worklet build pipeline, WebKit tests run on macOS, and the property and DSP tests were updated to match the above.
- **Milestones (§15):** Generate, stems and MIDI move into M3. The editor is split into M4 and M5. Example pieces are made in M1. Every acceptance criterion is measurable; the "visually equivalent" criterion was replaced.
- **Owner decisions (§16):** added item 7 on milestone order.
- Fixed a dangling reference to §7.12.
