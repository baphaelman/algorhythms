# M10 acceptance audit (2026-11-23, base `main` 47656bf, M10b live at 8bb5e87)

Scope: PLAN §15 "M10. Editor overhaul", its five *Accept when* lines, §6.4 "Rows and blocks" and §11.3 "Theory-aware Next" (revision 14); build-log entries M10a-1…3, M10b-1…5 and the fixes after them. Blocks are stored as today's moments, so no file format changes.

**New test (this audit):** `tests/unit/core/next-acceptance.test.ts` (12 tests). It runs Next on every composition at four times, and on every built-in scale after a chord change. It checks two things: no card fails `momentEffectAt` or compiles to `no-effect`, and no two cards share a job. It found one no-op (gap 1), since fixed; the test now expects none.

**Runs on this tree** (macOS, 6 cores, shared with other builders; `--maxWorkers=2`, Playwright `--workers=1`, ports 5520/4520):
- **Unit and golden:** 144 passed in 14 files:
  - `core/theory` 10, `core/suggest` 11, `core/suggest-spread` 5, `core/next-acceptance` 12 (new), `core/melody` 10;
  - `app/theory-next` 4, `app/rows` 28, `app/lane-rows` 25, `app/chord-block` 9, `app/melody-fit` 11;
  - `golden/compiler-golden` 3, `golden/migration-v2` 10, `golden/balance` 5, `dsp/render-golden` 1.
- **E2E** through `e2e:quick`, on chromium-dev, chromium-prod, firefox-dev and firefox-prod: `palette`, `suggestions`, `lane-blocks`, `lane-rows`, `row-inspectors` and `melody-fit`. 74 passed and 30 skipped (the once-per-engine prod skips), no retries.
- **Full `pnpm test --maxWorkers=2`:** 2807 passed, 8 skipped. lint and typecheck are clean.
- The golden data (`tests/golden/*.json`, `tests/dsp/render-golden.json`) and `examples/` have no diff between the M10 start (72bf65e) and 47656bf.

Status key: **C+P** covered and passing; **Part** partly covered; **Fail** a test shows it failing; **Owner** needs the owner's eyes.

## Gaps and findings (read first)

1. **Fixed (2026-11-23): Next offered a no-op on a composition.** In little-round at 10.739 s, the card "C · Tension (V)" passed `momentEffectAt` but compiled to `no-effect`.
   - Cause: adding the card made the Reed land chord lr0007 (marker 10.909) wait for it, so Reed was not in yet. The check had read the old decision order.
   - The check now reads the decision times with the new moment added, plus staggered births and part births (build log "Next / Add → Chord no-op check agrees with the compiler").
   - `KNOWN_NOOPS` was removed.
2. **Chords-row glide strip overlap:** a chord's 4 px glide strip (`.lane-bar`) lies under its block, and a land lead-in's strip reaches back under the block before it (M10b-3).
3. **Row headers cover the first pixels of the lane.** The header gutter is opaque. Labels stick to the right of it (M10b-3 "Labels stick"), but the markers and bands beneath it are hidden.
4. **Dragging a fitted tune's end drops its fit.** The drag changes the last note, so it counts as a hand edit: there is no redraw at the new length (M10b-5).
5. **Melody strong beats are counted from the tune's start,** not from the piece's bar grid (M10b-5).
6. **Fixed (2026-11-23): Add → Chord could read "no effect" just after a change.**
   - Cause: the check counted a split's staggered newborns as silent, where the compiler already counts them.
   - Add → Chord now also falls back to the next-best chord when the best one changes nothing.
   - `theory-next.test` covers this: the split case, the fallback, and every piece at 4 times.
7. **A legacy merge's Fade field is gone from the inspector:** its rewrite is a chord with `fade` = glide length (M10b-4). Also, Custom's Transition fields on a legacy block write its glide without rewriting the block.
8. **`touch-edit.spec:239` (the score readout tap) flakes on Chromium locally,** 5 of 8 runs at baseline (handoff, M10b). It was not touched here.
9. **The compiled-score golden covers only the 5 examples** (`examples.golden.json`). For the 10 compositions, "the same score" rests on the render goldens (bit-identical audio hashes), which cover all 15 pieces.
10. **Owner:** how the rows, Next cards and "Like the video" look and sound has not been reviewed here.

## §15 M10 acceptance lines

| Criterion | Status | Evidence |
|---|---|---|
| In C major, after I–V–vi–IV Next's best fit is I, and after V it is I; in A minor, after i–♭VII–♭VI it is V; each card's moment compiles to the chord it names and follows a later key change | C+P | **Ranking:** unit `theory.test` "M10 acceptance: I–V–vi–IV → I, V → I in C major; i–♭VII–♭VI → V in A minor". **Cards:** `suggest.test` "M10: after I–V–vi–IV the best card is Home; after V it is Home; i–♭VII–♭VI → V" (triads and sevenths: "C · Home (I)", "Cmaj7 · Home (Imaj7)", "E · Tension (V)", "E7 · Tension (V7)"; only the first is marked best). **Compiles and follows:** "each card compiles to the chord its label names, and follows a later key change" (C, C sevenths, Am, D Dorian, G Mixolydian): the harmony entry's name ends with the card's chord, its pitch classes lie in the chord and include the root, `matchChord` gives the numeral, and with a key moment to E written before the card the pitch classes move by the interval. **E2E:** `suggestions.spec` "after a progression: one card per job, chord first, the best marked, the reason in the tooltip" |
| Every built-in scale either gets job cards with no two of one job, or falls back to the old grammar, and Next never offers a no-op | C+P (gap 1 fixed 2026-11-23) | `suggest.test`: "every built-in scale gets job cards with no two of one job, or the old grammar; never a no-op" (`SCALE_NAMES`, D, 4 lines); "every suggestion compiles without errors and is not flagged no-effect (all examples)" (5 examples × 6 times); "keys without theory keep the composer grammar". New `next-acceptance.test`: "every built-in scale, after a chord change" passes; compositions × 4 times: all 40 spots clean, with no `KNOWN_NOOPS`. little-round @ 10.739 now skips V, which changes nothing there. `theory-next.test`: Add → Chord has an effect on every example and composition × 4 times, and just after a split |
| Every example and composition compiles to the same score (render goldens unchanged), and each of its moments shows as a block (or a dot) on exactly one row | C+P (compiler golden: examples only, gap 9) | **Same score:** `dsp/render-golden` "fixtures and example pieces render bit-identically" (17 fixtures plus 15 pieces: 5 examples and 10 compositions; hashes unchanged since before M10); `compiler-golden` "compiled output matches the golden summaries" (5 examples); `migration-v2` and `balance` pass. **One row:** `lane-rows.test` "M10 acceptance: every moment on exactly one row" (15 pieces): every moment is on one row or is a dot, and is placed on a shown row. `rows.test` "rowsOf on every example and composition": "each moment is a block on exactly one row, or a dot; no writes". **E2E:** `lane-blocks.spec` "six rows with headers, each block on its own row", "legacy moments are Chords blocks running to the next block" |
| The "Like the video" template is six chord blocks and one Wander texture, with no split, merge or unison | C+P | `rows.test` "six Float chord blocks and one Wander; no split, merge or unison; compiles": the types are 6 × chord + walk; all Float; counts 1, 6, 6, 6, 1, 7; A, then 6 lines, then E, then 7 lines; `rowsOf` gives 6 Chords blocks and Texture ["Wander"]. `melody-fit.test` "six chord blocks and one Wander, no split, merge or unison; no diagnostics". **E2E:** `melody-fit.spec` "New → Like the video: six chord blocks and one Wander…" (Menu → `new-video-piece`; no diagnostics) |
| The palette has no note, pin, split, merge, unison, shift, spread, walk, pulse or progression button | C+P | `chord-block.test` "six rows; each adds a block on its own row that compiles…": `PALETTE` is exactly Chord C, Texture T, Melody M, Level L, Sound S, Key K. `theory-next.test` "has no note or pin". **E2E:** `palette.spec` "palette click adds a moment at the playhead": the buttons are exactly those six labels, and there is no `data-moment` of note, pin, unison, split, merge, shift, spread, walk or progression. Texture's button carries `data-moment="pulse"` because its default texture (Arpeggio) is stored as a pulse moment; there is no Pulse button. "letters add each type; modified letters do not": I, U, P, W, R, E, O and B add nothing |

## Other §6.4 / §11.3 claims

| Claim | Status | Evidence |
|---|---|---|
| Legacy types (unison, split, merge, progression, note, pin) compile exactly as before and show on their row | C+P | Render and compiler goldens (above). `rows.test` "labels legacy and relative blocks", "a progression is a run of chord blocks". `lane-rows.test` "note and pin moments are dots…". `lane-blocks.spec` "legacy moments are Chords blocks…", "a note is a dot: it selects, drags in time and deletes" |
| Editing a legacy block rewrites it as a chord, in one undo | C+P (the merge Fade is lost, gap 7) | `chord-block.test`: "an edit that changes nothing leaves a legacy block alone (same piece)"; "editing a legacy unison rewrites it as a chord, id and seed kept, then applies the edit"; "progression chord k: freezes into chord moments…". `rows.test` "legacy unison, split, merge rewrite as chords that compile"; "a progression freezes into chord blocks that sound the same". **E2E:** `row-inspectors.spec` "editing a legacy unison rewrites it as a chord, in one undo entry" |
| Textures Hold / Wander / Arpeggio / Pulse; they read the Chords row | C+P | `rows.test` "Arpeggio restarts each bar; Pulse is together; Hold deletes; all compile". `chord-block.test` "Arpeggio → Wander → Hold keeps the region, then deletes". **E2E:** `row-inspectors.spec` "a texture: Arpeggio → Wander → Hold" |
| Chord blocks: Notes: n, Arrive Land / Float / Custom, relative shapes, typed progressions | C+P | `rows.test` "Arrive: land, float, custom round-trip", "Notes: n, relative shapes and back compile". `chord-block.test` "Arrive Float on a legacy block; Upside down on a chord", typed-chords tests. **E2E:** `row-inspectors.spec` "a chord block: Notes: 1, Arrive Float, Relative 'Upside down'", "typing 'IV 2, V 2'…" |
| Melodies re-fit when the chords change | C+P (gaps 4, 5) | `melody-fit.test` (11): re-fit on chord and key edits; no redraw on level edits; a hand edit drops the fit; one undo restores both. `core/melody.test` (10). **E2E:** `melody-fit.spec` "Add → Melody fits the chord; changing the chord re-fits it; one undo restores both" |
| Add → Chord uses the best chord for the spot; picker fit marks; Next keeps the spread | C+P (gap 6) | `suggest.test` "chordDefaultAt…", "chordPickerRanks…"; `theory-next.test`; `suggest-spread.test` (5). **E2E:** `suggestions.spec` "Add → Chord picks the chord that fits; the picker marks the best fits" |

## Owner steps

1. New → Like the video: play it and say whether it matches the video (all Float, Wander on the last block).
2. Open Kite Day and look at the lane rows (gaps 2 and 3).
3. After a few chords, try Next's cards and Add → Chord: do the best fits sound right?
