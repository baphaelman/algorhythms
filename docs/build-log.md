# Build log: deviations and decisions

Newest milestone first. Each entry says what departs from (or fills a gap in) PLAN.md, and why. PLAN.md itself is owned by the integrator and is not edited by builders.

---

## M2: sound engine and WAV export (2026-11-19)

### What exists
- **`src/dsp/`** (pure TS, no DOM): `graph.ts` (the graph and transport), `voice.ts`, `wavetable.ts` (pure table builder), `timbre-slot.ts`, `sine.ts` (shared 4096-point table), `rng.ts`, `mix.ts` (param paths, FX tail), `constants.ts`, `fx/{reverb,delay,tone,limiter}.ts`.
- **`src/audio/`**: `engine.ts` (`AudioEngine`), `worklet/engine.worklet.ts` + `engine-protocol.ts`, `tables.ts` + `tables.worker.ts`, `wav.ts` (writer and parser), `wav-export.ts`, `export.worker.ts` + `export-client.ts`, `offline.ts`, `timbres.ts`, `fixtures/{scores,page}.ts`.
- **`src/core/timbres.ts`**: `BUILTIN_TIMBRES`, the six M2 presets (data only).
- **`fixtures.html`**: the hidden listening page, a second Vite entry (`build.rolldownOptions.input` in vite.config.ts, additive).

### Graph API (for M3 and M7)
- `new Graph(sampleRate)`; `load(flat, mix)` (stops, position 0, clears FX); `swap(flat)`; `setTables(name, wavetableSet, fade = 0.02)`; `setMix(mix)`; `setParam(path, value)` (paths in dsp/mix.ts, including `voices.<id|index>.gain|pan|mute|solo|sends.reverb|sends.delay`).
- Transport: `play(from?)`, `pause()`, `seek(t)`, `setLoop(start, end)`, `clearLoop()`. All are applied at the next block boundary. `process(outL, outR)` renders exactly 128 frames.
- After each `process()`: `events` (`GraphEvent.Anchor | Ended`), `anchorPieceTime`, `anchorPlaying`, `anchorReason`, `position`, and the meter accumulators (`meterPeakL/R`, `meterSumSq`, `meterFrames`, `resetMeter()`).
- **Stems hooks (§12):**
  - `setRenderMode(RenderMode.Voice, i)` renders voice i's dry signal only; `RenderMode.Fx` renders the reverb and delay returns only. Both go through the same tone stage and limiter delay.
  - `setLimiterCapture(f32)` records g_L per output frame; `setLimiterReplay(f32)` applies it.
  - `offline.ts renderOffline(input, frames, part)` wraps all of this.
  - **Exact sum:** Σ voice stems + FX stem − mix = **−144 dBFS** in float, with the limiter pulling 4+ dB (tests/dsp/stems.test.ts).
- **`AudioEngine`** (main thread):
  - setup: `AudioEngine.create({ context?, latencyHint = 'playback', connect = true, preload? })`;
  - transport and data: `load(score, mix, timbres?)`, `play(from?)`, `pause()`, `seek(t)`, `loop(range | null)`, `swap(score, timbres?)`, `param(path, value)`, `setMix(mix)`;
  - clock and state: `currentTime()`, `isPlaying`, `duration`;
  - callbacks: `onMeter`, `onEnded`, `onError`;
  - teardown: `dispose()`.
- **Export:**
  - main thread: `exportWav({ score, mix, timbres?, sampleRate: 44100 | 48000, bitDepth: 16 | 24 | 32, chunkSeconds?, onProgress?, signal? }) → Promise<Blob>`, or `exportWavStream(...)` → `ReadableStream<Uint8Array>`;
  - pure, without a worker: `wavExportChunks()` / `renderWav()` in wav-export.ts.

### Decisions
- **Control rate.** Pitch, envelopes, pan and the mip choice are evaluated every 16 frames, and phase increment, amplitude and pan gains are interpolated linearly per sample. This is §8.9 fallback 1, adopted from the start: it costs nothing audible and keeps the 24-voice budget comfortable.
- **Detune (§8.4):**
  - the sign alternates by pool index (odd +, even −, as in the prototype);
  - the magnitude is 1.5 + 2.5·u(hash(id)) cents;
  - `detuneSpread` adds spread·u′(hash(id)), with |detune| ≥ 1 cent always.
  - Start phase: hash(id, piece seed). The vibrato LFO phase is seeded the same way.
- **Life fades:** smootherstep in amplitude, at least 5 ms (so `fadeIn: 0` at t = 0 or a zero merge fade can't click). **MIDI CC11 (M3) must follow smootherstep.**
- **g_n:**
  - 1/√max(1, Σ life weights) over *every* pool voice, muted or not, so mute and solo don't change the other voices' levels (as on a mixer);
  - smoothed by a 50 ms one-pole at control rate, and re-initialised on play, seek and loop jumps;
  - ghosts (below) freeze the g_n they had.
- **Motion accent** uses core's `segmentMotion` (P1), smoothed over 15 ms, because sin(πx) restarts at 0 on an interrupted glide and would otherwise step the gain.
- **Articulation:**
  - an envelope triggered at birth and at every glide→hold arrival: gain = (1 − amount) + amount·env;
  - the attack is linear from the still-decaying previous envelope (two quick arrivals don't dip);
  - `decay` is the time to fall to 1 % (−40 dB).
- **Vibrato:** holds only; it fades in over 0.25 s after `delay`, and its depth is smoothed (40 ms) so it stops without a pitch step when a glide starts.
- **Pan:** equal power. Auto by index uses the prototype's alternating spread; auto by pitch is (p − 60)/40, clamped to ±0.8.
- **Sends** are mono (post-g_n, pre-pan): the reverb is mono-in/stereo-out, and the ping-pong takes a mono input.
- **Wavetables:**
  - 2048 points + guard, 11 mips from 20 Hz;
  - band-limited conservatively: mip m keeps partial n only if n·(top of its octave) ≤ Nyquist, so nothing ever aliases;
  - brightness tilt baked per mip (`track` follows pitch at 3 dB/oct per octave from C4, clamped −2…+3 octaves);
  - normalised so every preset has unit-sine RMS at C4; fixed Schroeder-like phases per partial, so mips and timbres crossfade without combing.
- **Timbre changes:** the timbre timeline crossfades A→B linearly. Tables replaced during playback fade from old to new over 20 ms; the old tables stay until the new ones arrive (§8.11).
- **Levels:** loudness tilt 2^(−(p − 57)/48), as in the prototype; base voice gain 0.25.
- **Limiter:**
  - 5 ms look-ahead: a sliding minimum over D + 1 frames, 80 ms release, a box filter over D frames. This provably never exceeds the ceiling (proof in fx/limiter.ts);
  - ceiling −1 dBFS minus 1e-6;
  - the gain is always rounded to float32, so a captured g_L replays bit for bit.
- **Reverb:**
  - an 8-line FDN with a Householder matrix, 4 input allpass diffusers, a smoothed fractional pre-delay, per-line one-pole damping, and RT60-calibrated gains;
  - size scales the line lengths 0.4–1.5×, smoothed (gliding lengths, no clicks);
  - output gain set so M1a's default mix puts the return about 10 dB under the dry signal. **Owner: tune by ear.**
- **Delay:** ping-pong, gentle low-pass in the feedback, delay time glides when changed.
- **Tone:** five first-order high shelves two octaves apart (40 Hz…10 kHz) approximate a dB/octave tilt, normalised at 1 kHz; RBJ Butterworth low-pass, bypassed at ≥ 98 % of Nyquist.
- **Export length:** duration + FX tail (reverb decay + pre-delay, or the delay's repeats down to −60 dB, capped at 20 s) + 50 ms, in whole blocks; no end fade.
- **WAV:** 16-bit with TPDF dither seeded by the piece seed (±1 LSB; chunking doesn't change it), 24-bit undithered, 32-bit float as WAVE_FORMAT_IEEE_FLOAT with an 18-byte fmt chunk and a `fact` chunk.

### Deviations from PLAN.md
1. **Seek, pause and play crossfade over 5 ms instead of fade-out → jump → fade-in (§8.7).**
   - Every sounding voice is copied into a "ghost" that keeps playing the old position while fading out (equal power), and the voice fades in at the new position. Loop wraps work the same way, as §8.7 asks.
   - Effect: no 10 ms gap and no 5 ms delay before the jump; click-freedom is tested.
   - There are 64 ghosts. A seek or swap that finds too few free waits a block or two; a loop wrap steals the most-faded ghost.
2. **The DSP calls core's raw `segmentPitch` and `segmentMotion` with the record's fields,** not the `evalFlatSegment*` wrappers. It is the same code (P1); the wrappers' frames used up V8's inlining budget (see below).
3. **Allocation-free `process()` holds for smootherstep, smoothstep, linear and cosine glides,** and for everything else in the graph: 60 s with 24 voices + FX gives 0 GC lines.
   - **`expo` and `bezier` glides still allocate.** TurboFan inlines at most 920 bytecode bytes per compilation. The whole `easeRaw` chain (segmentPitch 172 + easeRaw 320 + sinPiPoly 59 + exp2 122 + pow2Int 96 + bezierValue 123 + bezierSolveT 284 = 1176) cannot fit in any one unit, so their calls box doubles.
   - Worst case measured: 57 scavenges per 60 s with 24 voices gliding nonstop and 2 of 7 glides expo or bézier; typical pieces (smootherstep is the default) see none.
   - **Proposed fix (M6 or M7, if wanted):** in the message handler, precompute each expo or bézier segment's pitch on a 128-frame grid with `segmentPitch` itself, and interpolate on the audio thread (exact at grid points, < 0.2 cent between).
4. **The RTF gate uses this process's CPU time (best of five 6 s runs), not wall time.** Vitest runs test files in parallel, and wall time includes waiting for a core.
5. **Additions to §8.2:**
   - a `mix { mix }` message;
   - `anchor` carries `playing` and `reason`;
   - `AudioEngine.create({ preload })` passes score, mix and tables in `processorOptions`, because an OfflineAudioContext can render before port messages arrive (seen in Chromium).
6. **M0's test-tone placeholder is kept.** src/app (not M2's) still uses it. M3 should switch the App to `AudioEngine` and then delete src/dsp/test-tone.ts, src/audio/test-tone.ts, the test-tone worklet and protocol, tests/dsp/test-tone.test.ts and the test-tone parts of tests/e2e/worklet.spec.ts. tests/e2e/audio.spec.ts already covers "the engine worklet loads in dev and prod".
7. **A voice stem is that voice's dry signal;** its send contributions are in the FX stem (needed for the exact sum).

### V8 rules for anything in `process()` (learned the hard way)
1. **Initialise every numeric class field where it is declared** (`x = 0`, not `x: number;`). A field that starts as `undefined` gets Tagged representation, and every double that flows through it is boxed. This was the limiter's per-sample allocation.
2. **Don't merge a float64 with an imported constant in a ternary** (`a > MIN ? a : MIN`). Imported bindings are loaded as tagged cells, so the phi is tagged and the float64 gets boxed. Use `Math.max`.
3. **Don't pass doubles to, or return them from, calls that TurboFan might not inline.** Pass frame numbers (Smis) and keep doubles in Float64Arrays. The voice's persistent state lives in `Voice.st`.
4. **Keep the per-tick work in one large method** (`Voice.render`, which is over the 460-byte inlining limit), so its own inlining budget goes to the core segment functions.
- The no-GC test (tests/dsp/no-gc.test.ts) fails if any of this regresses.

### Results (macOS 26.4, Apple Silicon)
| Check | Result |
|---|---|
| RTF, 24 voices + reverb + delay + tone + limiter, 48 kHz, every ease | **19–26×** standalone, ~13× while the other test files run in parallel (gate ≥ 10×) |
| No GC | 60 s of audio after a 10 s warm-up, in a child `node` with `--trace-gc` on for exactly that span: **0 GC lines, 0 'gc' observer entries** |
| Click detector: worst \|Δx\| / local RMS; threshold = 2 × the clean render's worst | sine 0.122, organ 0.49, pluck 0.34. **Worst observed** (seek + scrub + pause/play / loop): sine 0.063 / 0.051, organ 0.196 / 0.188, pluck 0.122 / 0.132. Swap: sine 0.066 (clean 0.086), organ 0.330 (clean 0.309). Hard-cut control: 2.79, 3.42, 0.99 |
| Unison band (N = 2…32, 6 id sets each; relative to one voice alone, which equals the incoherent √N sum after g_n) | 9 s hold average 0.80–1.42 (band [0.5, 1.6]); quietest 0.5 s window ≥ 0.25 (floor 0.1) |
| Merge (12 id sets) | 0.25 s windows 0.53–1.41 × one voice (band [0.4, 1.6]) |
| Stems | Σ stems + FX − mix = −144.3 dBFS |
| Exports | byte-identical repeats at 16/24/32-bit; identical for chunk sizes 1 s, 0.37 s, 1 block and 2.5 s |
| e2e, M0's 4 tests + 7 new per project | Chromium, Firefox and WebKit, dev and prod: **66/66** |

### For the owner's ears
- **Fixture page:** `pnpm dev`, then http://localhost:5173/fixtures.html. After a deploy it is at `/<repo>/fixtures.html`.
  - fixtures: unison of 8, merge, long glide, a 30 s stress piece, one fixture per preset, 24 dense voices, and a swap pair;
  - Stress buttons: seek ±2 s, a 20-seek scrub burst, loop 2–4.5 s, hot-swap A ↔ B;
  - WAV download at 16, 24 or 32 bits and 44.1 or 48 kHz.
- **§17.2 item 4 (does the 1-cent floor keep `sine` pure?):**
  - A single sine voice stays a pure sine, just 1.5–4 cents off pitch (the floor only bites when a timbre's `detuneSpread` is negative).
  - Unisons beat slowly instead: opposite-sign neighbours are at least 3 cents apart, a beat of ≤ 1.6 s at A3; same-sign pairs can drift much more slowly.
  - Listen to `a4-sine`, `preset-sine` and `unison-8`.
- **Also by ear:**
  - the six preset sounds;
  - the reverb level at the default mix;
  - the pluck's sustain level (articulation amount 0.9 leaves 10 % between strikes).

---

## M1a: rng, scales, chords, math, tuning, file format, defaults, generate (2026-11-19)

### `core/rng.ts` (§7.7)
- `mix32` is murmur3_32 over four little-endian words with seed 0 (checked against a reference implementation). `hash32` uses murmur3 rounds with a type tag per part (string, uint32, int32, float) plus the length, so `hash32('a')` ≠ `hash32(97)` and part boundaries count. Strings hash their UTF-16 code units; integers in [−2³¹, 2³²) hash as one word; other numbers hash their IEEE 754 bits through a DataView; NaN hashes a fixed word, because `setFloat64` may write any NaN pattern. `toUnit` = u / 2³² (32-bit resolution).
- `Purpose` keeps codes 1–10 as specified and adds **11–14 for `generate()`** (GenTiming, GenChord, GenRegister, GenId). The list is append-only.
- Extras: `fmix32`, `randHashed` (pre-hashed voice id), `randInt`, `base62Id` (each of the 6 characters is drawn separately, so even the first one is uniform). Use `''` as the voice id for moment-level draws.
- `flat.ts`'s `hashVoiceId` stays FNV-1a (M0). It belongs to the DSP, and switching would change existing pieces' seeded detune for no gain.

### `core/scales.ts` (§7.8)
- **Global degree index:** index k·n + j is degree j (0 = tonic) of the octave starting at tonicPc + 12k. It is monotone in pitch, and index mod n is the scale degree.
- `snapToScale` works for fractional pitches, returns integers, and sends ties down. `stepByScale` snaps, then steps.
- `degreesToPcs` is positional (one pc per input degree, not deduplicated) and wraps both ways: in A dorian, degree 9 is degree 2 (C) an octave up.
- Custom scales are normalised (mod 12, rounded, sorted, deduplicated, 0 added; an empty one becomes [0]); the schema rejects malformed ones before they get here.
- Extras: `parsePitchClass` (also Cb, E#, double accidentals, Unicode ♯/♭), `noteName` (60 = C4), `scaleIntervals`, `isScaleTone`, `pitchesWithPcs` (the candidate list for §7.3 voicings), `SCALE_NAMES`, `SHARP_NAMES`/`FLAT_NAMES`.

### `core/chords.ts` (§7.3)
- **Roman numerals are measured on major-scale degrees from the tonic, whatever the key's scale** (I = 0, II = 2, III = 4, IV = 5, V = 7, VI = 9, VII = 11 semitones; b/# move the root a semitone). So `bVII` is a whole tone below the tonic in every mode (the convention the plan's `bVII` example belongs to), and numerals work in pentatonic and custom scales. Consequence: in minor-type modes, write `bIII`, `bVI` and `bVII` for the diatonic chords; `III` in A dorian is C♯ major.
- Case sets the default quality (lower-case = minor); suffixes override it (`vii°7`, `viiø7`, `III+`). After a lower-case numeral, `M7`/`maj7`/`Δ` adds a major seventh to the minor triad (`iM7` = mM7).
- After a numeral, `/` plus a numeral is an applied chord (`V7/V`); `/` plus a note name is a slash bass. After a letter chord, `/` is always a bass.
- `pcs` are in stacking order from the root, without duplicates; a slash bass that is not a chord tone is appended last.
- Lead-sheet conventions: `11` on a major-quality chord omits the 3rd; `13` on a major-quality chord omits the 11th; `alt` = 1 3 b7 b9 #9 #11 b13; `6/9` is accepted.
- Not supported: figured-bass inversions (`I6` means an added sixth), `C2`/`C4`, and lower-case letter roots (the error suggests the capital).

### `core/math.ts`, `core/tuning.ts`
- `math.ts` re-exports `sinPi`, `cosPi` and `exp2` from `ease.ts`. It adds a portable `log2` (an atanh series after splitting off the exponent bits; exact on powers of two, about 1 ulp elsewhere), plus `clamp`, `lerp` and `mod`.
- `tuning.ts`: `hzOf(p, referenceHz = 440)`, `pitchOfHz` and `DEFAULT_REFERENCE_HZ`.

### File format: `core/schema.ts`, `core/migrations.ts`, `core/defaults.ts` (§5)
- **Required in a file:** `format`, `version`, voice ids, each moment's `id`, `type` and `at`, and each moment's essential fields (`split`/`merge` `count`, `chord.notes`, `shift.by`, `spread.factor`, `walk.until`, `pin.voice` and `pin.pitch`, `key.key`, `level.gain`), plus `timbre.harmonics`. **Everything else defaults** (values in `core/defaults.ts`, listed in docs/file-format.md):
  - `meta`: title `'Untitled'`, created and modified `'1970-01-01T00:00:00.000Z'` (core has no clock; the app stamps real times);
  - `seed` 0; `tuning` 440 Hz, 12-TET; `key` A dorian; `defaults.glide` {3, 0.2, 0.8, random, smootherstep} (the §5 example);
  - `voices`: the default 12-voice pool v1–v12 (glass, pan auto, gain 1, range [38, 84], the prototype's register); `start` []; `moments` []; `timbres` {}; `end.fade` 6;
  - `mix`: reverb {size 0.7, decay 3.2 s, damping 0.45, pre-delay 0.02 s, return 0.35}, delay {0.375 s, feedback 0.35, **return 0 = off**}, sends {reverb 0.5, delay 0.25}, tone {tilt 0, low-pass 20 kHz}, limiter −1 dBFS, panAuto 'index'. M2 may retune the reverb by ear;
  - `view`: window 20 s, colors 'voice', HUD on;
  - moments: chord voicing 'even', assign 'ordered'; unison pitch 'center', octaves false; split voicing 'even'; merge which 'top', fade 2 s; shift unit 'semitones'; spread around 'mean', snap 'scale'; walk grid 1 s, density 0.45, steps [−2, −1, 1, 2], stepGlide 0.3 s; level over 1 s;
  - timbres: neutral values for everything but `harmonics`.
- **Errors:** duplicate moment ids, duplicate voice ids, more than 32 voices, `start` naming a voice that is not in the pool or naming one twice, a range with low > high, malformed custom intervals, negative times. References inside moments (`pin.voice`, `{ voices: [...] }`) are left to compiler diagnostics.
- **Newer versions:** the file opens with a warning and `newerVersion: true`. Its `version` is kept as written, so at runtime `piece.version` can exceed PIECE_VERSION even though the type says `1`; rewriting it to 1 would make a newer build re-migrate data that is already in its format. Moments of unknown types in a newer file are kept in place, untouched, with a warning. **M1b: `compile` must skip moments whose type it doesn't know.** In a current-version file, an unknown type is an error.
- Unknown fields survive everywhere except a key named `__proto__`, which Zod drops (a prototype-pollution guard). A property test found and fixed a bug where unknown fields named `valueOf`, `constructor` and so on were dropped on save.
- `parsePiece(json, { migrations? })` accepts JSON text or a value, never throws, works on a private copy, and adds `migratedFrom` to the success result. Error lines read `moments[3].count: …`; for unions it reports the branch the author evidently meant.
- `serializePiece`: known keys in schema order, unknown keys alphabetically, Prettier-like layout (width 100, short values inline, number arrays filled), final newline. Idempotent.
- Migrations: a `Map` keyed by the version a step reads; `migratePiece` runs v → v + 1 until current. Empty for v1; tested with a fake v0 → v1 step.
- **`pnpm docs:schema`** (`scripts/docs-schema.mjs`) loads `scripts/file-format-doc.ts` through Vite's `runnerImport` (no new dependency) and writes docs/file-format.md: rules, the defaults table, and `z.toJSONSchema` in input form. A unit test fails when the file is stale. `package.json` gains the script entry (additive).
- `newPiece` copies the voices' built-in timbre into `piece.timbres`, so a file is self-contained (as in the §5 example); M5's share links strip unchanged built-ins (§11.4). `defaults.ts` also exports the frozen `DEFAULT_*` constants, `MOMENT_DEFAULTS`, `TIMBRE_DEFAULTS`, copy factories, `cloneJson`, `setOwn` and `builtinTimbresFor`, for M5's default stripping.

### `core/generate.ts` (§11.3, §15)
| Prototype section | Moments |
|---|---|
| Seed | `start`: v1 at A3 (57) |
| Split | 4 × `split` (3, 5, 8, 12) with explicit `pitches` (the prototype's voicing) |
| Drift | 6 × `chord`: `degrees` [c, c+2, c+4, c+6], `register` = the prototype's span around a drifting centre, voicing 'even' |
| Gather | `unison` on the chord tone nearest the centre |
| Burst | `chord` with explicit `pitches`: the bass on degree c, plus an (n − 1)-note fan |
| Walk | `walk`: 24 ticks on a 1 s grid, density 0.45, steps ±1–2, stepGlide 0.27 s, bass leaps [5, 12] |
| Thin | 2 × `chord` with explicit `pitches`: three notes, the voices in three equal groups |
| Home | `unison` on A3; `end` = 13.5 s later, fade 6 s |

- The first moment of each section is labelled with the section name. Ids are 6 base62 characters from `mix32(seed, index, attempt, GenId)`, re-drawn on a collision. Draws are keyed by stream and index, and the mode is not part of the key, so changing density changes only the walk, and the 7-note modes share timing and chord degrees, as in the prototype.
- **Musical differences from the prototype:**
  - The prototype's per-voice durations, uniform in [a, b], become glide length (a + b)/2 and jitter (b − a)/(a + b); its stagger stays the stagger. The compiler draws the actual values (order 'random').
  - Split, Burst and Thin use explicit pitches: `split` has no `register` field, and the bass-plus-fan and equal-group voicings cannot be expressed otherwise. Drift uses degrees, so it stays editable; M1b's 'even' uses the prototype's index formula, so the notes are the same.
  - The walk grid is a fixed 1 s; the prototype picked 0.75, 1, 1 or 1.5 s per tick. The prototype's start offsets (≤ 0.1 s) and step lengths (0.22–0.32 s) become `glide: { stagger: 0.1, jitter: 0.185 }`; whether that applies depends on how M1b treats `glide` on walks.
  - Births fade in over max(0.5 s, length/2) = 1.6 s, where the prototype used 1.4 s. Crossing enforcement (§7.2) may merge timings.
  - A different RNG, so a given seed gives different timings and chords than in the prototype; the structure is the same.
  - Thin keeps every voice (no `merge`), because the acceptance criterion asks for the prototype's active counts.
- Options: `voices` 2..32 (split stages round(k·n/12) for k in 3, 5, 8, 12); `length` (more or fewer drift chords and walk ticks; never below about 100 s, since every section is kept); `density` (walk); `now` (timestamps). `generateWithSections` also returns the section start times.
- **Tests:** the prototype's own `compose()` is cut out of the HTML and run in `node:vm`, instrumented to record the active count after every retarget and at every section end. For 20 seeds in all four modes, those match what the generated moments imply. `compile()` (M1b, e44e9f5) gives no error diagnostics for those 80 pieces, and the compiled lives give the expected active counts at every section boundary.

### Deviations from the task text
- Roman numerals follow the major-scale convention above, not the key's own scale.
- A newer file keeps its `version` as written (see above).
- `scripts/` and the `docs:schema` entry in package.json are outside the listed paths; the task asked for them.
- `generate`'s `opts` defaults to `{ mode: 'dorian' }`, and gains `now`.

---

## M1b: compiler, voice leading, interruption, query API (2026-11-19)

### Contract change (additive): cut segments, `Segment.curve`, flat layout v2
§7.5 step 1 says "truncate S at tᵢ". The M0 `Segment` cannot represent a truncated eased glide: x is normalised over [t0, t1], so moving t1 changes the curve's shape, and no restriction of e.g. smootherstep to a sub-interval lies in the family p0 + Δ·e(x) + m0·H(x). Without a fix, either the part of the glide that already sounded would change shape after the fact, or C⁰ and P1 would break.
- **`Segment.curve?: { t1, p1 }`** (types.ts): present only on a cut segment. It holds the *planned* end time and target, and the curve keeps that parametrisation: x = (t − t0)/(curve.t1 − t0), p = p0 + (curve.p1 − p0)·e(x) + m0·H(x). `t1`/`p1` stay the segment's *real* end and its pitch there, so contiguity (seg[i].t1 === seg[i+1].t0), exact joins (seg[i].p1 === seg[i+1].p0) and every consumer that reads only t0/t1/p0/p1 are unaffected.
- **segment.ts:** `segmentPitch` and `segmentVelocity` take two optional trailing parameters `curveT1 = t1`, `curveP1 = p1`; for uncut segments the arithmetic is bit-identical to M0's. `evalSegment`, `evalSegmentVelocity` and `evalFlatSegment` read the cut fields.
- **New in segment.ts:** `segmentMotion` / `evalSegmentMotion` / `evalFlatSegmentMotion`: motion 0..1 = sin(π·x) over the planned glide, 0 on holds (§7.9 `motionAt`). It lives in the leaf so that the DSP's accent term (§8.4) and the renderer read the same value (P1).
- **flat.ts:** segment records gain `SEG_CURVE_T1` (11) and `SEG_CURVE_P1` (12), always filled (equal to t1/p1 when uncut); **`SEG_STRIDE` is 13** and **`FLAT_LAYOUT_VERSION` is 2**. Existing offsets are unchanged. `unflatten` restores `curve` only when it differs from (t1, p1).
- **M2:** use `evalFlatSegment` / `evalFlatSegmentMotion` and the constants, as before; nothing else changes.

### What exists
- `compile(piece)` and `compileWithTrace(piece)` (trace of every planned moment, for tests) in `src/core/compiler/compile.ts`; event queue (`queue.ts`), voice state and frontier (`voice.ts`), planner with crossing enforcement (`plan.ts`), look-ahead projections (`project.ts`), glide merge and timing draws (`glide.ts`), range folding (`range.ts`), the diagnostic code list (`diagnostics.ts`).
- `core/voice-leading.ts` (ordered injective/surjective DPs, Hungarian), `core/interrupt.ts` (§7.5), `core/voicing.ts` (§7.3), `core/moments/*` (one file per moment type), `core/query.ts` (§7.9: `pitchAt`, `motionAt`, `sample`, plus `segmentAt`, `lifeAt`, `activeAt`, `keyAt`).
- Examples (CC0, `meta.license: 'CC0-1.0'`): five pieces made with `generate()` and hand-edited; together they use all ten moment types.

### Decisions and deviations
- **Event order refinement (§7.1).** At equal times move starts are ordered: life closes, then births, then moves, each by pool index. Births read their parent's *left-limit* state, so they must precede moves at the same instant.
- **A newborn inherits its parent's velocity** (not just its pitch), so the fork is tangent; its first segment uses the interruption rule. A parent is the *sounding* targeted voice nearest the target; with none, the newborn appears on its target.
- **Pending newborns targeted again:** the birth still happens (never cancelled); a later move that would start before the birth starts at the birth.
- **A merge's dying voice** is untargetable from the merge's time; its pool slot is free again once its fade ends (`diedAt ≤ t`). With no survivors, dying voices fade where they are.
- **Walk steps** start at the tick, all with duration `stepGlide` and the merged ease; the glide's stagger, jitter and length are not used for steps (equal timing makes stepping voices provably non-crossing). The bass margin (stay > 2 semitones below the next voice) is the prototype's. A walk's moment event cancels nothing; walks wait for any move in progress, including fixed-length moves that keep the pitch.
- **`level` moments do not cancel pending pitch moves** (no pitch effect).
- **Stagger is stratified:** rank r of n starts at stagger·(r + u)/n (u: Purpose.Stagger). A single voice starts on time.
- **Unison `center`** = (lowest + highest)/2 snapped to the key; **`tonic`** = the tonic nearest that. **`current`** uses the committed destinations' pitch classes.
- **Spread with a negative factor** mirrors, so it is treated like `free` (exempt from the crossing guarantee).
- **Split register:** `split` has no `register` field (§6.2), so it voices over the union of the ranges, and `even` spans the whole register (spec as written; generate() uses explicit pitches).
- **Crossing enforcement** (§7.2) uses union-find timing groups; a newborn's start stays linked to its parent's until merged. A voice still gliding from an earlier moment that is overtaken gets re-timed with the group (a move to its own destination). A pair that crosses *before* its group starts moving (in glides left over from an earlier moment, often an exempt `free` or mirroring move) gets the group's start pulled back to the last sample where the pair is still in order (never before the moment; starts only move earlier, so the loop terminates); the re-check then clears it or tightens m₀, and at scale 0 equal timing and ease keep in-order lines apart (M1b fix, 2026-11-20). Where equal timing cannot help, `crossScale` scales both voices' m₀ (closed form: curves are affine in the scale; scales only decrease). Left-over crossings get `crossing-unresolved` (info). **A bézier with y outside [0, 1] overshoots by itself, which breaks §7.2's algebra; such crossings cannot be fixed and are reported.**
- **Overshoot limit L:** min(1, gap to the neighbour), with the gap = min(|Δ start|, |Δ target|) to each adjacent targeted voice, separately up and down, and further limited by the room left in the voice's range. Doubled targets mean L = 0 (clamps are then common).
- **Overshoot clamp:** the scale on m₀ is computed directly from the 64 per-point bounds (the curve is linear in the scale at each point), then **refined between the samples** by golden-section search in the two end intervals and around sampled interior minima, so the clamp holds for the continuous curve, not only at the 64 points; bisection is only the fallback. Reason: next to x = 0 and x = 1, H → 0 and the per-point bound has a lower limit than its value at x = 1/63, so the 64-point clamp let curves dip out by a first-order amount (a newborn born below its range dipped 0.002 semitones further out). For named eases a rigorous monotonicity bound skips searches that cannot lower the result. (Deviations from the wording "by bisection" and "sample the curve at 64 points": the result is never looser than the 64-point clamp.)
- **Ranges:** a bézier's own overshoot may leave the range (it is the user's ornament); carried velocity never does. A newborn may start outside its range (on its parent's pitch).
- **Unknown moment types** (newer files) are skipped with an `info` `unknown-moment-type` diagnostic.
- **End:** `end.at`, else the last activity (moment times, glide ends, deaths, level ramps, walk `until`) + 4 s. Every open life closes at the end with `fadeOut` = the end fade (merged with a running death fade). Moments at or after an explicit end get `after-end`.
- **`sample()`** marks gaps between lives with a `[t, NaN]` point.

### Not met / open
- **Performance (§7.10): not met.** Benchmark: a 5-minute, 24-voice, 200-moment stress piece (moments every 1.45 s, 3.5 s glides, stagger 1.2, every voice gliding most of the time) measured a median of **about 9 ms** in Node on this dev machine under load average 4 to 10 (the machine was shared); **about 4.5 ms with crossing enforcement switched off**. The crossing check is near its sampling minimum (about 1.2 resamples of 64 points per participant). Ideas not tried: analytic bounds without building projections, allocation pooling, worker offload (§7.10's fallback). `tests/unit/core/compiler-perf.test.ts` asserts ≤ 25 ms by default and 5 ms with `ALGORHYTHMS_PERF_STRICT=1`. **Update 2026-11-20:** the dev machine now measures about 24 to 29 ms median for the M1b commit itself (ca19a86) and for HEAD, so absolute numbers vary about 3× with machine state; the fixes above cost under 5 % relative to HEAD under the same conditions (16 to 18 ms median when the benchmark runs alone at load average 8). The ≤ 25 ms default can fail when the benchmark runs alongside other test files on a loaded machine.
- **Fixed 2026-11-20: a hang and the two property failures.** The pieces are kept as permanent regression tests in `tests/property/core/regressions/` (formerly `known-failures/`); `compiler.property.test.ts` runs every check on each file. The property tests run with a fixed seed (2611; `PROP_SEED=random` explores, `PROP_RUNS` sets the count, `DUMP_DIR` writes the failing piece as JSON), and every compile in the suite must finish within 50 ms (an over-budget compile is re-measured twice first, so machine load does not fail it).
  1. *Slow compiles were a hang* (`slow-nearest-slash-free.json`: a split, an ordered C/E chord in register [46, 52] with `nearest` voicing, then a `free` chord). With no chord tone above the slash bass inside the register, `nearest` voiced the upper voices from an empty list, so two targets were NaN. A later `free` chord gave the Hungarian search a NaN cost: `cur < minv[j]` never holds, `delta` stays ∞, and `do … while (rowOf[j0] !== 0)` never ends. The earlier 18 to 42 s runs of the ranges property were not reproduced; 3 s of that test's time was its own per-sample `expect` calls (now made only on a violation). Fixes: `voicing.ts` doubles inside the register (as `close` does) and never picks from an empty list; `hungarian` takes the first unused column when only non-finite costs are left, so it always terminates; the planner replaces a non-finite target by the voice's destination with a new `warn` diagnostic, `invalid-target`. After the fix: 27,000 generated pieces compiled with a median of 0.07 ms and a maximum of 6.5 ms (cold JIT).
  2. *Crossings* (`crossing-seed2611.json`, m00006 v1/v2). `Projection.bounds` skipped segments ending before the window, but a voice resting on a glide that already ended holds its end pitch with no hold record yet, so its bounds were empty ([∞, −∞]) and the exact pruning in the crossing check declared the pair "cannot cross": enforcement and the report were both skipped. Fixed by including that hold. This exposed crossings in glides left over from earlier moments, before the pair's own moves start (pull-back rule above).
  3. *Ranges* (`ranges-seed2611.json`, v4). A newborn born below its range (on its parent's pitch) with downward carried velocity has no room below, and the 64-point clamp let it dip 0.002 semitones further out between x = 0 and x = 1/63. Fixed by the continuous clamp above.
  4. *Still open (reported, within the test's 0.2 % rate):* across 4 seeds × 300 pieces, two non-bézier crossings remain unresolved and are reported as `crossing-unresolved`. Both involve newborns of a split whose birth times and birth pitches are coupled to their parents' motion (one each on two of the seeds 2611, 1, 42, 90210; e.g. split m00004 `count 12` at 24.6, newborns v5/v6 born 4 ms apart from one parent, both clamped, v5's 0.25 s glide passing v6's 0.77 s glide). Not investigated further.
- Musical questions to judge by ear: §17.2 item 1 (timing merges make staggered fan-outs more uniform where voices are close; with `order: 'random'` adjacent voices often merge); `split`'s `even` voicing spans the whole union of ranges; L = 0 for doubled targets clamps carried velocity often (C⁰ joins).

---

## M0: scaffold, shared contracts, worklet pipeline (2026-11-19)

### Toolchain
- Node 22.23.5 (Homebrew `node@22`, keg-only but linked into `/opt/homebrew/bin`), pnpm 12.18.0 (Homebrew), gh 2.103.3 (not logged in).
- **TypeScript 6.0.3, not the current 7.x.** typescript-eslint 8.73 (the newest) supports only `typescript < 6.1`. Revisit when typescript-eslint supports 7.
- Vite 8.3 (Rolldown), @vitejs/plugin-react 6, React 18.3, Zustand 5, Zod 4 (`z.looseObject` for the passthrough rule of §5), fflate 0.8, Vitest 5, fast-check 4, Playwright 1.65, ESLint 10 (flat config), typescript-eslint 8, eslint-plugin-react-hooks 7, Prettier 3. All MIT or Apache-2.0.
- No `@types/audioworklet`: worklet globals are declared in `src/audio/worklet/audioworklet-globals.d.ts` instead (about 60 lines), to avoid a dependency and its DOM-lib conflicts.

### Deviation: the DSP imports `core/ease` and `core/segment` by value (option b)
§14 says `dsp` imports only *types* from `core`. Pitch evaluation must be the same code on the main thread (compiler, renderer, MIDI) and the audio thread (P1), so:
- `dsp` may value-import exactly two pure leaf modules, **`core/ease.ts`** and **`core/segment.ts`**. Everything else in `core` is type-only (`import type …`, declaration form; inline `import { type X }` is rejected because it leaves a runtime import under `verbatimModuleSyntax`).
- Both are **leaves**: `ease.ts` imports only types; `segment.ts` imports only types and `ease.ts`. The lint rule enforces this, so the DSP can never pull in the compiler transitively.
- **The flat record layouts (strides and offsets) live in `core/segment.ts`**, not `core/flat.ts`, because the DSP must read lives, levels, timbre changes and voice params as well as segments, and it may import only the two leaves. `core/flat.ts` re-exports every constant, so main-thread code imports them from `flat.ts` as the task specified.
- The portable helpers `sinPi`, `cosPi` and `exp2` live in `ease.ts`, because ease.ts must stay a leaf and the cosine and expo eases need them. **M1: `core/math.ts` should re-export them rather than duplicate them.**

### Decision: import boundaries are a local ESLint rule
`no-restricted-imports` matches specifier strings, and a relative path like `../dsp/x` lands in different layers depending on how deep the importing file is. `eslint.boundaries.js` resolves each specifier against the importing file and judges the layer it actually lands in (static imports, `export … from`, and dynamic `import()`). It also forbids `src/` files outside `app/` from importing anything outside `src/`. Messages cite PLAN.md §14. `tests/unit/lint-rules.test.ts` proves every rule fires, using the ESLint API with in-memory code.

### Additions to the §7.11 lint ban
- In `core/`, besides `Math.sin`, `cos`, `tan`, `pow`, `exp`, `log`, `log2`, `log10` and `random`, the ban also covers `asin`, `acos`, `atan`, `atan2`, the hyperbolic functions, `expm1`, `log1p`, `cbrt` and `hypot`. None of these is required to be correctly rounded, so they carry the same cross-engine risk. `**` is allowed only with a non-negative integer literal exponent, and `**=` is banned.
- `Date` and `performance` (wall-clock time) are banned in both `core/` and `dsp/`; `Math.random` is banned in both.

### Decision: P3 ("no DOM in core or dsp") is enforced by the typecheck
`tsc -b` checks four projects:
- `tsconfig.pure.json` (core, dsp): `lib: ES2023` with no DOM, so `window`, `AudioContext` and friends are type errors;
- `tsconfig.worklet.json` (`src/**/*.worklet.ts`): no DOM, plus the AudioWorkletGlobalScope declarations;
- `tsconfig.app.json` (everything else in `src`): DOM;
- `tsconfig.node.json` (config files and tests): Node, plus DOM for Playwright's `page.evaluate` callbacks.

`noUncheckedIndexedAccess` is off on purpose. With it, every typed-array read in the DSP would need a `!`.

### Decision: how the worklet is loaded (§14's "fiddly" part)
- `import url from './worklet/x.worklet.ts?worker&url'`. Vite treats the file as a worker entry and returns its URL without constructing a Worker.
  - In **dev** the URL is `/src/audio/worklet/test-tone.worklet.ts?worker_file&type=module`; its imports of `dsp/` and `core/` are fetched as separate ES modules, which module worklets allow.
  - In **production** the worklet and its imports are bundled into one ES module, `assets/test-tone.worklet-<hash>.js`, under the base path.
- `worker.format: 'es'` (the AudioWorklet module is a module script; M2's export worker should be created with `{ type: 'module' }`).
- A plain `new URL('./x.ts', import.meta.url)` would copy the uncompiled .ts file into the build, so it is not used.
- Convention for M2: name worklet-scope entry files `*.worklet.ts`. They get the worklet tsconfig and globals automatically.
- **Vite `base`:** `/algorhythms/` for `vite build` *and* `vite preview` (preview serves the build, so it needs the same base), and `/` for `vite dev`. The env var `ALGORHYTHMS_BASE` overrides it; CI sets it to `/<repository name>/`, so forks work.

### Contract decisions in `src/core/types.ts`
- **Parsed form.** The types describe a piece *after* the M1 Zod schema has filled defaults. Fields marked `@default` may be omitted in files. Optional (`?`) fields may be absent even after parsing. This mirrors the §6.2 table: `voicing` and `assign` are required with defaults ('even', 'ordered'); `register`, `split.notes` and `walk.bass` stay optional.
- **Moments:** a discriminated union `Moment` over the ten v1 types, plus `MomentOf<'walk'>`. The `timbre` moment (M6) is not in the union yet.
- **Keys:** `PitchClass` is the 17 common spellings ('C', 'C#', 'Db', …). `ScaleRef` is a built-in `ScaleName` (major, minor, the modes, harmonic and melodic minor, both pentatonics, blues, whole-tone, chromatic) or `{ kind: 'custom', intervals }`. M1 implements the tables.
- **`VoiceDef.sends?`** (per-voice reverb/delay send overrides) is new. `MixSettings.sends` holds the defaults.
- **`MixSettings`** (designed from §8.6): `reverb {size, decay, damping, preDelay, returnLevel}`, `delay {time, feedback, returnLevel}`, `sends {reverb, delay}`, `tone {tilt, lowpassHz}`, `limiter {ceilingDb}`, `panAuto: 'index' | 'pitch'`. Levels are linear.
- **`ViewSettings`:** `window`, `colors` ('ink' | 'voice' | 'pitch' | 'custom'), `hud`, `gridBpm?`, `futureOpacity?` (default 0), `playheadX?` (default 0.78). Theme is a user preference, not piece data.
- **`CompiledScore` extensions:**
  - `keys` (the key timeline; first entry at t = 0);
  - `referenceHz` and `seed`, so the DSP needs only the compiled score.
- **`CompiledVoice` extensions:**
  - `index` (pool index);
  - static `gain`, `pan`, `mute`, `solo` and `sends`, for the same reason.
  - `voices` holds **every pool voice in pool order**, including voices that never sound (with empty `lives`).
- **`Life` semantics** (§7.9 left them open):
  - `born` is the *audible* onset (the start of the fade-in, and the t0 of the life's first segment);
  - `died` is the *end* of the fade-out, so the fade-out runs over [died − fadeOut, died];
  - an absent `died` means the voice is alive at the end;
  - the "active from the birth moment's time" state of §7.1 is internal to the compiler;
  - the fade *shape* is M2's choice, and MIDI CC11 must follow it.
- **Level timeline:** the level is 1 before the first entry, and each entry ramps linearly in amplitude from the level in effect at `t`. **Timbre timeline:** the first entry is `{ t: 0, preset: VoiceDef.timbre, fade: 0 }`.
- **`Diagnostic.code`** (a required, stable kebab-case string) is new, so tests and the UI can match diagnostics without parsing messages.
- Constants: `PIECE_FORMAT = 'algorhythms'`, `PIECE_VERSION = 1`, `MAX_VOICES = 32`.

### Decisions in `core/ease.ts` and `core/segment.ts`
- **`expo`:** ease-in-out exponential, *normalised* so that it passes exactly through 0, 1/2 and 1: e(x) = (2^(20x−10) − 2^−10) / (2(1 − 2^−10)) for x ≤ 1/2, mirrored above. The common definition jumps by 2^−11 at each end, which would break C⁰ continuity. Its e′(0) = 10·ln2/1023 ≈ 0.00678, so it is not 0.
- **`cosine`:** uses a degree-17 odd Taylor polynomial for sin(πu), normalised so that it is exact at ±1/2; the error is below 1e-14.
- **Clamping:** the standard eases are clamped to [0, 1], because rounding gave 1.0000000000000002 near x = 1. They are monotone up to rounding (1 ulp).
- **`bezier`:** CSS cubic-bezier, solved by Newton's method (to |Δx| < 1e-14) and then bisection to full precision. `easeSlope0` follows the CSS extrapolation rule (the tangent through P1 if x1 > 0, else through P2 if x2 > 0, else 0). A vertical tangent returns ±Infinity from `easeDeriv`. Curves with vertical tangents are ill-conditioned for any double-precision solver (about 3e-6 near the tangent), which is still within the 1e-4 requirement.
- Each function has two forms: allocation-free scalar `…Raw(code, x, x1, y1, x2, y2)` functions for the audio thread, and object-taking wrappers (`ease(code, x, bezier)`, `easeDeriv`, `easeSlope0`).
- **`easeDeriv` (e′ everywhere) and `evalSegmentVelocity` are new.** The compiler needs the velocity at any interruption time, not just e′(0) (§7.5).
- `evalSegment` returns p0 before t0 and p1 from t1 on, *by branch*, so the endpoints are exact. A zero-length segment is a step at t0. H(x) is computed as x(1 − x)².

### Decisions in `core/flat.ts`
- **Segment records:** stride 11 (t0, t1, p0, p1, easeCode, x1, y1, x2, y2, m0, clamped).
  - Non-bézier eases store (0, 0, 1, 1).
  - Life stride 4, with `died = +Infinity` when open. Level stride 3. Timbre stride 3 (the preset is an index into `timbreNames`).
  - Voice params stride 7: gain, pan (NaN = auto), mute, solo, reverb send (NaN = default), delay send (NaN = default), and the id hash.
- **Version:** `FLAT_LAYOUT_VERSION = 1`. Bump it on any change.
- **Voice-id hash:** the per-voice hash for seeding detune and phase is **FNV-1a 32-bit** (integer operations only). If M1 prefers `rng.hash32`, switch `hashVoiceId` to it; the layout doesn't change, but the seeded detune of existing pieces would.
- **Not carried:** moment spans, diagnostics, keys and `Segment.momentId`. `unflatten` returns them empty and canonicalises optional fields.
- `transferList(flat)` lists each ArrayBuffer once. The arrays are typed `Float64Array<ArrayBuffer>`, so `.buffer` is transferable.

### M0 placeholders (to be replaced later)
- `src/dsp/test-tone.ts`: a 4096-point sine table with linear interpolation and smootherstep fades. `src/audio/worklet/test-tone.worklet.ts` and `src/audio/test-tone.ts` load it. M2 may delete or absorb them.
- `src/app/debug.ts` sets `window.__algorhythms = { workletUrl, processorName, context?, analyser? }` for the e2e tests. M3 should replace this with whatever the player tests need.

### Tooling decisions
- `pnpm lint` runs `eslint .` and then `prettier --check .`. Prettier ignores Markdown (PLAN.md and CLAUDE.md belong to the integrator, and prose is written by hand) and `prototype/`.
- **e2e:** each engine runs as a `<engine>-dev` project against `vite` on port 5180, and as a `<engine>-prod` project against `vite build && vite preview` on port 4180, at `/algorhythms/`. CI selects them with `--project='webkit-*'` and similar patterns.
- **CI** starts a PulseAudio null sink on Ubuntu so that live AudioContexts have an output device. Whether live audio runs on GitHub's macOS runners is **unverified** until the first CI run; the offline-render test doesn't depend on a device.

### Open items
- The README attribution links to a YouTube *search* for the video's title, because the direct URL couldn't be found from here. The owner should replace it (there is a TODO comment in README.md).
- M0's acceptance ("CI is green, the site is live") needs a GitHub remote, Pages source set to "GitHub Actions", and a first push.

### Local results (macOS 26.4, Apple Silicon, headless)

| Engine | `vite dev` | production build (`vite preview`) |
|---|---|---|
| Chromium 159 | pass (4/4) | pass (4/4) |
| Firefox 159 | pass (4/4) | pass (4/4) |
| WebKit 27.2 | pass (4/4) | pass (4/4) |

The four tests are:
1. the page title;
2. the worklet URL comes from the expected pipeline;
3. an OfflineAudioContext render is 440 ± 1 Hz at the requested amplitude;
4. the Play button gives a live 440 ± 2 Hz sine (RMS > 0.1) through an AnalyserNode in a running AudioContext.

## M3a: renderer (recorded by the integrator from the builder's report)

- **Markers:** `CompiledScore` carries no labels, so marker text comes from `ScoreStyle.labels`, which the app builds from `Piece.moments[].label`. Positions come from `momentSpans`.
- **Overview easing is app-driven:** `CameraState.overview` (0–1) plus the `easeOverview` tween, as in the prototype. The camera only blends into the overview by itself as the window approaches the whole piece.
- **Vertical fit** covers the whole piece's pitch range, padded by 1.5 semitones and at least 12 semitones tall. It is not per window, so the view doesn't jitter.
- **The playhead** stays faintly visible in the overview (alpha ≥ 0.4).
- **The e2e** injects a bundled `src/render/dev/entry.ts` into a blank page. There is no extra Vite entry.

## Owner decisions, 2026-11-20

- **M1 listening test passed:** the owner says the generated pieces "sound lovely".
- **§17.2 item 1 (mid-glide crossings):** add the option *only as a temporary developer toggle*: a compile option plus a temporary panel in the app. It is **not** a schema or Piece field. The owner expects not to need it, so it can be removed later.

## Owner decision, 2026-11-20: unison wobble

- **What the owner heard:** on the fixture page, `unison-8` "clumps a lot, in a very interesting wobble sound", and `merge` wobbles too. `dense-24` is good. There are no pops; the wobble comes from interference.
- **The cause:** §8.4's mandatory per-voice detune (1.5–4 cents) makes converged voices beat against each other.
- **Decision:**
  - Fix it by default: converged voices must sound steady (no beating, never cancelling).
  - Keep the effect as an opt-in sound: a timbre-level setting and a new "wobble" preset.
- §8.4 and P2 in PLAN.md will be updated once the fix's design lands.

## M3b: MIDI export (recorded by the integrator from the builder's report)

- **Accuracy:** the worst round-trip pitch error is 1.04 cents (a 36-semitone glide in 0.05 s at ±48). Note timing is within 1 tick. A test-only SMF parser reconstructs the pitch paths, which is the automatic verification promised in §16 until the owner has a DAW.
- **CC11:** `127 · gain / peak`, with `peak = max(1, the largest level gain in the score)`, so level boosts above 1 don't clip. Static `VoiceDef.gain` is not included.
- **Exact boundaries:** a tick on a segment boundary writes the exact boundary pitch.
- **Bend density:** bends are sampled on a 1/250 s grid and refined adaptively until linear interpolation stays within 0.5 cent. The 200 events/s floor can't be met below about 12 BPM, because PPQ is fixed at 960.
- **Re-strikes:** a re-strike falls on the last tick the old note can reach, on `round(pitch)`.
- **The MPE configuration message** is in the conductor track at tick 0.
- **Reference tuning:** `referenceHz ≠ 440` is applied through the bends (option `applyReferenceTuning`, default true).
- **Notes-only:** a glide into a birth is dropped, and consecutive holds at one pitch merge into one note.
- **Channel 10:** per-voice mode skips channel 10 (the GM drum channel). This is an integrator decision; the spec said wrap after 16.
- **Compiler quirk noticed by the MIDI builder:** a life's `died` can be later than its last segment's `t1` (the end fade). Consumers hold the last pitch until `died`. Consider making the compiler extend the final hold to `died`.
