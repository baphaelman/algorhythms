# M14 acceptance audit (2026-11-24, base 6ab21c8)

Scope: PLAN §15 "M14. Poster workspace": *Accept when*, "The owner's notes on the first workspace (2026-11-24, evening)" and the playhead on the poster; build-log entries M14 P1, P2, P3, P5, P6, the poster PNG `alpha` fix.

**Changed in this audit (P4):**
- A new text box and its first text are one undo step (they were two: "Add text box", then "Edit text"). `editPosterEntry` / `editPosterJoin` (poster-sync.ts).
- Render's old poster path (`drawPoster`, `posterHudPlacement`, the old `posterLayout`, `drawTitleBlock`, `PosterInfo`, `PosterDrawOptions`, `POSTER_DPR`, `ROW_GAP`, `TITLE_EXTRA`, posterStyle's `title`) is deleted. Its unit tests check the same behaviour on `layoutPoster` + `drawPosterLayout`.
- New checks: e2e "every poster option of the old Export dialog is in the workspace", "every edit kind is one undo step", the picture surviving a reload and undoing; unit `app/poster-video.test`.

**Runs on this tree** (macOS, 6 cores, shared; Playwright `--workers=1`, `e2e:quick`). The M14 specs (`export-workspace`, `poster-workspace`, `poster-edit`, `poster-rows-background`, `poster-details`, `poster`, `export-colours`, `export-keys`):
- chromium-dev: 56 passed, 1 skipped (owner samples: needs `LOOK_SAMPLES_DIR`).
- firefox-dev: 54 passed, 2 skipped (the Chromium-only save picker, owner samples). First run: 51 passed; its 3 failures passed on rerun (export-colours' first test timed out in `beforeEach` while Firefox started; the playhead test while this Mac's audio clock was stalled; the new options test before a test-id fix).
- webkit-dev (`E2E_WEBKIT=1`): 54 passed, 3 skipped (the playhead test plays audio, which WebKit can't mute here, so it runs only on CI; the save picker; owner samples).
- `pnpm test` (`--maxWorkers=2`): 3304 passed, 8 skipped. `pnpm lint`, `pnpm typecheck`, `pnpm build` clean.

Status key: **P** passed locally on chromium-dev, firefox-dev and webkit-dev; **P (C+F)** passed locally on Chromium and Firefox, with WebKit left to CI; **U** a unit test (`pnpm test`).

## Open items (read first)

All acceptance lines pass: 13 *Accept when* lines, 7 owner-note items and 3 other checks. For the integrator:
1. **Glow on a poster is per layer.** Each part's layer draws its glow and then its lines, so a later part's glow lies over an earlier part's lines. The video draws every glow under every line. The PNG, SVG and artboard agree; only the look differs from the video's. A fix would draw the layers' glow passes first: `drawPosterLayout` → `drawScore`, render only.
2. **The gradient handles have no keyboard path** (P6). The panel's sliders reach every value.
3. **Revert leaves the viewer's remembered Look alone** (P6, by design). A piece without a poster doc still starts from it.
4. Known since M9: in macOS WebKit, transparent posters show translucent colours.

## *Accept when*

| Criterion | Status | Evidence |
|---|---|---|
| Every poster option of today's Export dialog is reachable in the workspace | P | e2e `poster-workspace.spec` "every poster option of the old Export dialog is in the workspace" (new): the old dialog's poster tab (at 39b35d9~1) had size picks, Width, Height, Rows, the cap hint, File (PNG/SVG), Theme, Section, Piece's pitch range, every Look control for posters (`LOOK_CONTROLS` with kind poster: guides, beats, moments, width, thickness, glow, vignette, line options, colours…), Guide notes, the HUD list and its boxes on the preview, Colours (schemes, background, swatches), Reset, Export. Each is visible in the workspace; the Title block switch is replaced by the two text boxes. Cap hint: "Rows slider redraws the preview; … cap". Piece range: `export-section.spec` "poster of a 45 s section…" |
| At 16:9, square and A4 portrait, rows 1–8, whole piece and a section, every Song's default poster: no clipped text, none outside the margins, none over other text, no text box over the music (automated) | U | `render/poster-layout-check.test`: 8 Songs × 3 sizes × rows 1–8 × whole / middle section × the default Look and a busy one (every label and line group, guides, pitch guides, HUD) = 768 layouts, `posterIssues` empty for each; By sections too (3 sizes × whole / section × default, A/B/A′/B′ and long row labels × both Looks). 17 tests, 2.2 s |
| Labels and lines toggle separately | P | e2e `poster-edit.spec` "labels and their lines switch apart: sections, moments, guides"; unit `render/poster-layout.test` "toggles labels and their lines separately (Look and group styles)" |
| Styling one Hz label restyles them all; Alt-click styles one | P | `poster-edit.spec` "a label selects its whole group; a style applies to all; Alt-click styles one; Reset" (Hz labels: size 150 % on all; Alt-click one: its own colour, the group's unchanged); unit `poster-layout.test` "a group style restyles every member; a member style only that one" |
| Corner, edge, Shift and Alt resizing, by mouse and by typed numbers | P | `poster-edit.spec` "the eight handles: corner, edge, Shift, Alt; typed X/Y/W/H"; unit `render/poster-edit.test` (`resizeBox`) |
| Margins move everything inside them | P | `poster-edit.spec` "margins move everything inside them; linked, then four; drawn as guides"; unit `poster-layout.test` "keeps text and music inside the margins", "moves everything with the margins" |
| Every edit undoes | P | `poster-edit.spec` "every edit kind is one undo step" (new): size, rows, theme, a Look segment, a Look slider, margins, a label switch, a line switch, rows by sections, a group style, a member style, a layer drag, a handle, typed W, an arrow nudge, align, a layer colour, hiding a layer, layer order, adding a text box (with its text), editing text, a text style, moving a text box, removing it: each changes the doc and one undo puts it back exactly. Also: "drag moves a layer as one undo step", `poster-details.spec` (disclosures, Revert, gradient handles, one step each), `poster-rows-background.spec` (row labels and New row; picture dimming, new) |
| The poster survives save, reload and a share link | P | `poster-edit.spec` "the poster survives a reload and a share link exactly"; `poster-rows-background.spec` "rows by sections with edited row labels survive a reload and a share link"; unit `app/poster-piece.test` (schema, canonical, round-trips exactly), `app/share.test` "a link drops the picture … the file keeps it" (the saved file) |
| PNG and SVG match the artboard | P | `poster-edit.spec` "PNG and SVG draw what the artboard shows" (artboard vs the layout on a fresh canvas > 50 dB; PNG vs the reference: < 0.1 % of channels off by > 2; the SVG holds the new text); `poster.spec` "PNG equals the layout drawn on a canvas, as the artboard draws it (pixel-identical)", "SVG is well-formed and matches the PNG when rasterised" |
| A poster layer's colour shows in the video export | P + U | unit `app/poster-video.test` (new): `frameOptions` (the export's and the preview's) colours exactly the part's voices; the frame's SVG has the colour; `poster-edit.spec` "a recoloured layer shows in the video preview" |
| Back to music restores the playhead and zoom | P | `export-workspace.spec` "Menu → Export opens the poster workspace; Back to music keeps the playhead and zoom", "Escape: a focused control first lets go, then Escape returns to the music" |
| Video frames unchanged for existing settings | U | `app/poster-video.test` "place, size, rows, Look, texts and groups leave every frame as it was" (identical `frameOptions` and frame SVGs at 3 times); `render/poster-background.test` "M11's … gradient draws exactly as before" (3 directions × 3 sizes); `render/poster-draw.test` "drawScore's poster switches" (absent = unchanged) |
| The specs pass on all three engines | P | See Runs. WebKit skips only the playhead test locally, because it plays audio; CI runs it |

## The owner's notes on the first workspace

| Item | Status | Evidence |
|---|---|---|
| Rows by sections: Equal / By sections, Organize list with New row and editable row labels; rows share one time scale, left-aligned | P + U | `poster-rows-background.spec` "rows by sections with edited row labels survive a reload and a share link", "rows by sections, row labels and the pulse-mark style draw on the artboard and in the SVG"; unit `render/poster-sections.test` (rows at sections, New row off joins, start row, span, caps, one time scale and left-aligned, row labels left of each row and inside the margins) |
| Row labels are a label group, defaulting to the section's label | U | `poster-sections.test` "row labels are a label group: restyled as one, hidden by default with equal rows", "each section starts a row … labelled as the section" |
| Every switch with details opens in place; pulse marks a styled group | P + U | `poster-details.spec` "a switch's disclosure styles its group in place; remembered; one undo step"; unit `app/poster-details.test`, `poster-sections.test` (pulse marks group, its style reaches the drawing) |
| Revert always visible, one undo step | P | `poster-details.spec` "Revert stays visible, resets to the default poster and undoes in one step"; unit `poster-details.test` (the default doc) |
| Placed gradients: two or more stops, linear at any angle or radial with a centre, in the panel and by handles | P + U | `poster-details.spec` "gradient handles: linear ends and stops, the radial centre; one undo step each; in the PNG"; `poster-rows-background.spec` "a placed gradient and a picture show on the artboard and in the PNG…"; `export-colours.spec` "a gradient background: in the preview, a video frame and the poster PNG"; unit `render/poster-background.test`, `app/poster-background-form.test`, `poster-details.test` (handle geometry) |
| Any picture as the background (cover, contain, tile; position; dimming); kept in the saved piece, not in share links (the link says so) | P + U | `poster-rows-background.spec` "a placed gradient and a picture…": the picture on the artboard and in the PNG, dimming, one undo step (new), kept after a reload of the tab (new), Share says it's left out and the link opens without it; unit `poster-background.test` "pictures" (fits, tiles, dimming, SVG `<image>`), `share.test` (link drops it, the file keeps it) |
| The playhead on the poster while the music plays; never exported | P (C+F) + U | `poster-edit.spec` "the playhead moves on the artboard while the music plays; hidden when stopped" (WebKit: CI only, it plays audio); unit `poster-sections.test` "the playhead (posterTimeAt) runs through each section row"; `render/poster-edit.test` (`posterTimeAt`). Not exported: it's DOM over the canvas, and the PNG/SVG checks above match the layout |

## Other checks

| Check | Status | Evidence |
|---|---|---|
| Keyboard: the workspace by keyboard alone, visible focus, Escape | P | `export-keys.spec` "the poster workspace by keyboard alone…", "poster controls by keyboard redraw the preview" |
| Layout at 1280, 1440, 1920 px and 600 px, light and dark | P | `export-keys.spec` "layout at …" (8 cases: no overlap, no sideways scroll, artboard on screen); screenshots at 1280/1440/1920 × light/dark with a text box selected and every disclosure open: no sideways scroll, no control past its panel |
| Render's old poster path deleted, behaviour kept | U | `render/poster.test`, `poster-rows.test`, `youtube-render.test`, `colours.test`, `look.test`, `hud-layout.test`, `section.test`: the same checks (background, transparent, independent of the context, every bundled piece < 10 MB of SVG; rows: time labels, one title, no nested clips, one time scale, a line continues across a break; vignette once, glow and pitch guides in the SVG; gradients and colours; the HUD fits; a placed readout; a section's times and labels) now on `layoutPoster` + `drawPosterLayout` |
