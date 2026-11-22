# M6 acceptance audit (2026-11-22, base `main` 7781272)

Scope: PLAN §15 M6 (FM with its own modulator phase, noise, stretch/additive path, harmonic editor, per-voice timbre, the `timbre` moment, preset save and load, bell and more presets), plus §8.5 timbre model, §8.6 master FX and §11.3 Sound drawer.

**New tests (this audit):**
- `tests/dsp/preset-switch.test.ts`: preset changes during playback through the live host's sequence; preset save → load → bit-identical render.
- `tests/dsp/fx.test.ts`: §8.6 behaviour of each effect on its own. Before this, only the effects' clicks, ceiling and stems sum were tested.

**Runs on this tree (`--maxWorkers=2`, `--workers=1`):**
- lint and typecheck are clean.
- `pnpm test`: 1949 passed, 1 skipped (160 files).
- E2E, chromium-dev: `timbre-editor`, `timbre-moment`, `voices`, `sound-fx` passed 9/9.
- Firefox, WebKit and chromium-prod were not run here.

Status key: **C+P** covered and passing; **Part** partly covered; **None** not covered; **Owner** needs the owner's ears.

## Gaps and findings (read first)

1. **The reverb's broadband RT60 runs 10–13 % short of its setting** (finding, not fixed). With damping 0, the tail below 200 Hz matches within 2.5 %: set 1 s gives 1.024 s, set 3 s gives 3.019 s. The broadband tail is short: 0.895 s and 2.632 s, and 0.877 s at size 0. The cause is that each line's fractional read is linearly interpolated, which is a slight low-pass on every pass, so the high end decays early even at "no damping". `fx.test.ts` pins this behaviour (broadband between 0.85× and 1.05×). Possible fixes: integer line lengths, or allpass interpolation. The decision is the owner's or integrator's, because it changes every render golden that uses reverb.
2. **The built-in bell is not "stretch + FM"** (§8.5). The owner chose the church-bell redesign (v39): a harmonic tone with struck inharmonic partials, no stretch, no FM. The M6-a stretch + FM 1.41 bell is kept as `M6A_BELL` (fixtures) and is in every test below. No built-in preset has a non-integer FM ratio (epiano and brass are 1:1), so the non-integer FM acceptance uses piece timbres.
3. **Timbre slot recycling (seen in code, not tested, needs > 64 timbre names in one session).** Once more than `MAX_TIMBRE_SLOTS` (64) distinct names have been installed, `Graph.recycleSlot` frees an unused slot. But `AudioEngine.sent` still records that name's tables as sent. If a note later returns to that name, no tables are posted, and the voice keeps its previous timbre (the missing-table fallback). This is unlikely in practice: it takes 64 or more renames, duplicates or loads in one session.
4. **RTF under the M6 workload** fails the ≥ 10× gate on the cloud box: 5.5–6.8× measured, against 16.2× on a quiet Mac. This is known; see the build log ("Smooth master FX edits"). It was not re-measured here, because timing gates miss under load.
5. **The sound of the presets and timbre moments is Owner.** They were judged numerically: levels against older presets, roughness, stray power.

## §15 M6 acceptance lines

| Criterion | Status | Evidence |
|---|---|---|
| Preset changes during playback cause no clicks: Voices drawer (every note to another timbre) | C+P | `preset-switch.test.ts` "preset change during playback (voices)": all 210 ordered pairs of the 12 built-ins plus `fm141` (FM 1.41), `fm276` (FM 2.76) and `m6a` (stretch + FM 1.41 + noise). The piece is compiled, edited with `setAllTimbres`, and goes through tables-then-`swap` as in `AudioEngine.swap`. The swap lands mid-glide. The limit is 2× the cleaner render of the two timbres. Worst: 51 % of the limit (reed → choir, 0.547 / 1.073) |
| …Sound drawer (redefining the timbre in use: an edit, Revert, a preset loaded over it) | C+P | "preset change during playback (edit)": the same 210 pairs as a same-name table replacement, worst 48 % of the limit. "Sound drawer edits while a note sounds": FM ratio dragged 1 → 2.76 with one table set per frame; pluck articulation 0.9 ↔ 0.1 at 10 ms after a strike; glass ↔ FM 2.76 flipped every 12 ms (a reinstall inside the 20 ms crossfade). All pass at A2, C4 and E5. `m6.test.ts` "replacing tables mid-note (plain → FM → M6-a bell → bell → plain)…" |
| …`timbre` moment | C+P | "preset change during playback (moment)": a fade-0 moment dropped 50 ms behind the playhead and hot-swapped in, 210 pairs, worst 52 % of the limit (brass → marimba). `timbre-moment.test.ts` "switches across every synthesis path, overlapping and instant…", "a hot swap mid-fade…", "a missing table keeps the timbre before it…"; `clicks.test.ts` "click detector, timbre changes" (seek, pause, loop wrap mid-fade) |
| …the detector catches a hard switch (positive control) | C+P | `preset-switch.test.ts` "a hard switch (A's render spliced onto B's) fails the same limit": median 128 % of the limit over 42 FM, bell and glass pairs |
| …the new timbre really sounds after a switch | C+P | `preset-switch.test.ts` "after a Voices-drawer switch the notes sound the new timbre": level within 0.5 dB of a render made in it |
| Preset files round-trip | C+P | `unit/core/timbre-preset.test.ts` "round-trip every built-in exactly, text and all"; `property/core/timbre-preset.property.test.ts` "any valid timbre comes back deep-equal, and saves to the same text"; `preset-switch.test.ts` "save → load → bit-identical render (and piece file too)" for every built-in and a timbre with every optional field (FM 2.76 with `held`, strike partials, formants, drift, jitter); `timbre-editor.spec` "…save and load a preset" (file = the piece's timbre; loaded into all notes exactly; undo; piece file refused) |
| Click detector passes on FM fixtures with non-integer ratios | C+P | `m6.test.ts` "a non-integer ratio is click-free: like ideal FM, unlike a wrapped-phase modulator" (r = 1.37, β = 3: engine 0.212 = ideal 0.212, wrapped 1.117), "seeks, loops and glides with a non-integer ratio stay click-free"; the 1.41 and 2.76 pairs above |

## M6 scope items

| Item | PLAN | Status | Evidence |
|---|---|---|---|
| FM with its own modulator phase | §8.5, §15 | C+P | `m6.test.ts` "puts sidebands at \|fc ± k·fm\| with Bessel amplitudes" (k = −3..3 within 0.01 dB), "indexTrack lowers β…", "FM: the index cap keeps folded sidebands under −40 dB"; `bell.test.ts` "the FM index rings down to its held share" |
| Noise | §8.5 | C+P | `m6.test.ts` "breath noise": level × tone RMS, band-pass, seeded and uncorrelated per voice |
| Stretch / additive path (≤ 16 partials, own phases, skipped above Nyquist) | §8.5 | C+P | `m6.test.ts` "renders partials at fc·n^(1+stretch)…" (within 2e-5), "has the RMS of the same timbre on the wavetable path", "the M6-a bell and a 16-partial stretch: partials past Nyquist are skipped" |
| Harmonic editor (Sound drawer) | §11.3 | C+P | `unit/app/timbre-edit.test.ts` (partials 1..32, FM/noise on and off, strike, every slider inside the schema bounds, a drag is one undo entry coalesced per frame, keyboard steps); `timbre-editor.spec` "edit a timbre with a slider, undo it…" |
| Sound drawer controls: harmonic sliders, FM, noise, accent, articulation, vibrato | §11.3 | C+P | `TIMBRE_CONTROLS` (Shape incl. accent, FM, Noise, Articulation, Vibrato) with range tests in `timbre-edit.test.ts`. E2E drives partials and FM; the other sections only at unit level |
| …plus master FX | §11.3, §8.6 | C+P | `unit/app/mix-edit.test.ts` (ranges, curves, Reset per section, delay snapping, per-note sends, drag = one entry, every update reaches the engine); `sound-fx.spec` (reverb decay drag + undo, Reset, delay in beats, strike partials); `clicks.test.ts` "click detector, mix changes" |
| Per-voice timbre | §11.3 Voices drawer | C+P | `voices.spec` "voices drawer edits the pool, mute and timbre…", "All notes timbre sets every note at once…"; `unit/app/voices-all-timbre.test.ts`; the `voices` pairs above |
| The `timbre` moment | §6.2, §7.9 | C+P | `unit/core/timbre-moment.test.ts` (21 tests: targets incl. silent voices, unknown preset, no-effect, incremental = full, flat round trip); `unit/app/timbre-moment-ui.test.ts`; `dsp/timbre-moment.test.ts` (gain law, mix continuity, seek and birth mid-fade, unison lock); `timbre-moment.spec` (palette, inspector, Effects row, end drag, undo, rename and delete); `stems.test.ts` "holds through timbre moments" |
| Preset save and load | §11.3, §15 | C+P | See "Preset files round-trip" above; `timbre-edit.test.ts` load targets (users, all, one voice, none) and name clashes |
| Bell and more presets | §8.5 | C+P (gap 2) | `bell.test.ts` (struck partials, seek mid-ring, Nyquist, candidates table); `m6c-presets.test.ts` (epiano, flute, marimba, brass: ±3 dB of older presets, click-free, stray power ≤ −50 dB); `clicks.test.ts` transport suite for bell, epiano, flute and marimba |

## §8.5 timbre model

| Point | Status | Evidence |
|---|---|---|
| `Timbre` fields, schema bounds | C+P | `m6.test.ts` "the schema bounds stretch, fm and noise"; `timbre-preset.test.ts` "enforce the schema bounds"; property arbitraries cover every field |
| Wavetables from harmonics 1..32, no aliasing | C+P | `graph.test.ts` "holds no partial that could alias at %i Hz", "normalises every preset to the RMS of a unit sine at middle C" |
| Inharmonic timbres use the additive path | C+P | `m6.test.ts` "only bell and the M6-c presets use an M6 path…", stretch tests |
| Budget (24 voices × 16 partials affordable) | Part (gap 4) | `rtf.test.ts` M6 workload; passes on a quiet Mac, fails on the loaded cloud box. no-GC `m6`/`timbre` modes: 0 scavenges |
| Determinism (seeded noise) | C+P | `m6.test.ts` "is seeded: identical renders…"; render goldens `preset-bell`, `timbre-moments` |

## §8.6 master FX

| Point | Status | Evidence |
|---|---|---|
| Send topology; stems sum exactly | C+P | `stems.test.ts` "Σ voice stems + FX stem = mix within −90 dBFS…" (also with M6 timbres and timbre moments) |
| Reverb: FDN, 8 lines, Householder, damping, size, decay, pre-delay, return; deterministic | C+P (gap 1) | `fx.test.ts` "decays at its RT60 setting" (< 200 Hz within 5 %; broadband 0.895 / 2.632 s for 1 / 3 s), "damping shortens the high end only; pre-delay delays the onset; renders are identical" (pre-delay 0.1 s within 1 frame, L/R correlation < 0.3) |
| Delay: stereo ping-pong, in seconds, own send | C+P | `fx.test.ts` "echoes left at T, right at 2T, left at 3T (× feedback…)" |
| Tone: tilt EQ plus low-pass, linear | C+P | `fx.test.ts` "low-pass: −3 dB at the cutoff, 2nd order above; flat when bypassed", "tilt: about tilt dB per octave around 1 kHz" (−3: +5.97 / 0 / −5.93 dB at 250 / 1k / 4k); linearity via the stems sum |
| Limiter: 5 ms look-ahead, −1 dBFS ceiling, the only nonlinear stage | C+P | `fx.test.ts` "looks ahead 5 ms…"; `graph.test.ts` "holds the −1 dBFS ceiling…", "honours a custom ceiling"; `stems.test.ts` gain replay |
| FX edits during playback click-free | C+P | `clicks.test.ts` "click detector, mix changes" (every field jumped and dragged) |

## Owner steps

1. Play Kite Day. Open the Notes drawer and change All notes timbre several times while it plays (glass → bell → epiano → brass). Expect no clicks; the sound changes within about 20 ms.
2. Open the Sound drawer, pick the timbre in use, and drag FM ratio and partials while it plays. Expect a smooth change.
3. Save the timbre (Save preset), load it into another piece with Load preset, into "all notes", and check that it sounds the same.
