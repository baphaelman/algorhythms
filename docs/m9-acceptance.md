# M9 acceptance audit (2026-11-22, base `main` 5e2d4cc, v63)

Scope: PLAN §15 M9, §12 "Poster export (revision 12)" and §12 "Export look (revision 13)", including the owner's revisions and "Controls (owner, 2026-11-22)". Posters are PNG and SVG from the one renderer, at three sizes, with a theme, a transparent background and a title block, in the Export dialog. The Look panel is shared with video.

CI evidence is from v63 (`main` 5e2d4cc, workflow "CI", run 45081888847, attempt 1). Every job passed, and so did the deploy (137394070722):
- unit (lint, typecheck, unit, build): 137391664637;
- chromium, shards 1–3: 137391664855, 137391664831, 137391664886; chromium timing: 137391664909;
- firefox, shards 1–3: 137391664991, 137391664864, 137391665052; firefox timing: 137391664889;
- WebKit on macOS, shards 1–3: 137391664859, 137391664804, 137391664874; WebKit timing: 137391665003.

The annotations show two retried flakes. In WebKit shard 3/3, `video-dialog.spec:825` timed out waiting for the download (gap 5). In WebKit timing, `live.spec:90` latency failed its first attempt (outside M9). The jobs' console lines (the poster numbers) need a login, so the CI evidence for posters is pass/fail only.

**New test (this audit):**
- `tests/e2e/poster-long.spec.ts`, opt-in (`POSTER_LONG=1`: chromium-dev only; `POSTER_LONG=all`: every engine's dev project; skipped in CI and in normal runs).
  - **Gates:** a 16:9 4K PNG in < 2 s, and an SVG under 10 MB.
  - **Pieces:**
    - the longest bundled composition, lanterns-over-salt-flats (186.0 s);
    - the one closest to 3 minutes, the-cartographers-rain (176.4 s);
    - Kite Day cut to 180 s and to 600 s.
  - **Looks:** each piece in the dialog's default Look (EXPORT_LOOK, no HUD, title on) and in the player's look (guides and their labels on). The longest piece is also run at 1:1 and A4.
  - **PNG timing:** two medians of 3 after a warm-up. One is the dialog's path, `renderPosterPng` with the store's compiled score (draw + `convertToBlob`). The other includes the compile.

**Runs on this tree (4-core Linux cloud box, `--workers=2`; the `poster-long` numbers below are from a run alone, `--workers=1`):**
- lint and typecheck are clean.
- Unit: `render/poster`, `svg`, `look`, `hud`, `core/intervals`, `app/look-controls`, `export-options`, `export-run`: 105 passed in 8 files (13 + 18 + 21 + 5 + 4 + 10 + 26 + 8).
- E2E specs `poster`, `poster-long`, `poster-dialog`, `export`, `video-export`, `video-dialog` and `video-frames`, all through `e2e:quick`:
  - chromium-dev and chromium-prod: 92 passed, 22 skipped. The skips are the once-per-engine prod skips, the owner samples, and h264 + aac (no AAC encoder).
  - firefox-*: 86 passed, 28 skipped. Firefox also skips the two Chromium-only file-picker tests.
  - **Linux WebKit** (`E2E_WEBKIT=1`, Playwright webkit-2388, installed for this audit): 82 passed, 28 skipped, 4 failed.
    - Every poster test passed.
    - The 4 failures are outside M9 (gap 6): `video-export` ×3 failed with frame-0 PSNR 21.4 dB, from Linux WebKit's video codecs. `video-dialog:902` (HUD height animation) failed once in 4 reruns.
- Full `pnpm test --maxWorkers=2`: 2612 passed, 2 skipped, in 206 files.

Status key: **C+P** covered and passing; **Part** partly covered; **None** not covered; **Owner** needs the owner's eyes.

## Gaps and findings (read first)

1. **The < 2 s gate runs only in the opt-in spec.** `poster.spec` "speed at 4K…" gates the PNG at < 10 s in CI and logs the time. The measured times are far under 2 s: ≤ 0.11 s on Chromium and Firefox, and ≤ 0.35 s on Linux WebKit (see the table under §15). **Integrator call:** tighten the CI gate to 2 s, or leave it loose for slow runners. The times were measured on a 4-core Linux cloud box (headless), not on a Mac. Safari on macOS was not timed, and the CI timings can't be read without a login.
2. **WebKit transparent posters on macOS: translucent colours are off.** CI macOS WebKit gives a premultiplied error up to 63.75 (v59, quoted in the spec), with a mean of about 24; the spec's WebKit bound is ≤ 72.
   - Alpha and opaque pixels are exact there, and **Linux WebKit here is as exact as the others:** max 1.96, mean 0.39. Chromium gives 0, and Firefox 1.99 / 0.53.
   - So this is specific to macOS, from CoreGraphics' PNG encode or decode.
   - **Unknown:** whether Safari writes wrong colours into the file, or only decodes them badly in the test.
   - **Needs a Mac:** export a transparent PNG from Safari, decode it with a non-WebKit decoder (Python/PIL), and compare it with Chrome's file.
3. **The SVG-vs-PNG match is gated only for posters without HUD readouts, and only at 16:9 on an opaque background.**
   - **With the default HUD rows:** 35.9 dB on Chromium (build log, Export look: renderer), just under the 36 dB gate. The cause is canvas-vs-SVG text layout.
   - **Default posters are unaffected:** a poster's HUD is off by default (an integrator call: the readouts would show end-of-piece values).
   - **Not rasterised against the PNG:** 1:1, A4 and transparent SVGs. The unit tests cover their structure ("transparent: no background rect", sizes).
4. **SVG text depends on the viewer's fonts.**
   - `font-family` is the app's stack (`"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`). No web font is bundled, so the canvas also draws in the system mono.
   - `SvgContext.measureText` assumes a 0.6 em advance, which decides the title's ellipsis. That is exact in browsers here (the test above).
   - **Not checked:** how the text sets outside a browser (Illustrator, Inkscape, Figma).
5. **The macOS WebKit export-dialog hang (v61/v62) is not gone; it flaked once in v63.**
   - **v63:** green, but in WebKit shard 3/3 `webkit-prod` `video-dialog.spec.ts:825` "HUD: expands in place, one switch per readout; each reaches the export; keyboard" first failed. It hit `TimeoutError: page.waitForEvent: Timeout 60000ms exceeded while waiting for event "download"` (at `export-diag.ts:84`, called from spec line 881), then passed on retry.
   - **Symptom:** the same as v61/v62 (Export clicked, no download), at another test (v62's was `:779`).
   - **Not visible here:** the `guarded`/`clickExportForDownload` probe output is in the job log, which needs a login.
   - No poster-dialog test flaked in v63. Linux WebKit here never hung (82 passed).
6. **Linux WebKit (not a target; recorded for whoever runs it):** `video-export` frames decode at 21.4 dB (Linux WebKit's WebCodecs), and `video-dialog:902` (HUD height animation) fails about 1 run in 4. Neither involves posters.
7. **Poster heads: the two revisions read differently.** Rev 13 says "Poster: the same Look, except the future and playhead options". The poster also hides the Heads control (dots, rings, Hz labels), and `posterStyle` forces heads off. That follows rev 12 ("no heads or Hz labels"). At t = duration few heads would show anyway.
8. **PLAN §12 "Export look" contradicts itself on controls.**
   - "Owner (later)" says multi-way options are dropdowns.
   - "Preview and layout" says "compact dropdowns" and "the HUD is one control that opens its checklist".
   - "Controls (owner)" says no dropdowns, and the HUD expands in place.
   - The code follows "Controls" (no `<select>` in the Look; the HUD expands in place). The other two bullets are stale; the integrator may tidy PLAN.
9. **"Every visual decision is an option" is not complete.** The build log ("Export look: renderer", Inventory) keeps a list fixed:
   - type sizes and the mono font;
   - dot and ring radii;
   - the pitch-gradient hues and lightness per theme;
   - glide sampling (2 layout px = 9 device px on a poster);
   - Hz-label precision;
   - label letter spacing;
   - paddings.

   PLAN says such rules are "added to [the list], not hard-coded". **Owner/integrator call:** which of these, if any, should become options.
10. **Video items are cross-reference only:** see `docs/m8-acceptance.md`. The video's Look defaults are tested in `video-dialog.spec`. Chrome and Firefox MP4s carry Opus (m8 gap 3; QuickTime and iPhone playback unverified), and the bitrate is under-delivered (m8 gap 2). Neither has changed.
11. **Glides on a poster are sampled at layout scale, not device scale.**
    - `GLIDE_STEP_PX` = 2 and the chord tolerance (0.35 px) are in layout px. At the poster's pixel ratio of 4.5, a sample falls every ~9 device px, with a chord error of up to ~1.6 device px.
    - PLAN asks for "the 2 px rule at the poster's scale"; the code applies it at the layout scale.
    - The SVG-vs-PNG check cannot see this, because both draw the same polyline.
    - **Not checked:** whether facets show on a tight glide at 100 % zoom. That is for the owner (step 2); the SVG sizes leave room for 4.5× more points.
12. **Nobody has looked at the posters yet.** The defaults have not been reviewed: 16:9 4K PNG, title on, EXPORT_LOOK, no HUD, current theme. Owner steps below.

## §15 M9 acceptance lines

| Criterion | Status | Evidence |
|---|---|---|
| The PNG equals a direct `drawScore` render with the same camera and style (pixel-identical in the same browser) | C+P (macOS WebKit: within 1, gap 2 for transparent) | `poster.spec` "PNG equals a direct drawScore render (pixel-identical)": the `renderPosterPng` blob, decoded (`createImageBitmap`, no premultiply or colour conversion), against `referencePoster` (= `drawScore` with `posterCamera`, `posterLayout`, the same style, at t = duration, on a fresh OffscreenCanvas). **5 opaque cases:** tide-pools 16:9 light; kite-day A4 dark; night-ferry 1:1 thickness off; kite-day EXPORT_LOOK; harbour-song A4 dark with EXPORT_LOOK and every HUD readout. **This box:** 0 differing bytes in all 5 on Chromium, Firefox and Linux WebKit (inked pixels 483 k–880 k). **CI macOS WebKit** is allowed max ≤ 1 and ≤ 0.01 % of bytes differing (CI: tide-pools, 167 bytes off by 1); it passes in v63. **Transparent** (tide-pools dark): corner alpha 0; opaque pixels and alpha exact on every engine. Translucent pixels compared premultiplied: max 0 (Chromium), 1.99 (Firefox), 1.96 (Linux WebKit), within the gate of ≤ 2; macOS WebKit ≤ 72 (gap 2) |
| The SVG, rasterised by the browser at the same size, matches the PNG within an anti-aliasing tolerance in Chromium, Firefox and WebKit; well-formed XML with text as `<text>` | C+P (no-HUD posters at 16:9, gap 3) | `poster.spec` "SVG is well-formed and matches the PNG when rasterised": 4K, title on. The SVG goes through `<img>` → `drawImage` on a 3840×2160 canvas and is compared with the PNG. **Gate:** RGB PSNR ≥ 36 dB, and the 1 px-shifted PNG control must sit ≥ 6 dB lower; the other theme must sit below the control. **This box**, tide-pools light / harbour-song dark / kite-day EXPORT_LOOK: **Chromium 44.71 / 54.06 / 44.57 dB**, **Firefox 49.45 / 51.65 / 50.15**, **Linux WebKit 51.53 / 46.50 / 46.36**. Controls 26.65–28.80 dB; other theme 1.41–1.49 dB. macOS WebKit passes in CI v63. **XML:** `DOMParser` `image/svg+xml` gives no `parsererror`; root `svg`, `width` 3840, `height` 2160, `viewBox="0 0 3840 2160"`. **Text:** 13 / 14 / 7 `<text>` elements, including "AlgoRhythms". The octave-guide labels (`A4 440 Hz`) are present in the player look and absent in EXPORT_LOOK. Unit `svg.test.ts` (18): "writes a well-formed document…", "text: position, font, alignment, letter spacing, escaping", "escapes markup and drops characters XML forbids" |
| A 3-minute piece renders in under 2 s at 4K (PNG) on a desktop, and its SVG is under 10 MB | C+P (2 s gated in the opt-in spec only, gap 1) | `poster-long.spec` (table below): the slowest 16:9 4K PNG on a ~3-minute piece takes 107 ms on Chromium, 98 ms on Firefox and 349 ms on Linux WebKit. The largest SVG is 0.14 MB. `poster.spec` "speed at 4K and SVG size of every bundled piece" (CI, all engines; gate < 10 s): 4K PNG of the-cartographers-rain (176 s) 89–120 ms on Chromium, 138–167 ms on Firefox, 425–510 ms on Linux WebKit. **SVG 16:9, every bundled piece, < 10 MB:** 52 kB (little-round) to 368 kB (switchyard). Unit `poster.test` "every bundled piece renders, under 10 MB of SVG at every size" |

**`poster-long.spec`, this box, `--workers=1`:** PNG = draw + encode with the compiled score, median of 3 (with the compile in brackets); 16:9 unless marked.

| Piece (length) | Look | Chromium PNG ms | Firefox PNG ms | Linux WebKit PNG ms | PNG MB (C / F / W) | SVG MB, elements |
|---|---|---|---|---|---|---|
| lanterns-over-salt-flats, longest (186.0 s) | export | 107 (88) | 97 (100) | 349 (335) | 0.73 / 0.54 / 0.44 | 0.11, 454 |
| lanterns-over-salt-flats | player | 84 (91) | 94 (98) | 330 (352) | 0.75 / 0.56 / 0.45 | 0.11, 462 |
| the-cartographers-rain, closest to 3 min (176.4 s) | export | 89 (93) | 89 (95) | 308 (335) | 0.71 / 0.56 / 0.42 | 0.08, 150 |
| the-cartographers-rain | player | 99 (106) | 88 (90) | 328 (342) | 0.73 / 0.58 / 0.44 | 0.08, 158 |
| Kite Day cut to 180 s | export | 101 (111) | 97 (111) | 310 (329) | 0.87 / 0.75 / 0.39 | 0.14, 1020 |
| Kite Day cut to 180 s | player | 106 (114) | 98 (101) | 327 (335) | 0.90 / 0.79 / 0.42 | 0.14, 1033 |
| Kite Day cut to 600 s | export | 96 (102) | 89 (97) | 263 (292) | 0.63 / 0.53 / 0.23 | 0.09, 602 |
| Kite Day cut to 600 s | player | 94 (104) | 86 (108) | 291 (297) | 0.66 / 0.57 / 0.26 | 0.09, 615 |
| lanterns-over-salt-flats, 1:1 2160² | export | 51 (78) | 61 (64) | 195 (204) | 0.54 / 0.45 / 0.32 | 0.08, 362 |
| lanterns-over-salt-flats, A4 2480×3508 | export | 95 (111) | 103 (102) | 338 (345) | 0.82 / 0.70 / 0.46 | 0.09, 373 |

- The SVG takes 3–25 ms. Kite Day's own material ends at 108 s; after that, its lines continue.
- At 600 s the whole-piece camera fits 3.3× more time into the same width. Glides are sampled every 2 px, so it draws fewer points (602 elements against 1020 at 180 s).
- The same spec at `--workers=2` alongside the other specs: Chromium ≤ 155 ms, Firefox ≤ 160 ms, Linux WebKit ≤ 415 ms.

## Poster export items (PLAN §12, revision 12)

| Item | Status | Evidence |
|---|---|---|
| One renderer: `drawScore` with the whole-piece camera (the video's Whole), drawn as finished. Every line at full opacity (no ghost), no playhead, no heads or Hz labels, no editor overlays; section labels as the player shows them; thickness on (option off) | C+P | Unit `poster.test`: "is the finished piece: no ghost, heads, playhead or HUD; thickness on"; "frames the whole piece with the fitted pitch range" (`posterCamera` = start 0, window = duration, `pitchExtent`); "draws a background, the lines, and section labels as text". `look.test`: "a poster without a Look keeps no HUD; future and playhead are ignored". The PNG test above checks against `drawScore` itself. The labels and markers come from `videoMarkers(piece)`, as video does |
| PNG: drawn on an OffscreenCanvas at the chosen size, encoded with `convertToBlob` | C+P | `renderPosterPng` (`src/app/poster-export.ts`). `poster-dialog.spec` "PNG and SVG downloads…": `Tidewater-Hymn.png` decodes at 3840×2160, corner alpha 255 |
| SVG: the same `drawScore` call on an in-house recording context (`Ctx2D`-compatible: paths, strokes, fills, text, alpha, line styles, transforms, linear gradients) that writes SVG elements; text stays text (system mono stack); no dependency | C+P (fonts outside browsers, gap 4) | `src/render/svg.ts` `SvgContext` + `asCtx2D`; no new package. Unit `svg.test` (18): device-px paths and stroke attributes; miter limit and caps; stroke merging (opaque, undashed only); fill opacity and rules; `fillRect`/`clearRect`; gradients as `userSpaceOnUse` defs; save/restore of style, transform, dash and clip; nested clips; dash and width scaling; arcs (uniform scale) and Béziers (rotation); text; `measureText`; invalid values ignored as a canvas does; OKLCH → hex with channel clipping. `poster.test` "is independent of what the context drew before" |
| Size 16:9 3840×2160 (default), 1:1 2160×2160, A4 portrait 2480×3508 (time stays horizontal) | C+P | Unit `poster.test` "gives the 4K-class sizes", "draws every size at one pixel ratio…". `poster-dialog.spec` "offers Poster…": the status line reads 3840 × 2160 / 2480 × 3508 / 2160 × 2160 px; the downloads decode at 3840×2160 and 2160×2160; the A4 preview has the A4 aspect |
| Theme (current, light, dark) | C+P | `poster-dialog.spec`: Current checked by default; Dark reaches the request and is remembered; Reset → Current. `export-options.test` "poster: maps the defaults: PNG 16:9 with the title, no HUD, current theme" |
| Transparent background option for PNG and SVG | C+P (macOS WebKit translucency, gap 2) | `poster-dialog.spec`: transparent 1:1 PNG corner alpha 0, inked > 100; `look-background` is a switch; the preview shows a checkerboard. Unit `poster.test` "transparent: no background rect". `poster.spec` transparent case (§15 line 1) |
| Title block (default on): name, length and key, a small "AlgoRhythms" credit, in the HUD's type; off draws only the score | C+P; look: Owner | Unit `poster.test` "places the title block below the lines and markers, inside the frame", "cuts a long name with an ellipsis". `poster-dialog.spec`: `export-ptitle` on by default, off reaches the request (`title: false`). `poster.spec` SVG: "AlgoRhythms" in `<text>`. The PNG test (title off) = `drawScore` alone |
| Thickness on | C+P | `posterStyle` default `thickness: true`. The night-ferry thickness-off PNG case is pixel-identical too; the Look's "Thicker when merged or weighted" switch |
| Speed and size: a 3-minute piece < 2 s at 4K; SVG < ~10 MB for bundled compositions (glides at the 2 px rule) | C+P (gap 1); glide smoothness: Owner (gap 11) | §15 line 3 above. Glides are sampled at `GLIDE_STEP_PX` = 2 layout px (`draw.test` "samples a glide about every 2 px at any scale"), which is 9 device px at the poster's pixel ratio of 4.5. The largest bundled SVG is 368 kB |
| In the Export dialog | C+P | `poster-dialog.spec` (10 tests; the file picker is Chromium only; owner samples opt-in). Format "Poster"; File PNG/SVG and Size as radio groups; the Title block switch; "Export poster"; no codec line; the file name `<title>.png|svg`; Chromium writes PNG and SVG to the picked file ("saves PNG and SVG to a file picked in the save dialog (Chromium)"); fits a phone with the Look open |

## Export look items (PLAN §12, revision 13 and the owner's revisions)

| Item | Status | Evidence |
|---|---|---|
| One Look panel shared by video and poster, exposing every visual decision; remembered per viewer; with no Look given, the app's drawing is unchanged | C+P; "every decision": Part (gap 9) | `render/look.ts` `lookStyle`. `look.test` "PLAYER_LOOK is the style the player and video drew before the Look". Build log: call-log hashes of 432 frames are identical before and after. Remembered: `export-options.test` "round-trips the Look and the video/poster choices under algorhythms.export" (throwing storage and bad values included); `poster-dialog.spec` and `video-dialog.spec` reload tests; "renders without storage (localStorage throws)" |
| Export defaults: octave guides and their labels off; beat/bar lines off; future hidden; moments as labels only (no marker lines; owner, later); each an option | C+P | `look.test` "EXPORT_LOOK: guides and beats off, future hidden; section labels without ticks, the rest as the player". `look-controls.test` "the defaults show the EXPORT_LOOK values". `poster-dialog.spec`: the request's `look` equals `{...EXPORT_LOOK, theme, hud: []}`; guides `off`, moments `labels`. `video-dialog.spec` "Look: defaults are EXPORT_LOOK…". `poster.spec` SVG: no `A# … Hz` text with EXPORT_LOOK |
| Other options: louder voices brighter; thicker when merged or weighted; pulse hit marks; heads (dots, rings, Hz labels separately); playhead line; line colours (as in the app by default, by pitch, ink, custom); line width; theme; transparent background (poster) | C+P | `look.test` "Look switches (drawing calls absent / present)": guides and labels, beat lines, every beat, sections and ticks, future hidden, louder voices brighter, pulse marks, heads (dots, rings, Hz labels) and the playhead, line width and ink, transparent. `look-controls.test` round trips. `video-dialog.spec`: the controls reach `exportVideo`; "line colours follow the app by default; By pitch overrides it". `poster-dialog.spec`: guides, width, Ink + colour reach the poster |
| Beat lines: off (default) / bars and beats as the zoom allows / every beat (full height, never thinned) | C+P | `look.test` "every beat: one full-height line per beat over the view, where auto thins them". `poster-dialog.spec` "Beat lines: Every beat draws more than Bars and beats; reaches the poster" |
| HUD fully customisable: a checklist of readouts, each on/off, in the listed order (left column, then right): formula, notes / pool, time / length, chord, key and follow mode, Hz range, and the new spread, low/high note names, sounding names, gaps, piece name; default = today's HUD | C+P (poster default: none, an integrator call) | `render/hud.ts` `HUD_ITEMS`; `look.test` "HUD readouts" (names, gaps, mid-way readouts, "the default list draws exactly as hud: true") and "HUD layout with many readouts" (fits 1080p video in each aspect, and posters with the title below); `intervals.test` (spread names). `export-options.test` "HUD choices list every readout in order with a sample". `video-dialog.spec` "HUD: … each reaches the export". A poster's default is none (`poster-dialog.spec`: "None", every switch off) |
| Poster: the same Look, except the future and playhead options | C+P (heads also hidden, gap 7) | `look-controls.test` "video and poster show their own controls". `poster-dialog.spec` "offers Poster…": no `look-future`, `look-follow-at`, `look-playhead` or `look-heads`; `look-background` present |
| Controls (owner): continuous values are sliders (ahead of the playhead 0–100 %, 0 hidden, 100 full; playhead at %); yes/no are toggles; small fixed sets are segmented buttons; no dropdowns; the HUD expands in place, one toggle per readout, no popup | C+P (PLAN wording, gap 8) | `look-controls.test` "continuous values are sliders, yes/no switches, small sets segments; no dropdowns", "Ahead of the playhead: 0 hidden, 100 full, between dimmed at that opacity", "Playhead at: continuous 10..90 %…", "Line width: a factor 0.5×..2×…". `video-dialog.spec`: "Look sliders work from the keyboard…"; "HUD: expands in place, one switch per readout; each reaches the export; keyboard"; "HUD: reduced motion opens it at once; otherwise it animates its height"; "phone: the Look segments fit, one line each; no dropdowns"; "the expanded HUD never covers the Export button". `poster-dialog.spec` "the Look segments fit, one line each, at 375 and 1280 px; no dropdowns" (no `.look select`); switches have `role="switch"` |
| Preview: a live preview of the video frame (with a time slider) or the poster, drawn by the export's own code, redrawn on every change, on screen while the options scroll | C+P | `video-dialog.spec`: "the preview draws the export's frame; redraws on changes; the time slider scrubs" (< 0.2 % of pixels off by > 16 against `referenceFrameAt`); "the preview starts at the editor's playhead"; "the preview stays in view while the options scroll (desktop and phone)". `poster-dialog.spec` "the poster preview draws the export's poster; transparent on a checkerboard; A4" (against `referencePosterAt`) |
| Whether the defaults are right; how posters look (title block, A4 type size, transparent edges) | Owner | Owner samples: `LOOK_SAMPLES_DIR=<dir>` with `poster-dialog.spec` "owner samples" (the dialog + the default poster, Chromium); `POSTER_OUT_DIR=<dir>` with `poster.spec` (Kite Day 16:9 light PNG, Night Ferry A4 dark PNG, Harbour Song 16:9 dark SVG) |

## Owner steps

1. Export Kite Day as a poster at the defaults (16:9 PNG, title on) in Chrome. Say whether the defaults suit: EXPORT_LOOK, no HUD, the current theme.
2. Export an A4 portrait poster and a 1:1 one. Check the title block and the type size, and look at 100 % zoom for facets on fast glides (gap 11).
3. Export the SVG and open it in another program (Illustrator, Inkscape or Figma); check the text (gap 4).
4. In Safari on the Mac, export a transparent PNG and put it on a coloured background. Compare its soft edges with Chrome's file (gap 2).
