# M17 acceptance audit (2026-11-27, base 67d1e82)

Scope: PLAN §15 "M17. Pieces that travel": every bullet, its integrator calls and the *Accept when* line; build-log entries "M17 W1" to "M17 W4 follow-ups".

**Changed in this audit (W5):**
- **A poster setting dropped the QR code.** `docWithForm` (poster-doc.ts) rebuilds the doc from the form on every poster-field change and kept every object but `qr`. Entering Video with a code (the record's section and Look write the doc), or changing rows, theme or a Look slider, removed the code from the piece. It now keeps `qr`. Unit `poster-details.test` "drops objects, styles…" (the form keeps the code); e2e `m17-acceptance` checks the code survives Poster → Video.
- **The QR button measured the wrong link.** For a piece without a poster doc it measured the link with a bare `{qr: {}}`, but adding the code also writes the viewer's poster settings (section, Look, HUD layout). A link at 1,476 + ~20 characters showed the button enabled, and the code it added was at once "Too long to scan" (1,622). `qrLinkLength(piece, added)` now measures the piece as `addQrCode` makes it (`posterEditOf`, poster-sync.ts); an unedited example still measures its short link. Unit `poster-qr.test` "the limit…".
- New e2e `m17-acceptance.spec.ts` (4 tests) and fixtures `tests/e2e/fixtures/pre-m17-tidewater-hymn.algorhythms.json` (the example file at f582c4a, the commit before M17) and `pre-m17-tidewater-hymn.link.txt` (its `#p=` link made by f582c4a's own `encodeShareLink`).

Status key: **C** covered by a test that runs in CI (unit tests run on every push; e2e specs on chromium, firefox and macOS WebKit, dev and prod); **P** checked here by hand or by script, no CI test; **Gap** not covered. Every e2e spec under `tests/e2e/*.spec.ts` is in CI's normal run (`playwright.config.ts` `testDir`, `.github/workflows/ci.yml` shards everything not tagged `@perf|@latency`); none of the M17 specs is tagged.

**Summary:** 35 lines: 31 C, 1 P, 2 Gap (owner checks no headless browser can do), 1 not testable here.

## *Accept when*

| Criterion | Status | Evidence |
|---|---|---|
| A video edited in one browser plays frame for frame the same in a fresh profile with other remembered options, from a watch link, a dropped PNG, SVG and MP4, and a decoded QR code | C | new `m17-acceptance.spec.ts:215`. The maker (own context, 720p) sets 9:16, Follow with a set window, a 10–16 s section, a title card, a 5 s end card, one HUD readout moved by keys, and a poster edit (the QR code), then downloads PNG, SVG and MP4. The watcher's context has other remembered options (1:1, Whole piece, no HUD, no cards, other Follow, light theme with guides and glow, 60 fps, Max quality) and a dark system theme. It opens the watch link, drops the PNG, SVG and MP4, and opens the link jsQR decodes from the PNG's code (the public site, rewritten to the test server). Each time: the watch view, `piece.video` and `piece.poster` equal to the maker's, the watch view's first frame the same from every source, 4 of the export's own frames (`referenceFrame`, title card to end card) equal to the maker's, and after Escape the Video workspace preview equal to the maker's at 3 times. Also `video-in-piece.spec.ts:78` (share and watch link), unit `app/video-doc.test` "frame fidelity (M17)" (byte-identical SVG frames for two viewers, with and without a poster) |
| Escape lands in the Video workspace | C | `m17-acceptance.spec.ts:215` (from the watch link, PNG, SVG and MP4, with Export MP4 shown); `watch-view.spec.ts:76` (Escape at the same time; leaving browser fullscreen); unit `app/watch.test` "watch keys", "leaving fullscreen" |
| Open the music lands in the editor | C | `m17-acceptance.spec.ts:215` (the corner's, from the QR code's link), `:391` (the end screen's); `watch-view.spec.ts:76` |
| A dropped file without a piece is refused with a message | C | `m17-acceptance.spec.ts:215` (the maker's SVG without its `<metadata>`, the maker's MP4 with its `algr` box renamed: "This file has no AlgoRhythms piece in it", the open piece unchanged); `pictures-open.spec.ts:202` (a plain PNG, dropped and by Menu → Open); unit `app/piece-in-file.test` "reads each kind, and none from a file without a piece" |
| Old pieces, files and links open and play as before | C | new `m17-acceptance.spec.ts:445`, in a context with other remembered options: the pre-M17 `.algorhythms.json` by Menu → Open, the pre-M17 `#p=` link and `#kite-day` each open in the editor (no watch view, no workspace), with no `video` or `poster`, play (transport playing, time moves), and their Video shows the viewer's remembered options (1:1, end card Off), still without a record. Unit `app/video-doc.test` "a piece without a record still follows the viewer's options"; `share.test` (old links unchanged) |
| The watch view plays by touch in a phone-sized WebKit viewport | C (CI WebKit only) | new `m17-acceptance.spec.ts:497`: 390×664, mobile, touch, 3× pixels; skipped outside the WebKit projects (`test.skip` on `browserName`). Not run locally (WebKit can't be muted here); its steps passed once on chromium-dev with the skip lifted. Fills the window, no editor chrome, tap Play → playing with the AudioContext running, time moves, controls hide, a tap shows them, tap pause, seek. Also `watch-view.spec.ts:209` (390×844 touch, all engines) |
| The specs pass on all three engines | C (CI) | Locally: chromium and firefox, dev and prod (see Runs). WebKit runs on CI's macOS runner |

## PLAN bullets

| Line | Status | Evidence |
|---|---|---|
| **The video in the piece:** aspect, camera, Follow window and playhead place, HUD readouts and places, ahead, playhead, section, opening, ending are stored, only where they differ | C | unit `app/video-doc.test:100` "stores only what differs…", `:108` "captures what the form shows…", `canonical.test`, `share.test` (round trip, packing); e2e `m17-acceptance.spec.ts:215` (the stored record) |
| File settings stay the viewer's (size, frame rate, quality, loudness, thumbnail, description) | C | unit `app/video-doc.test:154` "the form shows the record over the defaults…"; e2e `m17-acceptance.spec.ts:215` (the watcher's 60 fps and Max don't change a frame; sizes pinned for the comparison) |
| Each piece keeps its own video; the choices used last become the defaults for new pieces | C | unit `app/video-doc.test:173` "an empty record is the fixed defaults; a piece without one keeps the viewer's form"; `export-section.spec.ts:231` "the Section is kept with the piece; another piece starts Whole" |
| Edits are on the piece's undo stack; save, reload and share links carry them | C | `video-in-piece.spec.ts:139` (one undo step per edit, redo); `video-in-piece.spec.ts:78` (share and watch link); `m17-acceptance.spec.ts:215` (PNG, SVG and MP4 carry the saved file's JSON). Reload: the address bar is the share link (unit `address.test`) |
| Call: an absent field is the fixed default, never the viewer's option; also the Look, colours and HUD layout | C | unit `app/video-doc.test:154`, `:213` "byte-identical frames under different remembered options", `:232` (with a poster); e2e `m17-acceptance.spec.ts:215` (dark system theme, other Look) |
| Call: a piece without a record plays with the viewer's options; its first edit in Video writes the record from what is shown | C | unit `app/video-doc.test:241`; `video-in-piece.spec.ts:139` (no record until the first edit) |
| **Watch view:** a watch link, a dropped picture or a scanned QR code opens the Video workspace filling the window, paused on its first frame (the title card) with a large Play | C | `watch-view.spec.ts:76` (first frame with lead-in and title card, Play focused), `:173` (dropped PNG); `m17-acceptance.spec.ts:215` (5 sources); unit `app/watch.test:93` |
| Play starts the sound and, on desktop, real fullscreen | C (stub) | `watch-view.spec.ts:76` (one `requestFullscreen` on Play, stubbed: headless browsers have none) |
| YouTube-like controls on hover: play/pause, seek bar, time, fullscreen | C | `watch-view.spec.ts:76` (roles, hide after 2.5 s, pointer shows them, Space, ←/→, seek, F) |
| Escape always lands in the Video workspace (also leaving browser fullscreen), where Export MP4 is | C | see *Accept when* |
| A corner offers Edit video and Open the music; the end screen offers Replay and Open the music | C | `watch-view.spec.ts:76` (end screen, Replay focused and plays from the start; the corner's Open the music); new `m17-acceptance.spec.ts:391` (the corner's Edit video → Video workspace; the end screen's Open the music → editor) |
| Real fullscreen on desktop browsers, and an iPhone's Safari | Gap (owner) | Headless browsers can't go fullscreen and there is no iPhone in CI. Owner check: open a watch link on a Mac (Play → fullscreen, Escape → Video workspace) and on an iPhone (fills the screen, no fullscreen button, touch) |
| **Phones:** the watch view, and only it, works on a phone: fills the window, touch controls | C | `m17-acceptance.spec.ts:497` (WebKit), `watch-view.spec.ts:209` (all engines) |
| **Share:** "Opens to: Music \| Video", default where you are; a watch link is the share link plus a flag; the address bar keeps §11.4's rule | C | `watch-view.spec.ts:234`; unit `app/watch.test:133`, `address.test` (watch parsing, the bar drops the flag); `video-in-piece.spec.ts:78` (bar reads `#p=` after a watch link) |
| **Pictures that open:** PNG, SVG and MP4 carry the whole piece, background picture included | C | `pictures-open.spec.ts:96` (picture included), `:163`; unit `app/piece-in-file.test` (iTXt, `<metadata>`, `moov/udta/algr`, JPEG APP15) |
| Drop one anywhere, or pick it in Menu → Open: it opens in the watch view | C | `pictures-open.spec.ts:96` (Menu → Open and drop, PNG and SVG), `:163` (MP4 drop); `m17-acceptance.spec.ts:215` |
| A file without a piece says so | C | see *Accept when* |
| The thumbnail (JPEG) carries the piece, without its picture if it would pass 2 MB | C | unit `app/piece-in-file.test:140` |
| **The hint:** new posters get "Drop this picture on baphaelman.github.io/algorhythms to play it", deletable like any text box | C | unit `render/poster-edit.test:254–259` (a default text, deletable), `render/poster-layout.test:267`, `:290` (takes no room, hides first); e2e `poster-edit.spec`, `poster-workspace.spec` (text counts include it) |
| Files sent as files keep the metadata; social apps strip it | — | Not testable here; that is what the QR code is for |
| **QR code:** a poster object placed, sized and coloured like a text box, with its quiet zone, holding the watch link | C | `poster-qr.spec.ts:122` (add, select, move, square resize, Delete, undo); unit `app/poster-qr.test:311`, `:365`, `:391`, `:405`, `:519` (colours, contrast) |
| Offered only when the link fits (~1,500 characters); otherwise it shows the link's length | C | `poster-qr.spec.ts:251` (disabled, "N of 1,500"), `:271` (a code whose link grows: "Too long to scan", left out of the PNG with a notice); unit `app/poster-qr.test:249` (W5: counts the poster settings the code seeds) |
| Off by default, added from the poster toolbar | C | `poster-qr.spec.ts:122` (no code until the tool adds it) |
| A small MIT QR encoder loaded only when a poster has a code; a decoder only in the tests | P | `qrcode-generator` (MIT) is its own chunk, loaded by `import()` (checked in this build: `dist/assets/qrcode-*.js`, reached only through a dynamic import in `main`); `jsqr` (Apache-2.0) is a devDependency |
| The code decodes to the watch link that opens the piece | C | `poster-qr.spec.ts:180` (short `#w&kite-day&f=poster` and full `#w&p=…`), `m17-acceptance.spec.ts:215` (an edited video); unit `app/poster-qr.test:237`, `:530`, `:545` |
| A poster setting changed after the code was added keeps it | C | W5 fix: unit `poster-details.test` "drops objects…", e2e `m17-acceptance.spec.ts:215` |
| A scanned code read by a phone camera | Gap (owner) | jsQR decodes the exported PNG at export size and downscaled (unit, e2e); a real camera, print or screen, is the owner's check |

## Open

- **Placed HUD readouts make links long.** Moving one readout pins every shown readout (by design, hud-place), and placed positions are stored unrounded (`-0.040000000000000036`), in the video record and again in the poster doc's Look. With Kite Day's six readouts and one moved, plus a section and cards, the edited link was 1,622 characters with a code, over the QR limit; the acceptance spec keeps one readout. Rounding `hudLayout` positions in canonical (4 significant digits, as poster boxes) would save about 25 characters a readout per copy. Not changed here: it touches W1's canonical rules and the record ↔ form settling.
- The owner checks above: real fullscreen and an iPhone, a phone camera scanning a printed or on-screen code.

## Runs (2026-11-27, this tree)

- Unit: `poster-qr`, `poster-details`, `poster-edit-app`, `video-doc`, `poster-sync`, `watch`: 72 passed. `pnpm lint`, `pnpm typecheck`, `pnpm build`: pass.
- e2e `m17-acceptance` on chromium-dev, chromium-prod, firefox-dev, firefox-prod: 12 passed, 4 skipped (the WebKit-only phone test).
- e2e `poster-qr`, `poster-edit`, `poster-details`, `export-section`, `video-in-piece`, `pictures-open`, `watch-view` on chromium-dev and firefox-dev: 81 passed, 1 skipped.
- WebKit: not run locally (CI).
