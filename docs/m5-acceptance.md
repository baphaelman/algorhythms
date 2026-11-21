# M5 acceptance audit (2026-11-21, base `main` c31ed0a)

Scope: PLAN §15 M5 (piano ruler, multi-select, marquee, copy and paste, Freeze, share links, touch editing), plus the §11.3, §11.3b and §11.4 points they reference.

**Composition links closed (rev 9 compositions merged):** all eight examples on disk are ≤ 2,000 characters and round-trip (`share-length`): the five originals 1,008–1,097, Harbour Song 1,694, Kite Day 1,274, Night Ferry 1,622. The fixture copies are gone.

**Touch gaps closed (lane pinch, dot octave move, piano ruler by touch):** `touch-edit` 13/13 and `piano-ruler`, `multi-select`, `dots` pass on chromium-dev and firefox-dev (42 passed, 16 skipped as chromium-only).

**Runs, on this tree (`--maxWorkers=2`, `--workers=1`):**
- Unit and property: `share`, `share-length`, `m5-helpers`, `m5-actions`, `touch`, `strip-defaults`, `canonical`, `property/app/share`: 8 files, 75/75 pass.
- E2E, chromium-dev: `share`, `multi-select`, `copy-paste`, `piano-ruler`, `freeze`, `touch-edit`, `naming`, `lane`, `mouse-only`: 40/40 pass.
- Firefox, WebKit and chromium-prod not run here. WebKit runs on CI only.

Status key: **C+P** covered and passing; **Part** partly covered; **None** not covered; **NB** not built; **CI+owner** cannot be proven here.

## Gaps (read first)

1. **"Works by touch alone on iPad Safari" is CI+owner.** `touch-edit.spec` passes on chromium-dev (CDP touches) and, per the build log, firefox-dev (synthetic touch events). WebKit has not run it locally and no real iPad was tried. Safari-only traps (the `gesturechange` double zoom, callouts, long-press selection) can only show on a device. Owner steps are at the bottom.
2. **A frozen split has no Unfreeze** (undo only). Needs `frozenFrom` on `SplitMoment` in core. §11.3 says Unfreeze for chord and walk only; build log records it. Not built.
3. **Piano ruler in live mode "clicking plays"** belongs to M7 (§9); only the stopped-transport audition exists. Not an M5 line.

No cheap new test was needed: every §15 line has a test, and the gaps above are product or platform limits.

## §15 M5 acceptance lines

| Criterion | PLAN | Status | Evidence |
|---|---|---|---|
| Share links round-trip exactly | §15, §11.4 | C+P | `unit/app/share.test.ts` (v1 kept, v2 round trip and same link back, old links, zlib interop, unknown fields, non-canonical input); `property/app/share.property.test.ts` (decode(encode(p)) = canonical p; encode(decode(link)) = link); `share.spec` "the Share dialog link opens exactly the same piece, and re-encodes to the same link" |
| Every example's share link ≤ 2,000 characters | §15, §11.4 | C+P | `unit/app/share-length.test.ts` (every example in `examples/` and `examples/compositions/` ≤ 2,000 and round-trips) |
| Adding by touch | §15, §11.3b | C+P (gap 1) | `touch-edit.spec` "a palette tap adds a moment at the playhead…"; "…a double tap adds a note" |
| Moving by touch | §15, §11.3b | C+P (gap 1) | `touch-edit.spec` "a finger drag moves a moment; a small wobble is still a tap; undo by tap"; "a chord dot drags by touch…" |
| Editing by touch | §15, §11.3b | C+P (gap 1) | `touch-edit.spec` inspector chip by tap, span-end length and "Ends set stagger", "Snap off in the menu stands in for Alt" |
| Deleting by touch | §15, §11.3b | C+P (gap 1) | `touch-edit.spec` "long press: Duplicate, then Delete, by touch alone" |
| On iPad Safari | §15 | CI+owner | WebKit on CI; owner steps below |

## M5 items

| Item | PLAN | Status | Evidence |
|---|---|---|---|
| Piano ruler: keys on the pitch axis, key in effect marked | §11.3 | C+P | `piano-ruler.spec` "shows keys on the pitch axis, marked by the key in effect"; `m5-helpers.test.ts` "lists keys, black keys and key roles" |
| …chord selected: clicking a key toggles a note | §11.3 | C+P | `piano-ruler.spec` "toggles a selected chord's notes, one undo entry each"; `m5-actions.test.ts` "adds and removes chord notes"; `m5-helpers.test.ts` "toggles a chord note…", "a toggled frozen chord…sounds the new notes" |
| …pin selected: a key moves it; none selected edits nothing | §11.3 | C+P | `piano-ruler.spec` "moves a selected pin…"; `m5-actions.test.ts` "moves a pin" |
| …keyboard use | §11.5 | C+P | `piano-ruler.spec` "keyboard: arrows move between keys, Enter presses" |
| …live mode, clicking plays | §11.3 | NB (M7) | gap 3 |
| Multi-select: Shift-click, ⌘/Ctrl-click | §11.3 | C+P | `lane.spec` "click selects, Shift-click extends…"; `multi-select.spec` ⌘/Ctrl-click on the lane and on a score line; `m5-helpers.test.ts` "toggles, selects all…" |
| Marquee (lane Shift-drag; score background drag) | §11.3 | C+P | `multi-select.spec` "Shift-drag on the lane selects the moments it touches; plain drag pans"; `score-select.spec` (marquee); `m5-helpers.test.ts` "finds the boxes a rectangle touches" |
| Select all; Delete as one undo entry | §11.3 | C+P | `multi-select.spec` "⌘/Ctrl+A selects all; Delete removes them as one undo entry" |
| Group nudge and drag, one undo each | §11.3 | C+P | `multi-select.spec` "arrows nudge and a drag moves the whole selection, one undo entry each" |
| Copy, cut and paste at the playhead; new ids, spacing kept, one undo | §11.3 | C+P | `copy-paste.spec` "copy and paste at the playhead…", "cut removes…"; `m5-actions.test.ts` "cuts and pastes…"; `m5-helpers.test.ts` copy/paste/anchor tests |
| Paste snaps to a beat with Snap to beats | §11.3 | C+P | `copy-paste.spec` "paste snaps to a beat…"; `m5-actions.test.ts` "snaps the paste…" |
| System clipboard: own clips paste, other text does not; text fields keep native copy | §11.3 | C+P | `copy-paste.spec` "a clip from the system clipboard pastes; other text does not", "a text field keeps its own copy and paste"; `m5-helpers.test.ts` "refuses anything else", "refuses moments the schema refuses" |
| Pasted moments survive a share link | §11.4 | C+P | `copy-paste.spec` "pasted moments survive a share link" |
| Alt-drag duplicate keeps the seed | §11.3 | C+P | `lane.spec` "Alt-drag duplicates and the copy keeps the seed" |
| Delete/Backspace and arrow nudge | §11.3 | C+P | `lane.spec` "keyboard: focus, nudge by grid steps, delete…" |
| Freeze chord: keeps the sound, Unfreeze restores | §11.3 | C+P | `freeze.spec` "freezes a chord, keeping its sound; Unfreeze restores it"; `m5-helpers.test.ts` "keeps the sound, and edits to earlier moments no longer change a frozen one" |
| Freeze walk into fixed steps; undo restores | §11.3 | C+P | `freeze.spec` "freezes a walk into fixed steps; undo restores it" |
| Freeze applies to chord, split and walk only; several at once = one undo | §11.3 | C+P | `freeze.spec` "several selected moments freeze together as one undo entry"; `m5-helpers.test.ts` "applies to chords, splits and walks only, once"; `m5-actions.test.ts` "freezes the selection in one undo entry" |
| Freeze split has an Unfreeze | §11.3 | NB | gap 2 |

## §11.3b touch rules

| Rule | Status | Evidence |
|---|---|---|
| Tap selects; drag moves; drag a span end changes length | C+P | `touch-edit.spec` tap select, finger drag, span end |
| Long press: duplicate, delete, snap on/off, stagger editing | C+P | `touch-edit.spec` long-press Duplicate/Delete, "Snap off…", "Ends set stagger"; score long press |
| Nothing depends on hover; voice/note/Hz on tap | C+P | `touch-edit.spec` "a tap on a line shows its readout"; palette hover preview mouse-only (build log) |
| Pinch zooms; two-finger drag pans | C+P | `touch-edit.spec` "pinch zooms the time window; two fingers pan it" (score), "…over the lane; two fingers pan it", "a pinch that starts on a moment edits nothing" |
| Dot octave move by touch (stands in for Shift-drag / Shift+▲▼) | C+P | `touch-edit.spec` "dots: a long press on a dot offers Octave up and down…" (long-press menu: Octave up / Octave down while dots are selected) |
| Piano ruler by touch | C+P | `touch-edit.spec` "piano ruler by touch: a chord key toggles a note; a pin key moves the pin"; `piano-ruler.spec` keys do not overlap. Fixed: the global `button` `min-height: 34px` made keys overlap, so a tap or click hit a neighbour (`piano.css`) |
| Finger slop, long-press timing, latched modifiers | C+P | `unit/app/touch.test.ts` (5 tests) |
| Select several by touch | C+P | `touch-edit.spec` "Select more: taps add to the selection and a lane drag draws the marquee" |

## §11.4 points

| Point | Status | Evidence |
|---|---|---|
| Default stripping: unchanged built-in timbres, default `mix`, `view`, fields equal to default are omitted and restored | C+P | `core/strip-defaults.test.ts`; `share.test.ts` packing rules |
| Over about 2,000 characters the UI warns and offers a file | C+P | `share.spec` "a link over 2,000 characters warns and offers the piece as a file" |
| Name it before moving on: asks when edited and unnamed; Save name, Skip, Escape; once per piece; unedited asks nothing | C+P | `naming.spec` (5 tests) |

## Owner iPad check (iPad Safari, the live site, a Generate or example piece)

1. Tap a palette button: a moment appears at the playhead. Tap it: it is selected and the inspector opens.
2. Drag it sideways: it moves; a small wobble is still a tap.
3. Drag a glide span's end handle: the length changes.
4. Long-press the moment (about half a second): the menu opens. Tap Duplicate, then long-press the copy and tap Delete. Check no text-selection callout appears.
5. Long-press, turn Snap off, drag a moment: it moves freely. Tap the chip to turn it off.
6. Tap a chord line: the readout shows; drag a chord dot to change a note.
7. Long-press, turn on Select more, tap three moments, then Delete (or Duplicate) the group.
8. Pinch the score: it zooms once (not twice). Two-finger drag: it pans.
9. Tap a piano ruler key with a chord selected: the note toggles.
10. Menu, Share link…: copy it and open it in a new tab: the same piece loads.
