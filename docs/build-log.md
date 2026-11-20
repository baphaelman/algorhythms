# Build log: deviations and decisions

Newest milestone first. Each entry says what departs from (or fills a gap in) PLAN.md, and why. PLAN.md itself is owned by the integrator and is not edited by builders.

---

## M2 follow-up: a less robotic choir (2026-11-20)

The owner found `choir` "a little goofy, robotic". Causes, all confirmed in the code: (1) the "ah" was baked into per-partial weights, so the formants moved with the pitch (a chipmunk vowel); (2) every voice had the same perfectly periodic vibrato (5.5 Hz, 14 cents; only the phase was seeded); (3) nothing drifted.

### Contract additions (additive; `Timbre` in types.ts and `TimbreSchema`)
- `formants?: { hz, bw, gain }[]` (max 8): fixed-Hz resonances. Envelope = Σ gain / √(1 + ((f − hz)/(bw/2))²), multiplied into partial n at n · f0 for each mip's bottom fundamental. Loudness is normalised at C4 with the envelope applied there.
- `drift?: { cents, rate, amp? }`: slow seeded wander of pitch (about ±cents) and level (about ±amp), per voice.
- `vibrato.jitter?` (0..1): per-voice vibrato rate (±12 %) and depth (±25 %) spread, plus slow wobble (±8 % rate, ±30 % depth), all scaled by jitter.
- docs/file-format.md regenerated (`pnpm docs:schema`).

### DSP
- **Finer mips for formant timbres only.** Between two octave mips the oscillator would play both tables' formants shifted by up to an octave, so a formant timbre gets `FORMANT_MIPS_PER_OCTAVE` = 4 mips per octave (41 tables, 336 KB at 2049 floats per table). Halfway between two mips each formant is smeared by ±9 %, inside its bandwidth. `WavetableSet.mipsPerOctave` records the spacing; other timbres keep one mip per octave and bit-identical tables. The voice computes the mip index and crossfade weight per table role, because a timbre crossfade can mix spacings.
- **Drift noise:** 64 knots in [−1, 1] per voice, drawn by `Prng` from hash2(voice hash, seed ^ salt) in `setIdentity`. Five streams read the knot ring at incommensurate rates through Catmull-Rom interpolation (C¹, no plateaus). The noise phase advances at the drift rate (0.3 Hz if only jitter is set) and is re-derived from the piece time on fresh starts and seeks. `noiseTick(frame, fresh)` takes only an integer and a boolean (V8 rule 3); `process()` stays allocation-free (no-GC test: 0 GC lines).
- **Presets:** `choir` now has 32 equal partials at −4 dB/oct, an "ah" at 700/1200/2600/3300 Hz (bandwidths 130/150/220/300), `detuneSpread` 7 (was 4), a softer arrival (amount 0.08, attack 0.18 s, decay 0.8 s), vibrato 5 Hz / 9 cents / 0.45 s delay with jitter 0.8, and drift { 6 cents, 0.35 Hz, amp 0.06 }. `reed` gains a light touch: vibrato jitter 0.4, drift { 2.5 cents, 0.25 Hz, amp 0.03 }. The other presets are unchanged.
- Choir loudness from C2 to C6 stays within about ±3 dB (before the pitch loudness tilt). The loudest partial sits at 640–810 Hz throughout.

### Results
- RTF (24 voices + FX, CPU time): 21–23× after, 18–24× at HEAD, measured alternately in a worktree under load average 10–12. No measurable change.
- New tests in tests/dsp/humanise.test.ts: formant peaks and centroid fixed in Hz an octave apart (the old per-partial weights doubled); no aliasing at the finer spacing; a 24 → 108 → 36 choir sweep's click score is 1.34, against 1.90 for the same sweep on octave mips; drift knots and renders are identical per seed and differ across seeds and voices; drift moves the pitch a few cents and nothing moves without it.
- tests/dsp/unison.test.ts: the N = 16 and 32 cases got a 60 s timeout. They took 7–9 s under load at HEAD as well (the default is 5 s).
- A/B renders: `renders/choir-{before,after}.wav` and `renders/reed-{before,after}.wav` (24-bit, 48 kHz; the same 23 s phrase of slow chords with wide glides, default mix).

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

## M3c: player app (recorded by the player builder)

### What exists (`src/app/`)
- `store.ts`: the Zustand store `{ piece, compiled, view, transport, notices }` and every action. **Hooks for the next builder:** `loadPiece(piece, opts?)` (fresh open: compiles, stops at 0, shows the overview, resets `view` from `piece.view`, loads the engine at idle or at the first Play), `setPiece(piece)` (an edit: `compiled` follows within one animation frame, several edits in a frame cost one compile, then `engine.swap`; a changed `piece.mix` goes through `engine.setMix`), `recompileNow()`, `openPieceJson(json, label)`, `openFile(file)`, `pushNotice(kind, title, lines)`, `currentTime()`, and the transport and view actions (`play`, `pause`, `togglePlay`, `seekTo`, `scrubTo`/`scrubEnd`, `setWindow`, `zoomBy`, `setColors`, `setHud`, `panBy`, `setTheme`). `usePlayer.getState().compiled` is the current score.
- `audio.ts`: the one `AudioEngine`. `getEngine()` (null before it exists), `whenReady()` (resolves with the engine after the latest load or swap), `primeAudio()`, `loadAudio`, `swapAudio`, `mixAudio`. Loads and swaps run through one serial queue.
- `loop.ts`: the rAF loop (`drawScore`, overview and ghost tweens, direct DOM writes). `canvas-input.ts`: pointer, wheel, gesture and key handling. `dom.ts`: the registry of elements written directly (time, scrubber, key and voice status, meter). `share.ts`: `encodeShareLink` / `decodeShareLink` (M5 adds default stripping to the encoder). `platform.ts`: iOS checks and the audio session. `examples.ts`: `import.meta.glob` of `examples/*.algorhythms.json`.
- `ui/`: React panels only (`Transport`, `Scrubber`, `ViewBar`, `Menu`, `Notices`, `ScoreView`). `debug.ts` installs `window.__algorhythms` (`store`, `engine()`, `analyser()`, `frameStats`, `actions`, `encodeShareLink`) for the e2e tests.
- Layout: `.app[data-layout=full|player]` (switch at 900 px). In `full`, empty hidden slots `[data-slot=lane]` (under the score) and `[data-slot=inspector]` (right column, `--inspector-w`) are ready for M4: remove `hidden`, set `--inspector-w`.

### Decisions and deviations
- **Removed M0's test tone** (`src/dsp/test-tone.ts`, `src/audio/test-tone.ts`, the test-tone worklet and protocol, `tests/dsp/test-tone.test.ts`, `tests/e2e/worklet.spec.ts`). The page-title test moved into `tests/e2e/app.spec.ts`; `tests/e2e/audio.spec.ts` already covers the worklet pipeline.
- **No Google Fonts.** The prototype loaded IBM Plex from Google; the player uses the system sans and monospace stacks (no third-party requests; a bundled font would be a new dependency, so it is the owner's call).
- **Canvas HUD stays** (`piece.view.hud`, toggle in the view bar), as in the prototype, so the time appears both in the HUD and in the transport readout.
- **Engine start-up.** The AudioContext and engine are created, and wavetables built, at idle (or on the first pointerdown, or when Play is pressed, whichever comes first). Play is never disabled: it waits for the latest load. `AudioContext.resume()` is called synchronously in the click.
- **Scrubber:** `input` events pause silently and follow the handle; `change` seeks and resumes if it was playing (a keyboard step does a quick pause and resume). Seeking by keys: ←/→ 5 s (Shift 15 s).
- **Pan:** `view.pan` (seconds) feeds `CameraState.pan`; it is reset by play, seek and scrub, and has no effect in the overview.
- **Window slider** is a controlled React input (it re-renders the small view bar per input event; nothing on the canvas or pointer path re-renders).
- **Examples are bundled eagerly** (`import.meta.glob`, ~50 kB of JSON in the main chunk, 110 kB gzip in total). Revisit if more examples are added.
- **Share links** are not stripped yet; decoding refuses output over 8 MB.
- **playwright.config.ts (shared file) change, additive:** `E2E_DEV_PORT`, `E2E_PROD_PORT` and `E2E_OUT_DIR` override the ports and the build folder (defaults unchanged), and the prod build uses `--emptyOutDir`. Two agents running e2e side by side collided on port 4180, on `dist/` and on `test-results/`; use `--output=<dir>` as well.

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

## M3c: stems export (2026-11-20)

### What exists
- **`src/audio/stems.ts`** (pure, no DOM or Worker): `planStems`, `estimateStemsSize`, `writeStemsZip(input, options, sink, hooks)`, `soundingVoices`, `STEMS_WARN_BYTES`.
- **`src/audio/stems.worker.ts`** + **`src/audio/stems-client.ts`**: `exportStems(score, mix, opts) → Promise<{ blob | null, bytes, entries, zip64 }>`, `canSaveToDisk()`, `pickStemsFile(name)`.
- **`src/audio/zip.ts`**: the in-house streaming store-mode ZIP writer with ZIP64 (below), plus `crc32`, `zipSize`, `zipNeedsZip64`.
- **`src/audio/fixtures/stems-hook.ts`**: `window.__fixtures.stems` for the e2e (additive: 4 lines in `fixtures/page.ts`).
- **Tests:** `tests/unit/audio/{zip,stems}.test.ts`, `tests/e2e/stems.spec.ts`.

### How it works
- Passes, as §12: pass 1 renders the mix, writing `mix.wav` as it goes and capturing g_L; then one `RenderMode.Voice` pass per sounding voice and one `RenderMode.Fx` pass, each with the g_L replay. Each pass builds a fresh graph (wavetables are cached by `tablesFor`), renders ~1 s chunks, encodes, and writes them to the zip. Memory holds one chunk, g_L (4 bytes per frame) and the zip's central directory.
- **Order:** `mix.wav`, voices in pool order (`<name or id>.wav`, sanitised and de-duplicated), `fx-returns.wav`.
- **"Sounding" voice:** has at least one life, is not muted, and is soloed when any voice is. A muted voice is silent in the mix, so it gets no stem.
- **Backpressure:** the worker stops when more than 8 MB of zip bytes are unacknowledged; the client acknowledges a chunk after `writer.write` resolves (disk) or after storing it (Blob). A slow disk therefore slows the render instead of filling memory.
- **Cancel:** the client terminates the worker and aborts the writable (a file from `showSaveFilePicker` is then discarded by the browser). `writeStemsZip` itself checks its `AbortSignal` after every chunk.
- **Dither:** 16-bit stems use a different dither stream per file, so the dither doesn't add coherently when the stems are summed. `mix.wav` uses the same seed as the plain WAV export, so it is byte-identical to `exportWav` (tested).
- **Mono option:** stems and FX are written as (L + R) / 2; Σ mono stems = the mono downmix of the mix. `mix.wav` stays stereo.

### ZIP64 finding
- **fflate 0.8.3 does not write ZIP64.** Measured with `Zip` + `ZipPassThrough` on a 4.13 GiB entry: the central directory's size fields held `size mod 2^32` (134 217 728) and there were no ZIP64 extra fields or end records. It reads ZIP64 but cannot write it, so the archive is corrupt past 4 GiB.
- **Decision (the plan's fallback):** an in-house store-mode ZIP64 writer (`zip.ts`, ~300 lines with comments, including CRC-32), so fflate is not used for writing. It writes an entry's ZIP64 extra field and 8-byte descriptor when that entry is ≥ 4 GiB, ZIP64 offsets in the central directory past 4 GiB, and the ZIP64 end record and locator past 4 GiB or 65 535 entries. Archives under 4 GiB are plain ZIPs.
- **Verification:**
  - Real: a 5.3 GiB archive (a 1 GiB entry, a 4.2 GiB entry, a 100 MiB entry whose offset is past 4 GiB) written to disk in 7.5 s; its size matched `zipSize` exactly, Python's `zipfile.testzip()` returned `None` (every CRC checked) and Info-ZIP `unzip -t` reported no errors.
  - In CI: the writer takes a lowered `zip64Threshold`, so every ZIP64 path runs on kilobytes. tests/unit/audio/zip.test.ts reads those archives with fflate's unzip and with Python's zipfile (skipped if python3 is missing), and also covers > 65 535 entries. tests/unit/audio/stems.test.ts runs a real export with the lowered threshold.
- A single WAV is still limited to 4 GiB by its RIFF header (`wavHeader` throws), so a stem entry never reaches ZIP64 size in practice; the archive does (32 float stereo stems over 10 minutes).

### Results (macOS 26.4, Apple Silicon)
| Check | Result |
|---|---|
| Exact sum, float stems + FX = mix, limiter pulling the gain below 0.8, 8 voices (one muted), tone tilt + low-pass on | residual **−144.0 dBFS** in Node; **−147.4 dBFS** decoded from the Chromium worker's zip |
| 24-bit | Σ stems differs from the mix by at most (files + 1) / 2 LSB, as rounding allows |
| 5 min, 24 voices, 24-bit stereo, 48 kHz, 26 files, 2.28 GB zip, streamed to an OPFS file handle in Chromium | 73–95 s; peak resident memory of all browser processes **+53 to +78 MB** over idle (idle 173–329 MB; two runs) |

### Memory measurement
- `performance.measureUserAgentSpecificMemory` throws `SecurityError` in this headless Chromium even when the page is cross-origin isolated, so it is recorded only if it works.
- The evidence is the resident set size of the browser's whole process tree, sampled with `ps` every 250 ms. The stems worker runs in the page's renderer process, so this includes its ArrayBuffers and the browser-side file writes. The test uses a persistent profile, because an incognito context's OPFS quota is too small for a 2 GB file.
- Cross-check in Node (same export, 108 s, a sink that only counts bytes): peak RSS 187 MB, +131 MB over the idle process (the Node process also holds the compiled score and test code, and V8 reclaims lazily). Both numbers are far below the 500 MB budget; the dominant held memory is g_L (58 MB) plus one ~1 s chunk.
- The memory spec runs in `chromium-prod` only (about 95 s, and a transient 2.3 GB file in the browser profile's OPFS, removed afterwards). Run it alone with `pnpm e2e --project=chromium-prod -g "5 min"`.

### Deviations from PLAN.md
1. **fflate is not used for the zip** (§12 names it): it can't write ZIP64 (above). The plan's own fallback was taken.
2. **Mono stems apply to voices and FX only**; `mix.wav` stays stereo.
3. **The size estimate is exact**, not approximate: every entry's size follows from the frame count, and `zipSize` computes headers and the directory.

## Unison lock + wobble preset (2026-11-20)

Implements the owner's decision above ("unison wobble"): converged voices sound steady by default; the beating is an opt-in timbre setting and a new `wobble` preset.

### Design
- **Group pass, once per block** (`Graph.computeGroups`, src/dsp/graph.ts), on each main voice's end-of-block state (published by `Voice.render` into `VoiceContext.g*`). Pair weight w = smoothstep over the score-pitch distance (full ≤ 2 cents, none ≥ 20 cents) × both voices' lockability (timbre `wobble` = 0). Pairs moving apart faster than 2–12 cents/s leave early.
- **Per voice:** lock amount λ = max w (smoothed 40 ms up, 100 ms down); a pitch correction λ·(m̄ − m) toward the group's mean *modulated* pitch (detune, drift and vibrato included, so they merge into the group's); a phase pull toward the group's mean phase (≤ 0.4 % of f) and a vibrato-phase pull. Targets are weighted by amplitude × settled stillness 1/(1 + |v|/20 cents/s), so the arriving voice converges and a held survivor keeps its pitch.
- **Within a group** level drift and vibrato jitter fade by λ.
- **Group gain** h = √(Σw²A²)/|Σ w·A·e^{iφ}| from the measured phases (≤ +3 dB, 10 ms smoothing): a coherent group sits at the incoherent (chord) level. Applied per voice in `amp`, so voice stems carry it.
- **Parting:** θ accumulates each voice's phase-pull correction and unwinds (≤ 1.2 % of f) while the voice parts from a close neighbour, so voices leave with unrelated phases (without it a symmetric split fanned out from one phase and dipped to 0.40).
- **Fresh voices** (seek, birth, unmute) snap to the group's phase and vibrato phase at zero amplitude, so a seek re-locks with no level change.
- **Stems and mute:** in `RenderMode.Voice` every voice still runs its controls and phase silently (`advance()`, the synth loop's exact phase arithmetic), so the group pass sees identical state in every mode. Muted voices keep running silently: they stay in their group and mute changes only their own level.
- **`Timbre.wobble?: number`** (cents, 0–100; types, schema, `TimbreParams`, `TimbreSlot`): > 0 never locks, and scales the base detune to a mean |detune| of `wobble` (2.75 = the old detune exactly). Scale and lockability interpolate across timbre crossfades. Preset `wobble`: soft glass-like, wobble 3, 1-cent slow drift.
- **Fixtures:** `unisonSplitScore`, `unisonChordScore`, `lockStressScore`; pages `unison-split-8`, `unison-chord`, `wobble-8`, `wobble-phrase`, `preset-wobble`.

### Results (tests/dsp/unison.test.ts unless noted; "before" from the first builder's scratch runs)
| Check | Before | After |
|---|---|---|
| Held unison N = 2…32, 9 s average × one voice | 0.5–1.6 band | 0.950–0.958 (−0.4 dB is pan narrowing) |
| Held unison, 50 ms envelope CV (sine) | 0.41 | ≤ 0.0017 |
| Converge/hold/diverge, 0.25 s windows ÷ incoherent sum (each voice rendered alone), N = 2/8/32 at 45/57/69 | 0.11–1.92 | 0.75–1.11 |
| Merge, 0.25 s windows × one voice, 12 id sets | 0.53–1.41 | 0.80–1.19 |
| Merge survivor bend (voice stem, zero crossings) | ~10 cents | ≤ 6.7 cents |
| Seek into a held unison, N = 2/8/32: level ÷ straight playback; click | — | 1.000; 0.05 (threshold 0.16–0.19) |
| `wobble-8` envelope CV | — | 0.42 (beating kept) |
| Stems Σ − mix: unison phrase with a muted voice in a group; lock workload (stems.test.ts) | — | −143.4 / −146.7 dBFS |
| Unison phrase WAV: identical bytes at chunk sizes 1 s / 0.37 s / 1 block (export.test.ts) | — | yes |

RTF (CPU time, best of 5 × 6 s, interleaved with the pre-change tree, load average 22–35):
| Workload | Before | After |
|---|---|---|
| 24 voices + FX, dense glides (the rtf.test.ts workload) | 44.5× | 40.5× |
| 24 voices converged into one unison (group pass at its O(n²) worst) | 57.0× | 46.8× |
| One voice-stem pass, 24 voices | 430–484× | 56–67× |

**Stems export is about 6× slower** (24 stems: ≈ 0.46 × real time of CPU vs 0.08 ×), because every stem pass now runs every voice's controls. A later optimisation: skip voices that can never join the stem voice's group (transitive pitch proximity over the piece).

### No-GC: root causes and fixes
1. **First-visit deopts in `computeGroups`.** It deoptimised on branches with no type feedback (the snap loop) and on `sep > SEP_START`, speculated as integer because separation speeds had always been 0. Deoptimised code boxes every double: MBs per second until reoptimised. This is a one-time JIT cost per path, so the 'lock' harness now warms up over the whole score plus one full seek cycle (`tests/dsp/node/gc-harness.ts`).
2. **`render`'s inlining budget (pre-existing).** TurboFan's cumulative inlining budget (920 bytecode bytes) could not hold `noiseTick` (331) + `segmentMotion` (~210) + `segmentPitch` (~490). Which one was left out depended on call-frequency feedback at compile time, so it varied between runs and with machine load. When `segmentPitch` was left out, every glide tick boxed its 13 double arguments (~40 MB/min, a scavenge every ~0.3 s; 2 of 6 runs under load). This also explains the old note that `stressScore` scavenges. **Fix:** `noiseTick`'s body is written inline in `render`, with identical arithmetic.
3. **Harness noise.** The TS resolver used `module.register()`, whose hooks run in a second isolate. That isolate's memory-reducer GCs (~8 s after start) printed into `--trace-gc` when a loaded run reached them. It now uses `module.registerHooks` (in-thread).
- Result: 0 GC lines in 12 of 12 'lock' runs and 2 of 2 'plain' runs, six at a time in parallel at load 10–17.
- Left: rare paths (seek, the birth probe) run unoptimised the first time and allocate a few KB; they don't trigger a GC.

### Deviations from PLAN.md (for the integrator to fold into §8.4 / P2)
1. **§8.4 detune is no longer the unison safeguard** (also lines on §8.4 "with detune: converged voices beat", the newborn note in §7, the start-phase note, and §8.7 seek). The lock is: converged voices share pitch and phase, and h holds them at the incoherent level. Detune stays per voice, and is averaged into the group's pitch.
2. **Phases couple across voices** (group pass per block). Determinism (P2) holds: there are no time sources, and the inputs are block-start state. A seek re-locks at the group's phase (level 1.000) rather than restoring the from-0 phases.
3. **Stem passes run every voice silently** (cost above), and **muted voices keep running** silently.
4. **New Timbre field `wobble`** (schema, docs/file-format.md) and a 7th built-in preset, `wobble`.
5. **Outside my directories:** the tests/unit/audio/stems.test.ts fixture gain went from 3 to 4. Crossings no longer sum coherently, so gain 3 no longer drove the mix to the limiter ceiling.

Owner A/B WAVs (24-bit, gitignored `renders/`): `unison8-before`/`unison8-after`, `merge-before`/`merge-after`, `wobble-preset` (`unisonChordScore('wobble')`), `gen-1-dorian` (before) / `gen-1-dorian-after`.

## Unison lock: steady approach and parting (2026-11-20)

Owner: held unisons were steady, but the level wobbled as voices glided in and split apart. Cause: two voices a few Hz apart beat at that rate, and eases spend a long time near their target, so converging (and parting) voices beat slowly for ~0.5 s before the lock (20 → 2 cents) engaged. Only a frequency change removes a beat, so some pitch correction is unavoidable; the design spends it only on glides that end or start in a unison.

### Design
- **Unison warp** (`computeUnisonWarps`, `warpOffset`, src/dsp/voice.ts; computed in `Graph.prepare`). A glide is *arriving* when another voice stays within 20 cents of its end pitch for 0.2 s from its end, *leaving* when another voice was at its start pitch for 0.2 s before its start (uninterrupted glides only). Near that unison pitch A, at score distance r it sounds at A ± y(r): y = r for r ≥ C, 0 for r ≤ 0.4 C, r·smoothstep between. C = the distance that beats at 12 Hz against A, within [20, 100] cents and ≤ the glide's span (½ if both ends warp): 100 cents at A2, 92 at A3, 47 at A4, 24 at A5. So voices meet while the score still has them ≤ 0.4 C apart, part only past 0.4 C, and cross the slow-beat zone 2–3× faster. Written out in `render` (no call; inlining budget). Faded by both voices' lockability, so `wobble` glides as written.
- **Capture** (`Graph.computeGroups`), for pairs where either voice runs a warp: arriving pairs pull phases together from 60 cents (full at 20) by ≤ 0.8 % of f, so they meet in phase; arriving or leaving pairs count for h while they beat slower than 20 Hz (full below 10 Hz). Leaving warped pairs skip the θ unwinding (h covers them); unwarped partings keep it.
- **h**: targets the phases predicted for the block end (h is interpolated across the block), smoothing 10 → 2 ms, so it follows beats up to ~10 Hz.
- **Phase pull** beyond a quarter cycle is full strength, not sin: a voice captured near anti-phase no longer hangs there (a level dip).
- Fixtures/files unchanged; no new state in the score or schema.

### Metric
50 ms RMS of the mix ÷ the incoherent sum (each voice rendered with the others at gain 0, so g_n matches and nothing locks), over the approach (glide start to 0.5 s after arrival) and the split (split start to 0.5 s after it ends). Fan of N voices 2 semitones apart, glides of 1/2/4 s, smootherstep/linear/expo, pitches 45/57/69 (54 configs for N = 2 and 8; N = 32 at 2 s, smootherstep/expo). Medians of each config's lowest window and of its CV:

| | approach low / CV, before → after | split low / CV, before → after | distinct fan after the split (natural) |
|---|---|---|---|
| N=2 @45 | −6.8 dB / 0.19 → −3.0 / 0.05 | −6.3 / 0.21 → −2.8 / 0.08 | −2.1…+1.4 |
| N=2 @57 | −5.4 / 0.12 → −1.6 / 0.04 | −5.5 / 0.14 → −1.3 / 0.05 | −0.8…+0.7 |
| N=2 @69 | −3.9 / 0.08 → −0.8 / 0.03 | −3.9 / 0.09 → −1.2 / 0.04 | −0.5…+0.4 |
| N=8 @45 | −6.0 / 0.19 → −3.6 / 0.11 | −7.1 / 0.19 → −4.1 / 0.14 | −2.6…+1.6 |
| N=8 @57 | −5.1 / 0.12 → −2.6 / 0.07 | −5.6 / 0.15 → −2.7 / 0.07 | −0.6…+0.6 |
| N=8 @69 | −4.4 / 0.09 → −2.0 / 0.05 | −3.8 / 0.10 → −2.1 / 0.06 | −0.3…+0.3 |
| N=32 @45/57/69 | −6.4/−8.3/−6.6 → −4.9/−2.0/−1.8; CV 0.15–0.20 → 0.06–0.15 | −5.6/−5.5/−3.9 → −4.9/−2.6/−2.4 | ±2 |

Highs went from +2…+4.8 dB to ≤ +2 (mostly < +1). Windows outside ±1 dB: 24–37 % → 4–9 % (N=2), 14–17 % (N=8), 19–25 % (N=32). Worst single windows: −13.3 → −7.6 dB.
- **Target ±1 dB at 50 ms throughout: met for N = 2 at A3 and above; not for N ≥ 8 or at A2.** What is left are brief dips (one or two 50 ms windows) where an arriving or leaving voice crosses the slow-beat zone against a small core, or several mutually coherent voices leave together. At A2 a semitone already beats at 6.5 Hz, so the distinct fan itself varies ±2 dB. Closing the rest needs bigger bends (C beyond 100 cents) or a longer capture.
- The integrator's WAV measure (50 ms RMS, CV per 2 s window): `unison8` (= `unisonScore(8)`) 2–4 s 0.162 → 0.026; `unison-split-8` split window 6–8 s 0.136 → 0.054; `merge` 2–4 s 0.120 → 0.060; `gen-1-dorian` median 0.058 (unchanged), worst glide window 0.167 → 0.125. NB: `unison8-after`'s 0.24 at 10–12 s is the score's 0.5 s end fade, not a split (that fixture has none).

### Pitch correction (max, sine stems, zero crossings vs the written pitch)
- **≤ 60 cents** at A2–A3 (≤ 35 at A4), only in the last part of an arriving glide or the first part of a leaving one: the warp holds a voice on the unison while the score still has it ≤ 0.4 C away (≤ 45 cents), plus ≤ 14 cents of capture pull. In effect the glide lands ~0.2–0.4 s early and leaves ~0.2 s late. Held pitches are untouched (merge survivor bend 4.1 cents, was ≤ 6.7). To trade steadiness for smaller bends: `WARP_HZ` / `WARP_MAX` in voice.ts (8 Hz / 60 cents gave max ~30–50 cents and CV ~0.09 for N = 8).
- Crossings, glides passing a held voice and semitone intervals get no warp and sound as with no lock at all (a twin timbre with wobble 2.75: same detune, never locks): ≤ 0.64 dB and ≤ 0.3 cents; the 0.64 dB is the existing 20-cent lock touching a passing glide, unchanged from before.

### Kept
Held unison 0.950–0.958 × one voice, CV ≤ 0.0002 (was ≤ 0.0017); converge/hold/diverge 0.25 s windows 0.70–1.08; merge 0.91–1.13 (was 0.80–1.19); seek re-lock level 1.0000, clicks 0.05 (threshold 0.16–0.36); click suite and swaps unchanged; stems Σ − mix −144.1 / −143.5 / −147.0 dBFS; `wobble-8` CV 0.421; no-GC 0 lines (plain and lock, lock harness ×3 more); expo/bézier 18 scavenges/60 s (report only). RTF (CPU, best of 5 × 6 s, alternating with HEAD, load ~9): dense 24 voices 37–39× vs 37–42×; lock workload 64–66× vs 63–69×: no measurable change. rtf.test.ts gave 9.6× once in the full parallel run, 17× alone.

### Tests (tests/dsp/unison.test.ts)
50 ms approach/split bands added to converge/hold/diverge (CV ≤ 0.1/0.15/0.2, lowest ≥ 0.45, highest ≤ 1.45); warp anchors only for arrivals/departures (not crossings, passing glides, semitones, a 30-cent interval); crossings/passing/semitones vs a no-lock twin; a merging glide bends ≤ 65 cents and the voices hold their written pitch (≤ 6 cents incl. detune).

### For the integrator (PLAN §8.4)
1. New: glides into or out of a unison are pitch-warped near it (above): a deliberate deviation from the written glide of up to ~60 cents (A2–A3), ~35 cents (A4). §8.4's "Small corrections… during the last part of a glide" should state this.
2. Lock pull law: full strength beyond a quarter cycle; h smoothing 2 ms with block-end phase prediction.
3. θ unwinding now applies only to partings without a warp.
4. Owner A/B (renders/, 24-bit): `unison8-glide-after`, `merge-glide-after`, `gen-1-dorian-glide-after` (compare with the `-after` files); also `unison8-split-before` / `unison8-split-glide-after` (`unison-split-8`, which actually splits). Copied into the main checkout's renders/ as well.

## M3d2a: Generate panel (2026-11-20)

- **Files:** `src/app/generate-options.ts` (pure: `parseSeed`, `checkForm`, `generateFromRequest`, ranges), `src/app/ui/GeneratePanel.tsx` (native modal `<dialog class="dialog generate">`; `openGenerate()`, `runGenerate()`), `.dialog` styles in `styles.css` (the class is generic, so the Export dialog can reuse it). Tests: `tests/unit/app/generate-options.test.ts`, `tests/e2e/generate.spec.ts`.
- **Mount:** `<GeneratePanel />` in `App.tsx`; the menu's Generate item (was a disabled placeholder) calls `openGenerate()`.
- **Controls:** seed (text; digits are taken mod 2^32, other text is FNV-1a hashed, so any text works), "New seed", mode (radios), length (100–900 s slider, or "natural length" = core's default proportions, on by default), voices 2–32, walk density 0–100%. Choices persist while the page is open. Generate calls `generate(seed, opts)` with `now` = the current time and `loadPiece`s the result (stopped, overview).
- **Deviations:** tests live in `tests/unit/app/` (the Vitest include is `tests/{unit,…}`; there is no `tests/app`). No share-link change: `share.ts` encodes the whole piece, which already carries `seed`, so there is nothing to add for generated pieces. Because `now` goes into `meta.created`, two runs differ in `meta` only; the tests compare the piece without `meta`.
- **Key handling:** `canvas-input.ts` already ignores keys while a `dialog[open]` exists, so Space in the seed field doesn't toggle playback.

## M3d2b: Export dialog and `?dev` panel (2026-11-20)

- **Files:** `src/app/export-options.ts` (pure: form, option mapping, `sanitizeFileName`, `formatBytes`), `src/app/export-run.ts` (estimates and the three exports; imports the DSP graph, so it is **lazy**), `src/app/ui/ExportDialog.tsx` (native `<dialog class="dialog export">`; `openExport()`), `src/app/download.ts`, `src/app/dev-options.ts` + `src/app/ui/DevPanel.tsx`. Menu's Export item is live (`data-testid=open-export`). Tests: `tests/unit/app/{export-options,export-run,dev-options}.test.ts`, `tests/e2e/export.spec.ts`.
- **Lazy loading:** the dialog `import('../export-run')` when it opens and enables Export once loaded (the stems picker must be called synchronously in the click, so the module has to be in hand). Main chunk 363.44 kB to 375.39 kB (gzip 113.87 to 117.86 kB; this is the dialog UI, the dev panel and the option code); `src/dsp`, `src/audio` and `src/midi` are not in it (checked in the source map). `export-run` is its own 18 kB chunk next to the shared `stems-client` chunk.
- **Behaviour:** WAV, stems and MIDI as in the task. The size line is exact for WAV and stems (`wavExportSize`, `planStems`) and warns above 1 GB (text differs when the browser can stream to disk). Stems on Chromium: `pickStemsFile` in the submit handler, then `target` = the handle; cancelling the picker cancels the export, with no fallback to a download. Elsewhere the Blob is downloaded. Escape or Close while running cancels (aborts the worker; a streamed file is discarded). MIDI zips when the exporter returns several files. File names: sanitized title, `-stems.zip`, `-midi.zip`; MIDI file names come from `exportMidi`. Errors become a notice and an inline message. Extras beyond the task: a "re-strike on every arrival" checkbox (PLAN §12 lists it), and the grid BPM is passed to the MIDI tempo when the piece has one.
- **Dev panel:** `?dev` in the URL shows a fixed bottom-left box with "Allow line crossings". The flag lives in `dev-options.ts` (not in the Piece, files or links); `store.ts` passes `compileOptions()` to its three `compile` calls (`initial`, `loadPiece`, `recompileNow`), and the checkbox calls `recompileNow()`. It stays on while the page is open, across loaded pieces. Remove by deleting `dev-options.ts`, `DevPanel.tsx`, the `<DevPanel />` line and the three `compileOptions()` arguments.
- **Tests note:** `tests/unit/app/dev-options.test.ts` imports the store in Node (audio module mocked) and needs `/// <reference types="vite/client" />` because `tsconfig.node.json` doesn't load Vite's types. A Vitest trap: `beforeEach(() => spy.mockClear())` returns the spy, which Vitest then calls as a cleanup hook; use braces.
- **e2e (Chromium dev + prod, 20 tests, ~15 s):** the stems picker is stubbed with an OPFS-backed function that throws unless `navigator.userActivation.isActive`, so it proves the synchronous call; everywhere else `showSaveFilePicker` is deleted to test the download path. The real native picker is not covered.

### Timing-test CI flake fixes
stems.test.ts export tests: explicit 30 s timeout. render.spec.ts: 12 ms guard when CI is set without ALGORHYTHMS_PERF_STRICT=1; 4 ms otherwise.

### Dev toggle: compile option `crossings`
`compile(piece, { crossings: "allow" })` (also `compileWithTrace`) skips crossing enforcement and its diagnostics (`CompileOptions` in compiler/compile.ts, `CrossingsMode` in plan.ts); default `"forbid"` is unchanged. Not on Piece or in the schema; tests in tests/unit/core/crossings-option.test.ts (no tests/core dir exists).

### Line colours: "Per voice" removed, "By pitch" default (owner ruling 2026-11-20)
- **Shared contract:** `LineColors` in core/types.ts drops `'voice'` (now `'ink' | 'pitch' | 'custom'`); `DEFAULT_VIEW.colors` is `'pitch'`. Schema enum and docs/file-format.md updated.
- **Old files:** `parsePiece` maps `view.colors: 'voice'` to `'pitch'` before validation (`renameRetiredValues` in schema.ts), with no warning and no version bump. Not a migration step because version-1 files carry it. Share links go through `parsePiece`, so they are covered too.
- **Render:** golden-angle voice palette removed (`GOLDEN_ANGLE`, `voiceHue`, `voiceColor`). In 'custom', a voice with no `VoiceDef.color` now falls back to the theme ink, not a voice hue. draw.ts unchanged.
- Examples and property regressions now say `"pitch"`. render.spec.ts benchmark: base `'pitch'`; the solid baseline is `'ink'` (`ink-24-flush` holds the 4 ms budget that `voice-24-flush` held).

## Generate length 30-900 s; `?dev` panel removed (2026-11-20, owner rulings)
- Length slider 30-900 s, default 2:30 (150 s); "natural length" stays but is off by default (`DEFAULT_FORM.naturalLength = false`).
- **Core floor, not fixed (src/core untouched):** `generate()` keeps every section, so any length below about 100 s still yields about 100 s (11 moments, 8 to 10 s apart, ends 99.6 to 103.7 s for seeds 1, 7, 99, 12345 at 30 s and 60 s; identical to each other). So the 30-100 s part of the slider has no effect. Needs a core decision (shorter fixed sections) if real 30 s pieces are wanted.
- `?dev` panel removed as in the M3d2b recipe: `dev-options.ts`, `DevPanel.tsx`, its unit test, its e2e test, `.dev-panel` styles, and the `compileOptions()` arguments in `store.ts`. Core `CompileOptions.crossings` left as is.

## HUD chord (owner request, 2026-11-20)

- **Core:** new `src/core/harmony.ts` (`harmonyLabel`, `nameChord`, `spellPc`); the compiler records `CompiledScore.harmony?: HarmonyChange[]` (new type in types.ts; optional so hand-built scores still type-check) after every applied point moment: the active voices' destination pitch classes, bass, and a precomputed `label`. A written chord symbol always starts an entry; other moments (unison, shift, spread, pin, merge, chords from pitches/degrees) add one only when the pitch-class set or bass changed. Walk, key and level moments add none. `chordAt(score, t)` in query.ts: binary search, null before the first entry.
- **Labels:** letter symbols as written with ♯/♭ (`F♯m7♭5`); numerals as `ii7 · Dm7`, `♭VII · B♭`, `V7/V · D7`, root letter spelled from the tonic letter; recognised sets as `F/A`, `Am7`, `A (unison)`; anything else lists pitch classes from the bass (`C C♯ D D♯`). Written symbols get no inversion slash added.
- **HUD:** chord top right (ink, 500 12px); the key moved to line 2 as `a dorian · following`. Per frame: one binary search and one `fillText` of the cached label; the label width is measured once per label. When the chord would overlap the `f(n)` formula (phones), the formula is skipped.
- **Goldens:** hashes regenerated (the score gains `harmony`); summaries otherwise unchanged.

## Generate: short form below 100 s (2026-11-20)

- **Rule:** `length` < 100 s (`SHORT_FORM_BELOW`; below 30 s treated as 30) uses `shortPlan()` in `src/core/generate.ts`. Natural length and `length` ≥ 100 s take the old path unchanged: byte-identical, checked by SHA-256 snapshot `tests/unit/core/generate-snapshot.json` (232 cases, recorded before the change).
- **Shape:** Seed, Split (straight to the full voice count) and Home always. Then, in order, each added while it fits at the target time scale: Drift chord, middle split stage, Thin chord, Gather+Burst+Walk (4 ticks), more split stages, Drift, Thin, extra Drifts. Sections keep prototype order; empty ones are not marked. Typical: 30 s = Seed, Split, Drift, Home (3 moments); 45–60 s adds Thin and split stages; ≥ ~75 s has all eight.
- **Timing:** target scale rises linearly 0.75 (30 s) to 1 (100 s); the actual scale is then solved so the piece ends exactly at the request. It multiplies every section gap and every glide's length and stagger; walk ticks stay 1 s. Min gap between moments 5.8 × 0.75 ≈ 4.35 s (measured ≥ 5.4 s on sampled seeds); each glide plus stagger ends before the next moment.
- **Measured:** lengths 30–99 end exactly on target; 100 and 150 end at 101–104 and 152–157 as before. Tests: `tests/unit/core/generate-length.test.ts`; the old "length 30 keeps every section" assertion in `generate.test.ts` now checks the 100 s floor instead.
- **Integrator, on merge:** the snapshot was recorded on a base where `DEFAULT_VIEW.colors` was `'voice'`. Re-hashed after checking that all cases match the old hashes once `view.colors` is set back to `'voice'`, so the only change is the colour default.
- **E2E silent locally:** Chromium `--mute-audio`, Firefox `media.volume_scale=0.0`; WebKit has no mute option, so its projects run only with `CI` or `E2E_WEBKIT=1` (CI's webkit job sets CI).

## M4b: editor actions and undo (2026-11-20)

**API** (`src/app/editor/`; `MomentId`/`Piece`/`MomentType` from core/types):

- `history.ts`: `useEditor` (Zustand: `selection: MomentId[]`, `canUndo`, `canRedo`, `undoLabel`, `redoLabel`); `edit(recipe: (p: Piece) => Piece, label?): boolean` (one entry; returning the same piece = no entry); `beginGesture(label?)`, `updateGesture(recipe)` (recipe gets the piece _at gesture start_; no entry), `endGesture()` (one entry if changed), `cancelGesture()`, `inGesture()`; `undo(): boolean`, `redo(): boolean`; `select(ids)`; `resetHistory()`; `HISTORY_CAP = 200`.
- `actions.ts` (each one undo entry): `addMoment(type, at): MomentId` (selects it), `updateMoment(id, patch: MomentPatch, label?): boolean` (`undefined` removes a field), `moveMoments(ids, dt): boolean`, `deleteMoments(ids): boolean`, `duplicateMoments(ids, dt): MomentId[]` (selects the copies), `reroll(id): number | null`.
- `ops.ts` (pure recipes, for gestures): `insertMoments`, `patchMoment`, `moveMomentsBy`, `removeMoments`, `copyMoments(p, ids, dt, newIds?) → { piece, ids }` (pass the same `newIds` on every Alt-drag frame), `newMomentIds(p, n)`, `randomU32()`.
- `new-moment.ts`: `defaultMoment(type, at, id, piece, score)`.
- Drag pattern: `beginGesture('Move moment')`; per frame `updateGesture(p => moveMomentsBy(p, ids, totalDt))`; `endGesture()`, or `cancelGesture()` on Escape.

**Behaviour:**

- `piece.moments` stays stably sorted by `at` (ties keep array order, so the sound is unchanged).
- Moves clamp the group's dt so its earliest moment stops at 0 (spacing kept). A walk's `until` moves with it in move and duplicate, not in `updateMoment({ at })`.
- Duplicate copies get `seed = momentSeed(piece.seed, orig.id, orig.seed)`.
- Selection is pruned on every piece change; undo and redo also restore the selection of that side of the edit. Undo during a gesture cancels it; `edit`/`redo` during a gesture end it first.
- History reset through a new `onLoadPiece(fn)` hook in store.ts (the only store change).
- Keys (canvas-input.ts): ⌘/Ctrl+Z undo, ⇧⌘/Ctrl+Z and Ctrl+Y redo; skipped with a dialog open and in text fields (native undo there).
- Ids: `base62Id(crypto random u32)`, retried until unique in the piece.
- `addMoment` uses the store's `compiled` when it matches the piece, else compiles once (cached).

**Defaults** (from the state at `at`; n = sounding voices; glide and target from the piece defaults): chord: degrees [0,2,4] (tonic triad), or [3,5,7] if every sounding pitch class is already in the tonic triad; even, ordered · unison: 'center' (n ≥ 2) else 'tonic', no octaves · split: count min(pool, max(n+2, 3)), current notes, even · merge: count max(1, ⌈n/2⌉), top, fade 2 · shift: +2 scale steps · spread: ×1.5 around mean, snap scale · walk: 16 s, grid 1, density 0.45, steps [-2,-1,1,2], stepGlide 0.3 · pin: top sounding voice, +2 scale steps (first pool voice if none sounds, which then errors 'pin-inactive') · key: up a fifth, same scale · level: gain 0.5 over 2 s. Inaudible cases: unison/spread/merge with one voice, split with a full pool.

**Other:** `tsconfig.node.json` (tests) now includes `vite/client` types, since tests import the store (→ `import.meta.glob`). Tests: `tests/unit/app/editor.test.ts` (store in Node, audio mocked, rAF synchronous). Timing tests (compiler-perf, dsp rtf/export) fail only under the current machine load (load avg ~48); they pass alone.

## M4c: persistence (2026-11-20)

- **Files:** `src/app/persist/{library,idb,autosave,index}.ts`, `src/app/ui/MyPieces.tsx` (native `<dialog class="dialog my-pieces">`), Menu items New / My pieces… / Save as file… / Link to a file… (Chromium only), `<MyPieces />` in App, styles. Tests: `tests/unit/app/persist.test.ts`, `tests/e2e/my-pieces.spec.ts` (Chromium dev + prod).
- **Store hook (minimal):** `LoadOptions.source` (`'generated' | 'new' | 'library' | 'other'`) and `loadInfo()` (a load counter + source). Persistence uses `usePlayer.subscribe`: a piece change with a new load count is a load, otherwise an edit. A counter, not piece identity, so an undo back to the loaded piece still counts as an edit. GeneratePanel passes `source: 'generated'`.
- **Rules:** an edit (or Generate / New) gives the open piece an entry; examples, files and links save nothing until edited. Reopening from My pieces keeps saving to that entry. Debounce 500 ms; a load, closing the tab (`pagehide`/hidden) or opening My pieces flushes. Deleting the open piece's entry: the next edit starts a new one. `navigator.storage.persist()` on the first save of each session; the status line shows not-yet-asked / granted / not granted / unsupported (`persisted()` is checked at start).
- **Entry:** `{ id, title, created, updated, json (serializePiece, meta.modified = save time), fileSavedAt?, file? }` in IndexedDB `algorhythms`/`pieces`. Marker: "not saved to a file", "changed since saved to a file", "saved to a file", "linked to <name>".
- **New:** `newPiece` defaults: 12 voices, v1 at A3, A dorian, glass, random seed, title "Untitled".
- **Files:** Save as file downloads `<sanitized title>.algorhythms.json` and marks the entry (no entry is created for an unedited example). Download all zips every entry (`algorhythms-pieces.zip`, repeats get `-2`, `-3`; fflate loaded on demand) and marks them all saved to a file. Link to a file: `showSaveFilePicker`, creates the entry if needed, writes now and on every autosave while write permission is granted; reopening a linked entry from My pieces re-asks permission (that click is the gesture). The link path is not covered by e2e (native picker).
- **Safari note:** shown on Safari and every iOS browser (`evictsAfterAWeek`).
- **Traps:** full `pnpm test` under load (~24) failed only the two timing tests (rtf, compile-perf); both pass alone.

## M4f: palette and shortcuts (2026-11-20)

- `src/app/editor/shortcuts.ts`: `PALETTE` (type, letter, name, icon, hint), `momentTypeForKey`, `editorKey(e)` (pure guard + mapping), `takesText(target)`, `snapToGrid(t, bpm?)` (nearest beat of `view.gridBpm`), `addAtPlayhead(type)`, `deleteSelection()`, `clearSelection()`.
- Keys (canvas-input.ts `attachKeys`): C U S M T P W I K L add at the playhead (snapped); Delete/Backspace delete the selection; Escape clears it. Skipped with a dialog open, in text fields (text/number inputs, textarea, select, contenteditable; not buttons or sliders), with ⌘/Ctrl/Alt (letters: also Shift, auto-repeat), and outside the wide layout (`.app[data-layout="full"]`). Delete/Escape only `preventDefault` when they did something.
- `src/app/ui/Palette.tsx` + `palette.css`: a toolbar row ("Add" + 10 buttons, tooltip "hint (K)", `aria-keyshortcuts`), mounted as the first item of the ViewBar (full-width row above the view controls), hidden in the player layout. Placed there rather than as its own workspace grid row so the lane builder keeps sole ownership of the grid areas; move it next to the lane later if wanted.
- Help (Menu.tsx) gains an "Editing" list: the ten letters (from `PALETTE`), Delete/⌫, Esc, ⌘/Ctrl+Z, ⇧⌘/Ctrl+Z (Ctrl+Y).
- Not done: drag from palette onto the lane (needs the lane's internals); disabling letters during musical typing (§9, M7: add a check in `editorKey`'s caller then).
- Tests: `tests/unit/app/shortcuts.test.ts`, `tests/e2e/palette.spec.ts` (Chromium only).

## M4g: voices drawer (2026-11-20)

- `src/app/ui/VoicesDrawer.tsx` (+ `voices.css`): bottom panel under the workspace, wide layout only; "Voices" toggle in the view bar (hidden by CSS in the player layout). Pool size, voices at start (count, plus per-voice start toggle and pitch), and per voice colour, timbre, pan (auto toggle + slider), gain (0–2, shown in dB), range (MIDI with note names), mute, solo (Alt-click: solo only this voice), Clear solo. Esc closes.
- Pure recipes in `src/app/editor/voices.ts`; every change is one `edit`; slider and colour drags are one gesture. Number fields commit on Enter, blur or a stepper/arrow step, not per keystroke (typing "12" must not shrink the pool to 1 on the way).
- **Pool shrink** removes the last voices (highest pool index): their `start` entries go; `{ voices }` targets drop them; a moment left with no target, or a pin on a removed voice, is **deleted**; split/merge counts are clamped to the pool. An info notice names the deleted moments' count; undo restores. **Grow** appends `v<n>` (first free id), copying the last voice's timbre and range.
- Choosing a built-in timbre copies it into `piece.timbres` (as `newPiece` does). Starting a voice picks a fifth above the highest start pitch (else A3), folded into its range.
- Playback: all fields already reach the engine through `setPiece` → recompile → `swap` (CompiledVoice carries gain/pan/mute/solo/timbre). No engine work needed. Each change costs one recompile.
- View bar: added "Custom" to Lines (the renderer already supports `colors: 'custom'`), so voice colours can be seen.
- Note for canvas-input owner: ⌘Z is passed to the native control when a `select` or any `input` (checkbox, range) has focus, so after picking a timbre ⌘Z does nothing until focus moves. Consider letting ⌘Z through for select/range/checkbox.
- Tests: `tests/unit/app/voices.test.ts`, `tests/e2e/voices.spec.ts` (Chromium).

## M4e: inspector (2026-11-20)

**Files:** `src/app/ui/Inspector.tsx` (column: none / one / several selected), `src/app/ui/inspector/` (`fields.ts` pure parse/format helpers, `controls.tsx` fields + edit plumbing, `NoteSetField.tsx`, `TypeFields.tsx`, `CommonFields.tsx`), `src/app/ui/inspector.css` (sets `--inspector-w: 288px` in the wide layout). App.tsx renders `<Inspector />` in place of the hidden slot. `debug.ts` gains `editor: { state, select, undo, redo }`.

**Behaviour:**

- One moment: header (type, time, Muted), inline diagnostics, label, time, every §6.2 field for its type, target (all / chosen voices / rank, ranks shown 1-based), glide (length, stagger, jitter, order, ease + bézier params, curve preview, "use defaults" removes `glide`), seed (effective, "(derived)" if implicit) with Reroll, Delete. Key moments hide target/glide/seed; level hides glide/seed.
- Several: count, Mute/Unmute all (one entry), Delete. None: hint with the add shortcuts.
- Text/number fields commit on Enter or blur, only valid values (error shown inline, `aria-invalid`); Escape reverts; ↑/↓ step (one entry each). Number labels scrub on drag and sliders drag as one gesture (one undo entry; pointercancel cancels). Gesture state is one module flag in `controls.tsx` (`fieldSetter`).
- Chord field: live parse (`parseChord` in the key in effect at the moment, from `compiled.keys`) shows spelled notes or the error. Degree picker: toggle buttons over two octaves (widened to any stored degree); it cannot empty the set. Pitches accept note names (C4, F#3, A4+50) or MIDI numbers.
- Switching NoteSet kind uses defaults (chord 'I', degrees [0,2,4], pitches C4 E4 G4); for split, 'current' removes `notes`.

**Tests:** `tests/unit/app/inspector-fields.test.ts`; `tests/e2e/inspector.spec.ts` (Chromium only: hint/multi-select, chord symbol invalid→valid, glide length, Reroll, undo chain, label drag = one entry, degree picker by keyboard).

## M4h: selection highlight and hover (2026-11-20)

- **render:** `ScoreStyle.highlight?: ReadonlySet<MomentId>`. When non-empty, all lines draw at `DIM_ALPHA` (0.3) and the runs of segments with a selected `momentId` (contiguous segments merged, clipped to the window) are re-stroked on top at `HIGHLIGHT_WIDTH` 2.75 px, past alpha 1, future alpha max(futureOpacity, 0.6) so the selection shows during playback too. Empty set: identical ops to before. `drawScore` now returns the `View` it drew (was `void`).
- **render/hover.ts:** `nearestLine(compiled, view, x, y, radius = 6, includeFuture)` probes each voice at 9 times across ±radius (catches steep glides); `noteLabel(p, key?)` ("F♯4", "A4 +12¢", spelled in the key via `spellPc`, octave fixed for B♯/C♭); `hoverLabel` → "`<voice name or 'voice N'>` · `<note>` · `<Hz>` Hz".
- **app:** `app/hover.ts` holds the mouse position (mouse only, no button down; cleared on press and pointerleave). The loop passes `useEditor` selection each frame (Set rebuilt only when the array changes; editor store changes mark dirty) and re-hit-tests when it drew or the pointer moved, writing a `.score-hover` div (`data-testid="score-hover"`) by direct DOM writes. Future lines are hoverable only while the ghost is visible.
- **debug:** `actions.select` added to `window.__algorhythms`.
- Tests: `tests/unit/render/selection.test.ts`, `tests/e2e/score-hover.spec.ts` (Chromium). render.spec bench unchanged and within budget (it does not exercise a selection; the extra pass covers only selected segments in view).

## M4d: moment lane (2026-11-20)

**Files:** `src/app/ui/Lane.tsx` (+ `lane.css`), pure helpers `src/app/editor/lane.ts`; `App.tsx` renders `<Lane />` in the wide layout; `loop.ts` gains `onScoreFrame(fn)` (each frame's camera `View`; the `cam` object is now built once per frame). Tests: `tests/unit/app/lane.test.ts`, `tests/e2e/lane.spec.ts` (Chromium); `app.spec.ts` now expects the lane slot visible.

**Design:** React renders items (on piece/score/selection change). Positions: one inner container gets `translateX(xAnchor − tc·pps)` each frame; items sit at `at·pps` and are rewritten only when pps or items change. Three rows of 20 px, greedy packing in pixel space (frozen during a drag). Bars: compiled `MomentSpan` when the moment hasn't moved since that compile and the span is non-empty, else an estimate (stagger + length; walk `until`; level `over`; key = point). Drags preview by direct transform writes and commit once per rAF via `beginGesture/updateGesture/endGesture` (Escape → `cancelGesture`).

**Behaviour choices:**
- Lane marker = `moment.at`; the canvas draws its marker line at the span start (first move), so they differ by up to the stagger/jitter offset.
- Alt at press = duplicate; Alt held at any time = no snap. So an Alt-drag copy is unsnapped unless Alt is released mid-drag.
- Span-end drags are not snapped. They edit `glide.length` (Shift: `glide.stagger`), a walk's `until`, a level's `over`; key moments have no handle. Handles hide on bars < 6 px.
- Pressing a selected item keeps the selection (group drag); click without drag then selects it alone. Shift-click toggles. Empty-lane click clears.
- Keys on a focused item (stopPropagation): ←/→ nudge (grid step to the next line, else 0.1 s; acts on the selection if the item is in it, else the item); ↑/↓/Home/End roving focus in time order; Delete/Backspace delete (focus moves to a neighbour); Enter/Space select (Shift toggles). So Space on a focused lane item selects rather than plays.
- Live region announces moves, duplicates, glide/stagger/until/over changes, deletes, cancelled drags.

**Not done:** focusing an off-screen item doesn't pan the view; no touch long-press menu (§11.3b); marquee and copy/paste (M5).

## M4a: compiler speed (2026-11-20)

- **Result:** §7.10's 5 ms is still not met. Instructions retired per compile of the benchmark piece (macOS `time -l`, startup subtracted; load-independent, ±1 %): **347 M → 151 M under Vitest's module runner** (what the perf test measures), **186 M → 150 M bundled** (what the browser runs). Strict test median: 17.4 ms before (load ≈ 4); after, 25–50 ms at load 15–50 during this session, so no clean wall-clock number. By instruction ratio, about **7.5–8 ms** at the old load.
- **Output unchanged:** goldens, generate snapshot and all tests pass untouched; a scratch fingerprint (score + trace JSON of 3,233 pieces: bench, 232 generate cases, examples, regressions, 3,000 fast-check `pieceArb` pieces, crossings forbid and allow) is identical before and after.
- **Profile before (Vitest):** crossing check 50 % (sampling 24 %, projection builds 15 %, of which carried-velocity clamp 8 %), committed-destination sorts 9 %, harmony labels 6 %, GC 5 %. About half of all time was Vitest's module runner: every imported binding is a getter call (`__vite_ssr_import_N__.fn`), and hot loops read `CHECK_SAMPLES`, `segmentPitch`, `easeRaw` that way.
- **Changes:**
  - *Local aliases* (`const easeAt = easeRaw`, `SAMPLES = CHECK_SAMPLES`, …) in plan.ts, project.ts, voice.ts, segment.ts, interrupt.ts: no effect when bundled; the largest single win under Vitest.
  - *Lazy, block-pruned crossing scan* (plan.ts `crossing`): samples are computed on demand; after the reference sample, a block of 8 samples is skipped when `Projection.boundsIn` (each record clipped to where `pitchAt` uses it; named eases are monotone, so they are evaluated at the clip ends; H's bounds are exact; padded 1e-10) proves the pair cannot be out of order there. Gives the same index as the full scan. Pitch evaluations per compile: 167 k → 45 k; 78 % of blocks pruned. Unsorted records (never seen) fall back to the in-order full fill.
  - The final `crossing-unresolved` count skips pairs whose clear result is still valid (`clearAt`). Crossing calls: 5,052 → 2,978.
  - *Allocations:* projection records and per-moment arrays are plain arrays (small typed arrays are off-heap allocations); sample and block caches are module scratch with global generation stamps; projections cached on the part.
  - `sortByDest`: precomputed keys and insertion sort (same order: (destination, index) is a strict total order; falls back to `Array.sort` if a key is NaN). Harmony labels memoised per compile. `goldenMin` takes scalars instead of a closure (same arithmetic).
- **Where the rest goes (bundled, 150 M):** crossing enforcement about 70 M (`crossings: 'allow'` compiles in 75 M); carried-velocity clamps (`overshootScale` + golden search, about 1,100 full clamps per compile) about 15 M wherever they run; the moment functions, sorts and GC the rest. The profile is now flat; further gains need structural work (below).
- **Next steps for M4:**
  - *Incremental compile* (recommended): feasible, since the simulation is causal. Snapshot per moment event: each `VoiceRun` (status, diedAt, pending moves, pendingBirth, frontier tail **by value** since `finishAt` mutates it, open `Life` by value, array lengths of segs/lives/level), the event queue, key, keys/harmony/diags lengths, lastActivity, and spanStart/spanEnd (later moves extend earlier moments' spans). Moves carry mutable `cancelled` and `memo`. Restore at the last checkpoint before min(old at, new at) of the edited moment; a reordered moment list, voice-def or init-time diagnostic change means a full compile.
  - A cross-compile memo of `carriedVelocity` (pure; keyed by its 8 inputs) would make repeat compiles much cheaper, but it also makes the benchmark measure a warm cache, so it was not done.
- **Perf test:** unchanged. It runs under Vitest's module runner, which nearly doubled the cost before the aliases (347 M vs 186 M bundled) and now adds about 1 %.

## M4k: editor polish (2026-11-20)

- **Marker agreement:** `ScoreStyle.markerTimes?: MomentTimes` (id → seconds); `drawMarkers` draws at it, falling back to the span start; markers still only for moments with a span. The loop passes `moment.at` from the piece (rebuilt on piece change, with labels), so canvas markers sit where the lane puts them. No core change.
- **Reveal on focus:** focusing a lane item (Tab, arrows) pans the paused view so its marker is ≥ 48 px inside the lane (`revealPan` in editor/lane.ts). While playing, `panBy` is a no-op, so nothing moves (the camera follows the playhead).
- **Escape:** the menu's Escape listener is now capture-phase and calls `preventDefault`; the voices drawer's does too. `attachKeys` ignores editor keys (letters, Delete, Escape) when `defaultPrevented`, so a key another handler used is not acted on twice.
- **Drag from palette:** `src/app/palette-drop.ts`. Palette buttons are HTML5 drag sources (`application/x-algorhythms-moment`); the canvas and the lane track accept drops (dashed accent outline while over). Drop time = `xToTime` of the latest frame's `View` at the pointer, `snapToGrid` like other adds; one `addMoment` (one undo entry, new moment selected). Click still adds at the playhead. No touch drag (HTML5 DnD; tablets keep click).
- Tests: `tests/unit/app/canvas-input.test.ts` (key guards: dialog, layout, text fields, modifiers, repeat, Delete/Escape, `defaultPrevented`, undo pass-through, Space/arrows), `palette-drop.test.ts`, `revealPan` in `lane.test.ts`, marker times in `render/draw.test.ts`; `tests/e2e/editor-polish.spec.ts` (Chromium: palette drop onto lane and score, Escape with the menu open). Reveal on focus has no e2e.
- Trap: Playwright reuses any server already on port 5180, possibly another worktree's. Run with `E2E_DEV_PORT`/`E2E_PROD_PORT`/`E2E_OUT_DIR` set.

## M4j: incremental compile (2026-11-20)

- **API:** `createIncrementalCompiler(options?)` in `src/core/compiler/incremental.ts` → `{ compile(piece), reset(), stats }`. Output equals `compile(piece, options)`; `compile` itself is unchanged (it gained an `onMomentEvent` hook, null by default; `Compiler` and the move-start sub-order constants are exported for incremental.ts; `EventQueue` gained `items`, `next`, `restore`). Wired into `src/app/store.ts`: one instance; the initial piece, `loadPiece` (after `reset()`) and `recompileNow` use it.
- **Design:** a checkpoint before every 2nd moment event. Next compile: k = first moment index whose moment differs (identity, then structural), T* = earliest `at` of any moment at index ≥ k in the old or new array; resume from the last checkpoint at or before (T*, k) in event order. Correct for unsorted arrays too (it resumes earlier). The rebuilt queue = the new piece's moment events and first walk ticks not yet handled + the checkpoint's move starts and later ticks (original `seq` kept). Checkpoint contents: see the file header. To keep GC low, per-voice state is two flat arrays; tails and open lives are stored as a reference plus the fields the run mutates (tail t1/p1/curve), and restored as fresh copies; only the spans of moments with a queued move or tick are stored (other handled moments' spans are final, read from the previous run).
- **Full compile when:** no previous state; seed, key, end, start, `defaults.glide`, or voice ids/ranges differ; moments are not arrays; or no checkpoint precedes the change. Output-only voice fields (gain, pan, timbre, sends, mute, solo) and `tuning` resume normally (`finish` reads them fresh).
- **Numbers** (benchmark piece, bundled with rolldown, Node 22). Instructions per compile (`time -l`, (250 − 50 runs)/200), and median wall time at load 3–6:

  | | instructions | % of full | median ms |
  |---|---|---|---|
  | full `compile` | 145 M | 100 | 8.3 |
  | incremental, first (full + checkpoints) | 154 M | 106 | 8.45 |
  | edit at 10 % | 149 M | 103 | 8.0 |
  | edit at 50 % | 90 M | 62 | 4.6 |
  | edit at 75 % | 55 M | 38 | 2.5 |
  | edit at 90 % | 25 M | 17 | 0.8 |
  | unchanged piece | ~6 M | 4 | |

  Cost ≈ 6 M fixed (setup, restore, `finish`) + the simulation after the checkpoint. A checkpoint before every moment event cost +11 % on a full compile (+27 % before the flat layout: GC).
- **Tests:** `tests/property/core/incremental.property.test.ts` (150 pieces × up to 10 edits: editor ops move/patch/insert/remove, raw replace, unsorted swaps, mute, voice gain, start change, JSON clone; after each, deep-equal to `compile` and the previous score unmutated; ~2/3 of edits resume; 4,000 random-seed runs passed). `tests/unit/core/compiler-incremental.test.ts`: bench edits at 10/50/90 %, every example (moves ±0.5 s, deletes at four positions), `crossings: 'allow'`, setup fallback, reset. `momentArb` is now exported from compiler-arbitraries.ts.
- **Traps:**
  - Successive scores share segment and closed-life objects: consumers must not mutate a compiled score.
  - It relies on these invariants of compile.ts/voice.ts: pushed segments, closed lives, level points and diagnostics are never mutated; `finishAt` mutates only the tail's t1/p1/curve; an open life has only `born`/`fadeIn`; a scheduled Move changes only `cancelled` and `memo` (`memo` is a pure cache); a span changes only through its own moment, its moves or its walk ticks. A compiler change that breaks one must update incremental.ts; the property test should catch it.
  - A resumed score may hold structurally equal objects from an earlier piece (e.g. a key after a JSON round trip), so `toStrictEqual` can fail on prototypes alone; the test compares `structuredClone`s.
- **Left:** an edit at exactly 50 % costs ~62 % (the fixed part plus the tail). Stopping early when the resumed state converges to the old run's would help, but states rarely match exactly after an edit; not attempted.

## M4 acceptance checks (integrator, 2026-11-20)

- **Mouse alone:** from New, built a 66 s piece in the browser pane using only palette clicks, the position slider, lane selection and the inspector's Delete. Pass. (In a hidden browser pane rAF is throttled, so the scrubber max and canvas lag; that's not an app bug.)
- **Undo:** every editor action goes through `history.ts` (M4b tests); spot-checked undo of a delete. Pass.
- **Edit during playback ≤ 50 ms, no clicks:** measured `setPiece` → `swap` posted to the worklet in headless Chromium (dev server, load ~7), 15 edits each; the worklet applies a swap at the next 2.7 ms block. Example piece (21 moments): median 12 ms, max 14 ms. Generated 10-min, 24-voice piece (57 moments): edit at 10 % median 23 / max 43 ms, 50 % 15 / 28, 90 % 12 / 14. Worst case ≈ 46 ms before device output latency (excluded, as in M7's criterion). Mostly the rAF wait plus compile; the production bundle is faster. Clicks on swap: `tests/dsp/clicks.test.ts`. Pass, thin margin on long pieces when editing early; a compile worker would widen it.
- **Storage status + Download all:** My pieces shows the persistence status and "Download all (n not in a file)"; `tests/e2e/my-pieces.spec.ts` checks the zip. Pass.

## Editor view redesign: owner direction (integrator, 2026-11-20)
The owner looked at M4 and wants the editor reworked before M5. Mockup (interactive, made-up music): https://claude.ai/artifact/29KnYtonhJGSZKEj12Jogm (v3). Nothing built yet; owner said not to start builders yet.
- **One time axis.** The bottom scrubber (whole piece) never lined up with the graph's playhead (follow camera, 20 s window). Replace it with a time ruler above the graph (click/drag to seek); one playhead line through ruler, lines and every lane row.
- **Whole piece drawn;** future lines **dimmed** by default (today they are hidden, as in the prototype video).
- **Follow:** Smooth (default; view scrolls, playhead held near 35 %), Page, or Off, as a toggle.
- **No overview strip;** a big zoom slider (2–5 s to whole piece) with −/+ and Fit is enough.
- **Lanes under the moments** on the same axis: Transitions (each moment's glide incl. stagger; walks as regions), Level (volume curve from level moments), Effects (timbre changes, M6).
- **Inspector: much more customisation.** Chords picked, not typed: diatonic suggestions from the key, root + quality + bass, voicing; live notes and Roman numeral. Transition sliders (length, stagger, curve). Level sliders.
- **Walks: move individual steps** (dots on the lines + step list with up/down). Needs a model change: walk steps are seeded, so edited steps must be stored as overrides (or the walk frozen); decide in the PLAN revision.
- Next: integrator revises PLAN §10 (view) and the editor sections, then splits the work into builder tasks once the owner says go.

## PLAN revision 5: editor view (integrator, 2026-11-20)
Drafted from the owner's direction and mockup (section above). Integrator calls, open to the owner:
- **Walk steps** are stored as relative overrides (`edits`, keyed by tick and voice id), not by freezing the walk: later steps of that voice follow the moved note, and the walk still adapts to earlier edits. The compiler reports `walkSteps` for the dots and list.
- **Pan during playback turns Follow off.** Smooth clamps at the piece's ends, which replaces the overview blend.
- **Phones keep the scrubber;** the ruler replaces it in the editor layout.
- **Effects row** stays hidden until the M6 `timbre` moment.
- New milestone **M4.5** before M5. Builder split: `docs/integrator-handoff.md`.

## M4.5 approved (owner, 2026-11-20)
Owner said go; the editor mockup looks good. Rulings:
- **Moving a walk step freezes the walk** into absolute notes (`fixed: WalkNote[]`), replacing the relative `edits` draft. Unfreeze drops it. PLAN §6.2, §7.9 (`walkSteps.fixed` replaces `edited`), §11.3, §15 updated.
- The inspector must expose the walk generator values (density %, allowed steps, grid, glide, bass leap); added to §11.3 and the M4.5 checks.
- Pan turns Follow off; phones keep the scrubber (owner doesn't care about phones); Effects row hidden until M6: all accepted.
- **Generate confirms** before replacing an edited piece (§11.3).
- Tablet touch editing (M5): low priority but in scope.
- Integrator may push to `main`. Cloud: `git push` works; `gh` is not authenticated, use the GitHub MCP tools for CI.

### B8: Generate confirms before replacing an edited piece (§11.3)
"Edited" = the editor's undo stack is non-empty (`useEditor.canUndo`; every load clears it), so no store change. Generate on an edited piece swaps the dialog body for "Replace the current piece?" (Replace / Cancel; Cancel returns to the form). Autosave (§11.4) saves an edited piece at its first edit, so the copy "saved in My pieces" is true. Specs in `tests/e2e/generate.spec.ts`.
## M4.5-1: frozen walks in core (2026-11-20)
- `types.ts`: `WalkNote`, `WalkMoment.fixed?`, `WalkStepRecord`; `CompiledScore.walkSteps` (required, §7.9). Hand-built scores (flat.ts `fromFlat`, audio fixtures, test fixtures) get `walkSteps: []`.
- `schema.ts`: `fixed` = `{ tick: int ≥ 0, voice, pitch }[]`; rejects unknown voices and duplicate (tick, voice); parse sorts by tick (stable). Additive, no migration or version bump. docs/file-format.md regenerated.
- Compiler: a walk with `fixed` (even `[]`) never calls `walkTick`, so no draws. Ticks are queued only where notes exist (tick 0 always). Per tick: each listed voice that is active, in target, idle and not driven by a later walk glides (`stepGlide`, walk ease) to its note. A moving note that leaves the range, or crosses/touches a neighbour's final destination, holds; reverting repeats until stable (`warn walk-note-blocked`). Notes on inactive/untargeted voices, voices still moving or claimed by a later walk, or at/after `until` → `info walk-note-ignored` (one per tick/kind). Unknown voice → `warn unknown-voice`.
- **Clarification (not in §6.2):** busy voices (mid-glide, pending moves) skip a fixed note, like generated walks (§7.1: a walk never overwrites a chord). A blocked note appears in `walkSteps` with `to === from` (what sounds), not its stored pitch.
- `walkSteps`: generated = each step taken (`fixed: false`); frozen = every applied note incl. holds and blocked. Emitted in event order (already sorted by t; ties walk order then low→high). Incremental: checkpointed by length like `harmony`.
- `freezeWalk(score, momentId)` in `core/moments/walk.ts`: snapshot for `fixed`. Freezing every walk of every example reproduces its voices exactly (test).
- Golden hashes regenerated: only `walkSteps` was added (verified: hashes without it match the old goldens).
- Tests: `tests/unit/core/walk-frozen.test.ts` (13).
## M4.5-5 Inspector chord picker (builder, 2026-11-20)
- **Core:** new `src/core/chord-spec.ts`: `CHORD_QUALITIES` (the 13 of §11.3), `chordSymbol` (root, quality, bass → ASCII symbol, spelled in the key), `readChord` (symbol → choices; bass read from the text after '/'), `romanNumeral` (scale degree with accidental against major: ♭III in minor, vii°, iiø7), `diatonicChords` (stacked-third triads of 7-note scales; empty otherwise). The parser already accepted `C/C` (bass = root, pcs unchanged); round-trip tested over every root, quality, bass and four keys.
- **UI:** `inspector/ChordPicker.tsx` above the symbol field: header (name, numeral, live notes), From the key, Root, Quality, Bass, Voicing chips. Each pick is one `updateMoment` (labels "Pick chord", "Change chord root/quality/bass", "Change voicing"). `NoteSetField` puts the kind selector, degrees and pitches under a `<details>` "Other notes", open unless the notes are a chord. The Voicing select moved from `TypeFields` into the picker.
- **Live notes** (`fields.ts liveNotes`): each voice's destination from the moment's segments, else the segment sounding at the moment's span end. A voice already on its target gets a hold segment without `momentId`, so the moment's own segments alone under-report.
- **Choices:** picks write letter symbols ("Dm7/F"), not Roman numerals, so a Roman symbol becomes a letter one on the first pick. The symbol text field stays for anything the chips can't express (C13, V7/V); such a chord shows no quality chip pressed, and Bass shows none pressed for a non-chord-tone bass.
- **Tests:** `tests/unit/core/chord-spec.test.ts`, `liveNotes` in `inspector-fields.test.ts`, e2e `inspector.spec.ts` "chord picker…". The existing drag-label e2e now scrolls the Length label into view (the inspector got taller).
- Cloud e2e: Playwright 1.65 wants chromium 1255 but only 1243 is installed and the download is blocked; ran with `PLAYWRIGHT_BROWSERS_PATH` pointing at symlinks named 1255 → 1243.
## M4.5-2: camera, follow, zoom, dimmed future (2026-11-20)
- **Camera API (`src/render/camera.ts`).** `CameraState = { start, window, pitchRange? }`. One map for every row: `timeToX(axis, t) = (t − start)·pps`, `xToTime`, with `pps = width / window`, no horizontal padding. `axisOf(cam, width)` gives an `Axis` without a score; a `View` (from `cameraAt`) is also an `Axis`. Follow: `followStart(mode, start, t, window, duration)` (Smooth 35 %, Page 92 % → 8 %, Off; always `clampStart` to [0, duration − window]). Zoom: `zoomAnchor(start, window, t)` (playhead if visible, else centre) and `zoomAround(cam, next, anchor, duration)`.
- **Removed:** the overview blend and its tween (`easeOverview`, `windowBlend`, `BLEND_START`, `OVERVIEW_TWEEN_MS`, `smootherstep`, `DEFAULT_PLAYHEAD_X`), `CameraState.overview/pan/playheadX`, `View.tc/xAnchor/blend`. Lane and palette-drop use `view.start`.
- **App.** `view.follow` in the store (from `piece.view.follow`, default Smooth). The left-edge time is transient (`camera.start` in store.ts, like the clock), since Smooth writes it every frame. The loop applies `followStart` while playing or when the playhead moved (a seek), so a paused pan stays put. `setWindow`/`zoomBy`/`fitWindow` keep the playhead's x; `panBy` works during playback and turns Follow off. A new piece opens at start 0 with its own window (no overview at idle).
- **Ghost:** future lines at `futureOpacity ?? 0.35` once played; full opacity before the first play (idle). Heads no longer fade.
- **Core (extended):** `FollowMode`, `ViewSettings.follow?`; `playheadX` is kept but unused; `futureOpacity` default documented as 0.35. `docs/file-format.md` regenerated.
- **ViewBar:** Zoom − [log slider] + · window · Fit; Follow [Smooth|Page|Off]. `frameStats` exposes `start`, `window`, `head`, `ghost` (replacing `overview`).
- **Tests:** `tests/unit/render/camera.test.ts` (follow ±1 %, Page jumps, Off, clamping, Fit, zoom anchor); `tests/e2e/view-follow.spec.ts`; app.spec updated (no overview).
- **Perf trap:** drawing the whole window (past + dimmed future) costs ~1.3× the old past-only frame. On the cloud box (software raster) `render.spec`'s strict 4 ms `ink-24-flush` reads 4.7–4.8 ms (baseline before this change: 3.3–4.0 ms there); draw-only stays 1.1–1.4 ms. Check on the Mac; if over, cache line tiles per scale offscreen (§10 Budget) and blit past/future with globalAlpha.

## M4.5-6 Inspector controls (builder, 2026-11-20)
- **Controls** (`controls.tsx`): `NumberField` takes `slider: {min, max}` (range before the text box; the slider range may be narrower than the typed one). `Chips` = `aria-pressed` buttons in a labelled fieldset. Label scrubbing is ignored when the input is disabled (`<fieldset disabled>`).
- **Undo:** the existing gesture plumbing already made a slider drag one entry (pointer down → begin, change → `updateGesture`, up/keyup/blur → end); no history change needed. Added `onPointerCancel` → end.
- **Transition** (was "Glide"): Length, Stagger sliders + typed boxes; Jitter slider; Order and Curve chips (Smooth = smootherstep, Linear, Cosine, Expo, Custom = bezier with x1…y2 fields); preview kept. A Smoothstep chip shows only while it is the curve (no chip in §11.3).
- **Level:** Level slider; Ramp (`over`) slider + box.
- **Walk:** Region (= `until − at`, writes `until`), Grid, Step glide, Density (%, writes 0..1) as sliders + boxes; allowed-step chips −3…+3 (stored steps outside that range get chips too; the last step can't be removed); bass leap min/max sliders. With `fixed`: "Frozen" badge, Unfreeze (deletes `fixed`, "Unfreeze walk"), and density, steps, bass and Reroll are disabled with "Unfreeze to change". **Choice:** Region, Grid and Step glide stay enabled when frozen, since a frozen walk still uses them (§6.2 ignores only density, steps, bass, seed).
- **Voices:** chips All / Top n / Bottom n / Pick… Bottom n = `rank [0, n−1]`; Top n = `rank [k−n, pool−1]`, k = voices sounding at the moment's time (the core clamps the high end). So Top n's low rank is fixed when written: if the active count at that time changes later, the selection shifts. A rank pair that is neither shows the old lowest/highest fields. Exact "top n" would need a schema change (owner).
- **Tests:** `tests/unit/app/inspector-controls.test.ts` (step chips, target modes); e2e `inspector.spec.ts`: walk density/steps change `walkSteps` and undo, slider drag = one undo entry, frozen walk badge/lock/Unfreeze/undo, voices/transition/level.

## Owner notes on the M4.5 demo (2026-11-20; for the real editor, not yet planned)
- Voices that start moving together should arrive together (today stagger 0.8 s + jitter 0.2 make arrivals differ).
- Chord/split: choose how many voices sound, and edit voices individually.
- Moments that do nothing in context (merge on already-stacked voices) are confusing; owner asked for options (grey-out, context-driven "flow chart" of next moves). Options sent; awaiting the owner's pick.
- **Owner picked (2026-11-20):** 1A arrive together (default on), 2A chord `count` + 2B per-voice chord editing (freezes the chord), 3A dimmed no-op moments + 3B context palette with hover preview; next-move suggestions after. PLAN rev 6; all in M4.5. Note: arrive-together as the default changes how every existing piece sounds (golden hashes will change).
## M4.5-7 Walk step editing (builder, 2026-11-20)
- **Helpers** (`editor/walk-steps.ts`, pure): a step is `(momentId, tick, voice)`, stable across freezing. `scaleNeighbour(p, dir, key)` = nearest scale tone strictly above/below (an off-scale pitch goes to the nearest tone that way, not snap-then-step). `movedFixed(walk, score, ref, dir)`: base = `fixed ?? freezeWalk(score)`, moves the stored note (absent → inserted from the step's `to`) in `keyAt(at + tick·grid)`; null outside MIDI 0..127.
- **Action** `moveWalkStep(ref, dir)` (`actions.ts`): one `updateMoment` of `fixed`, so freeze + move is one undo entry ("Freeze walk and move step"; later "Move walk step").
- **Selection:** `editor/step-selection.ts` (`useStepSelection`); cleared when the moment selection stops being that walk.
- **Inspector** (`inspector/WalkSteps.tsx`, after the generator fieldset): Steps fieldset, rows time (m:ss.ss), voice name, note (spelled in the key; a frozen note shows its stored pitch, ⊘ if blocked), ▲/▼. List capped at 220 px with scroll (not virtualised; ~2 buttons per step).
- **Score dots** (`ui/WalkStepDots.tsx` in ScoreView, `walk-dots.css`): DOM buttons, positioned per frame via `onScoreFrame`, at each step's arrival (`t + stepGlide`, `to`). **Deviation:** a DOM overlay rather than a canvas layer in `draw.ts` (§10 item 7), to keep out of draw.ts and get hit-testing free. Dots aren't tab stops (the list is the keyboard path).
- **Tests:** `tests/unit/app/walk-steps.test.ts`; e2e `tests/e2e/walk-steps.spec.ts` (▲ freezes and moves one note, others unchanged in `walkSteps`; one undo unfreezes; save file → open keeps `fixed`; dot↔row selection). Featured walk: voice range tops at 84, so ▲ on its highest note is blocked; the test picks a top-voice note ≤ 79.
- Unit suite: one unrelated test failed once on the cloud box and passed on two reruns (timing).
## M4.5-3 Ruler and single playhead (builder, 2026-11-20)
- **Layout.** `App.tsx` wraps the score in `.timeline` (`position: relative`, flex column): editor layout = `Ruler` · `ScoreView` · `Lane` · `Playhead`; player layout = `ScoreView` only, plus the `Scrubber` below (editor has none). Workspace grid rows: `score`/`view` (full), `score`/`scrub`/`view` (player); the `lane` grid area is gone (`.timeline .slot.lane` gets a 10 px top margin).
- **Ruler** (`ui/Ruler.tsx`, maths in `app/ruler.ts`): DOM ticks (pooled spans, `data-t`) placed from `onScoreFrame`'s `View` (`(t − start)·pps`); spacing ≥ 64 px from 0.1 s to 20 min steps; labels `m:ss` (`m:ss.s` under 1 s steps). `gridBpm` adds a beat strip (CSS gradient, hidden under 4 px/beat). Its 1 px side borders match the stage's, so its content box is the canvas's x range. Pointer down/drag/up = `scrubTo`/`scrubEnd` (silent drag, resumes if it was playing). `role="slider"`, focusable; arrows seek via the global keys.
- **View hold:** `camera.hold`/`camera.release` (store.ts). While the ruler is pressed the loop doesn't follow, and it clears the hold one frame after release, so a ruler seek never scrolls the view (a seek by keys or the player scrubber still follows, as before).
- **Playhead** (`ui/Playhead.tsx`): a 1 px absolutely placed div spanning its parent (`.timeline`) top to bottom, `translateX(canvasLeft + xHead)` each frame via `onScoreFrame`; `canvasLeft` re-measured by ResizeObserver. Registers `live.playhead`; while set, the loop passes `ScoreStyle.playhead: false` and `drawScore` skips its line (new optional field, default true; player layout unchanged).
- **For the lane-rows builder:** put every row inside `.timeline` (it's the playhead's container) and keep the rows' x range equal to the canvas's (same 1 px side borders, no extra left gutter unless the stage and ruler get the same one). The playhead needs nothing else.
- **Tests:** unit `tests/unit/app/ruler.test.ts`; e2e `tests/e2e/ruler.spec.ts` (scrubber only in the player; ruler click/drag seeks and the view holds; playhead spans ruler→lane; ticks and playhead within 1 px of the canvas axis at 4 zooms while following). `window.__algorhythms.actions.seek` + `seek(page, t)` in `app-hook.ts` replace the old `scrubber.fill` in app/app-perf/view-follow specs.
- **Known:** `app-perf.spec` (60 fps) is flaky on this box only under 2 parallel workers; base commit fails 1 in 4 the same way; passes 3/3 serial.
## M4.5-4 Lane rows on the shared time axis (builder, 2026-11-20)
- **Rows** (`Lane.tsx`, `lane.css`): one track, three rows on the score's axis: Moments (marker + name, 2 staggered rows), Transitions (each moment's span bar, 2 packed rows, labelled with its length; walks striped; key moments none), Level (SVG polyline + fill). Effects not rendered (M6). One `[data-moment]` item still holds marker and bar, so select/drag/keys/end-handle behaviour is unchanged.
- **Names** (`momentText`): label, else chord name from `compiled.harmony`, `level 55%`, key name, type.
- **Level** (`levelCurve`): mean of the compiled `level` timelines over voices alive at t (fades and static gain ignored; 0 where none sound); exact polyline with doubled points at steps. Scaled to max(1.2, peak).
- **Axis:** item x = `at·pps`, inner container `translateX(axisLeft − start·pps)` per frame. `axisLeft` = measured canvas-left minus track-left (ResizeObserver), 0 in today's layout; keeps alignment if the score gains a gutter. **Fixed:** bars sat 5 px left of their start (inline `left` overrode the 5 px CSS offset).
- **Pan:** background press + drag → `panBy` (Follow off during playback); a click without drag clears the selection on release (was on press).
- **Choice/deviation:** row names sit in an overlay gutter inside the track (left edge), not a separate column, so the lane's x stays the canvas's x and palette drops keep working. If the ruler work adds a real gutter column, move them there.
- **Tests:** unit `lane.test.ts` (packBars, momentText, levelCurve incl. interrupted ramps); e2e `lane-rows.spec.ts` (marker, bar start and glide start within 1 px at 3/6/12/25 s windows while following; level curve dips for a level moment and flattens when it is deleted; background drag pans, and turns Follow off while playing). Existing lane/editor specs pass (chromium dev + prod).

## M4.5-9: arrive together + `no-effect` (core, 2026-11-20)
- **`glide.arrive`** (`GlideArrive`, types.ts; schema: full glide defaults to `'together'`, partial optional; `DEFAULT_GLIDE.arrive = 'together'`; `sanitizeGlide` maps anything else to `'together'`). Under `'together'` the planner sets every duration to `sharedEnd − start` (`sharedEnd` = at + stagger + jittered length, one moment-level draw: voice id `''`, `Purpose.Jitter`), never below `MIN_GLIDE`. Starts are drawn as before. Durations derive from starts, so crossing adoption and pull-back keep the common end. Births end there too.
- **Choice:** a single-voice moment (e.g. a pin) also ends at at + stagger + length, so it glides `stagger` longer than before (§7.2 formula taken literally).
- **Goldens regenerated** (tests/golden/examples.golden.json): the default changes how every piece sounds, and examples now carry 4 `no-effect` infos (2 redundant chords, a pin, a final merge on a unison). Check: with `arrive: 'spread'` forced and `no-effect` filtered, all 5 examples hash to the pre-revision-6 values (arrive.test.ts).
- **`no-effect`** (info, diagnostics.ts). The compiler compares committed destinations before a point moment (before its cancellations) with those after. Rules (`src/core/effect.ts`): no surviving voice's target changes; a death only counts if it changes pitch or leaves its pitch unsounded; a birth only counts if it isn't on its parent's pitch (unison voices sound as one, §8.4). Also: key equal to the current one (tonic pc + scale pcs), level equal to every target's current gain. Not raised when the moment raised an error; walks are never flagged. Messages: `No effect: <reason>.`, e.g. "all voices already on one pitch", "every pool voice is already sounding", "shift by 0".
- **Palette helper:** `momentEffectsAt(piece, score, t, make)` → per type `{ effect, reason? }`; `momentEffectAt(piece, score, moment)`. `make` builds the default moment (pass the editor's `defaultMoment`), so the defaults live in one place. It reads the state at t from the score (sounding voices excluding merge-dying ones; each voice's destination = the segment at t (cut target if interrupted) plus later moves of point moments at ≤ t; levels; key) and runs the moment function (`moments/dispatch.ts`, now shared with compile.ts). No recompile. It ignores the cancellation of pending moves, so it can differ from the compiler inside a stagger window. A test checks it against compiling at settled times.
- **Tests:** `tests/unit/core/arrive.test.ts`, `tests/unit/core/no-effect.test.ts`. `generate-length`'s byte-identity snapshot now strips the new `arrive` default before hashing; `defaults.test` updated. `docs/file-format.md` regenerated.
- **Perf:** compile benchmark median ~20 ms vs ~19 ms at base on this box (noise level).

## M4.5-12: context-aware moments (app, 2026-11-20)
- **Lane:** a moment with a `no-effect` diagnostic gets `data-no-effect` (marker, label and bar at 40% opacity), the message as `title`, ", no effect" in its aria-label. The inspector already listed info diagnostics; each row now carries `data-code`.
- **Palette** (`editor/palette-effects.ts`): `usePaletteEffects` holds `momentEffectsAt` at the grid-snapped playhead (the time a click adds at). A 200 ms poll recomputes when that time or `compiled` changed; while playing, at most once a second at idle. One call costs ~0.3 ms (featured example). A no-effect type: `aria-disabled` + `data-no-effect`, greyed and dashed, tooltip "No effect here: <reason> (drag to another time)". Click and the letter shortcut re-check fresh (`playheadEffect`) and do nothing; drag/drop is unchanged (a no-op drop is added and shows dimmed).
- **Hover preview** (`preview.ts`): 300 ms hover on an enabled item compiles the piece plus the default moment (plain `compile`, not the incremental one), hot-swaps it in, `engine.play(t)` for 3 s, then `engine.pause()` (the engine's 5 ms crossfade) and swaps the real score back while paused: no click. Store, undo history and saved piece untouched. Choices: only when the transport is not playing (no preview over playback) and audio is `ready`; any piece/compiled/transport/scrub change stops it first (its restore swap is queued before play's `whenReady`, so play never starts on the preview). The picture does not move during a preview. Debug hook: `__algorhythms.preview` (`type`, `playing`, `count`, `from`).
- **Tests:** e2e `context-moments.spec.ts` (dimmed marker + tooltip + inspector; merge greyed on a unison and enabled before it, click/`M` blocked; hover preview starts, stops on leave, piece and undo unchanged, disabled item does not preview). `palette.spec` "letters add each type" now deletes each added moment (a spread after a unison is a no-op and is now refused). Unit: shortcuts (merge on a unison), canvas-input (blocked letter).
