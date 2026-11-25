# M12 acceptance audit (2026-11-24, base ad01cdc)

Scope: PLAN §15 "M12. Compose for me, directed": the Acceptance line, its listening-notes additions (round 1, round 2) and Speed; build-log entries M12 D1, D2, rev 18, D3, D3 round 2, Speed, D4.

**Changed in this audit (D4):** Generate composes with `composeDirected({ seed })`, every answer on Surprise me (build log "M12 D4").

**Runs on this tree** (macOS, 6 cores, shared; `--maxWorkers=2`, Playwright `--workers=1`):
- `pnpm lint`, `pnpm typecheck` clean; `pnpm test`: 3153 passed, 8 skipped.
- e2e `generate`, `naming`, `address`, `export`, `compose` on chromium-dev and firefox-dev: 69 passed, 1 skipped (the Chromium-only save-picker test on Firefox).

Status key: **C** checked in CI (unit/dsp tests run by `pnpm test`, e2e by the sharded CI run); **P** passed locally on this tree; **Owner** the owner's check.

## Gaps (read first)

None open. Two notes:
1. **Note count** is measured as the most lines sounding at once (= the piece's voice count here). All-Surprise spreads wider than today's Generate (σ 2.0 vs 0) but never writes more than 12 lines; a Generate panel with Notes set to 20–32 used to. Generate no longer offers that input (integrator call); the editor still allows 32.
2. Variety is measured against Generate's *default* inputs (dorian, 2:30, 12 notes, density 0.45), which is what Generate gave without touching the panel. Against its inputs drawn over their whole ranges, the D1 numbers (build log) still favour the directed composer on everything but note count.

## §15 M12 Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| Mood → mode, tempo and sound ranges | C+P | unit `core/compose-directed.test` "a mood narrows mode, tempo, density and sounds to its region", "a mood sets the piece: its key, tempo and timbres" (and Calm sparser than Driving); e2e `compose.spec` "the answers shape the piece: two moods differ in mode and tempo; Parts gives only those" |
| Length ±5 % | C+P | `compose-directed.test` "the length lands within ±5 %" (all four lengths × 6 seeds); `compose-speed.test` "keeps the length and the form … at every length and speed" |
| Shape → the energy curve | C+P | `compose-directed.test` "the shape is the energy curve, measured on levels and onsets" (Build/Arc/Journey correlation > 0.4 each, mean > 0.75; Steady flat) |
| Parts → only those rows | C+P | `compose-directed.test` "parts: only those rows, and each of them plays" (all 31 subsets); e2e `compose.spec` (Chords + Bass gives only those) |
| A progression → those chords in order | C+P | `compose-directed.test` "a progression: those chords, in order, in every section; then home" |
| A melody → kept and harmonised | C+P | `compose-directed.test` "a given melody is kept, note for note, and harmonised" (Ode to Joy, ≥ 60 % on chord tones); e2e `compose.spec` "the open piece's melody is offered when it has one, and goes into the brief" |
| Chords fit the key, the melody fits the chords, the bass sits on chord roots at changes | C+P | `compose-directed.test` "harmony: chords fit the key, the melody fits the chords, the bass is on the roots" (30 seeds; ≥ 97 % of strong-beat melody notes on chord tones) |
| Same brief + seed → identical piece | C+P | `compose-directed.test` "is deterministic: the same brief gives the same piece"; e2e `generate.spec` (same seed twice → identical piece) |
| Variety: over 50 seeds all-Surprise spreads at least as widely as today's Generate on mode, tempo, density, note count and pitch range | C+P | `compose-directed.test` "over 50 seeds, all-Surprise spreads at least as widely as Generate". Seeds 1–50, today's numbers (all-Surprise vs `generate(seed, { mode: 'dorian', length: 150 })`): **modes** 11 vs 1; **keys** 36 vs 1; **tempo** 88 ± 25.7 bpm, 55–138, vs 60 ± 0 (Generate has no tempo; its grid is 60); **density** (onsets/s) 6.2 ± 3.6, CV 0.58, vs 1.23 ± 0.08, CV 0.06; **note count** (most lines at once) 7.5 ± 2.0, 4–12, vs 12 ± 0; **pitch range** 53.5 ± 11.2 vs 45.9 ± 0.3 semitones |
| Same answers, different seeds share no 4-bar span | C+P | `compose-directed.test` "the same answers with different seeds share no 4-bar span" (3 briefs × 3 seeds) |
| The build show places moments in play order | C+P | `compose-directed.test` "places the structure in play order, then one left-to-right detail sweep (maybe empty)"; unit `app/compose.test` "applies steps in order; the pen only moves forward…"; e2e `compose.spec` "Compose for me places moments over time, then shows the full piece" |
| Generate = all Surprise | P (new in D4; C once pushed) | unit `app/generate-options.test` "is the directed composer with every answer on Surprise me" (`= composeDirectedPiece({ seed })`, a composed title, not `generate()`'s piece), "gives a brief with only the seed"; e2e `generate.spec` "Generate = Compose for me on all Surprise me: one load, the same seed reproduces it" (old inputs absent; the piece = `composeDirectedPiece({ seed: 4242 })`; no build panel, nothing to undo) |
| The owner's listening check | Owner: passed | "I like the generated songs" (owner, 2026-11-24, after round 2) |

## Listening notes, round 1

| Criterion | Status | Evidence |
|---|---|---|
| At every section boundary the lines' changes spread over at least a bar | C+P | unit `core/compose-transitions.test` "at every boundary the lines change pattern over at least a bar, part by part or line by line" (19 briefs), "the owner's example: no line switches figure on A to B's downbeat…", "the harmony leads into each new section" |
| A lone part never plays the same 4 bars (chords and top line) more than twice in a row | C+P | `compose-transitions.test` "never plays the same 4 bars … more than twice in a row" (Chords, Pulse, Bells, Bass alone; no-tune sets; a named progression), "the progression develops: a lone part plays more distinct chord bars than a backing loop" |
| Unticking Watch the composer opens the finished piece at once | C+P | unit `app/compose.test` "Watch the composer unticked: Compose opens the finished piece at once"; e2e `compose.spec` "Watch the composer unticked opens the full piece; one undo empties back to before" |
| (Detail is optional) | C+P | `compose-directed.test` "places the structure in play order, then one … detail sweep (maybe empty)"; `app/compose.test` "a composition with no detail steps finishes straight after the structure" |

## Listening notes, round 2

| Criterion | Status | Evidence |
|---|---|---|
| Over 50 seeds per mood, no Dark, Calm or Dreamy piece uses pluck, marimba or epiano for chords or pulse, or any figure faster than eighths | C+P | unit `core/compose-mood.test` "Dark, Calm and Dreamy: no bouncy chords or pulse, nothing faster than eighths" |
| Dark tempos ≤ 80 bpm | C+P | `compose-mood.test` "Dark tempos stay at or below 80 bpm, and its register sits lower"; Surprise coherence: "a Surprise piece is coherent: its title mood matches its sounds, pace and mode" |
| Arpeggio textures fill at most a third of any piece | C+P | `compose-mood.test` "fill at most a third of any piece, in every mood and Surprise"; glides through a change rare: "a slow glide through a chord change … is a rare feature" |
| No piece uses Wobble | C+P | `compose-mood.test` "no piece uses Wobble; at most one flute line" |
| (Quieter flute) | C+P | unit `dsp/flute-noise.test` "sits well under the tone in every register, but is still there" (−32…−24 dB at C4, C5, C6) |

## Speed

| Criterion | Status | Evidence |
|---|---|---|
| Over 50 seeds per mood, mean chord, transition and section lengths order Slow > Medium > Fast, the round-2 rules still holding | C+P | unit `core/compose-speed.test` "orders chord, transition and section lengths Slow > Medium > Fast in every mood; the mood rules hold" (50 seeds × 5 moods × 3 speeds); "is not the tempo…", "Surprise draws it from the mood…"; e2e `compose.spec` "Speed: Fast composes a Fast piece, and Compose again keeps it" |
