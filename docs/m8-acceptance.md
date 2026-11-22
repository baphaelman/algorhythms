# M8 acceptance audit (2026-11-22, base `main-7glpov` f10845d)

Scope: PLAN §15 M8 and §12 "Video export (revision 11)": offline frames + the WAV export's mix through WebCodecs into the in-house MP4 muxer; 16:9, 9:16, 1:1; Follow and Whole-piece cameras; options; streaming save; progress and cancel. CI evidence is from v57 (`main` f10845d), which passed every job: unit 137236282660, chromium 137236282964, firefox 137236282896, WebKit on macOS 137236283004.

**New test (this audit):**
- `tests/e2e/video-long.spec.ts`, opt-in (`VIDEO_LONG=1`, chromium-dev only; skipped in CI and in normal runs):
  - a 3-minute piece at 1080p30, Follow and Whole (wall time, reported);
  - a 10-minute piece at 720p30 Follow, streamed to disk: ffprobe sample tables, the decoded frame near the end against frames k − 1, k, k + 1, and the decoded audio near the end cross-correlated with the WAV render (gated: k wins, lag ≤ 1 ms);
  - Whole-piece frame cost near the end of 30, 180 and 600 s pieces (reported).

**Runs on this tree (`--maxWorkers=2`, `--workers=1`, 4-core cloud box, ffmpeg/ffprobe 6.1.1 installed):**
- lint and typecheck are clean.
- Unit: `unit/video/mp4`, `mp4-ffprobe`, `avcc`, `unit/render/video`, `unit/app/video-export`: 49 passed, 5 files (`mp4-ffprobe` runs here: ffmpeg is installed). With `app/export-options` and `app/export-run`: 71 passed, 7 files.
- E2E, chromium-dev and chromium-prod: `video-frames`, `mp4-mux`, `video-export`, `video-dialog`, `export`: 50 passed, 14 skipped (h264 + aac: no AAC encoder; owner samples; the once-per-engine prod skips).
- E2E, firefox-dev and firefox-prod, same specs: 46 passed, 18 skipped (as Chromium, plus the two Chromium-only streaming-save tests).
- `video-long` (VIDEO_LONG=1, chromium-dev): 3/3 passed.
- WebKit is not installed on this box. For WebKit (H.264 + AAC, Safari's worker path), the evidence is CI v57.
- The full `pnpm test` was not run here; CI v57's unit job: 2525 passed, 8 skipped (`mp4-ffprobe` skipped: no ffmpeg on the runner).

Status key: **C+P** covered and passing; **Part** partly covered; **None** not covered; **Owner** needs the owner's eyes.

## Gaps and findings (read first)

1. **Gates moved to CI measurements in v57 (5d18279, f10845d; build log "M8: CI gates for video export").** v56 (bce9a43) failed two gates:
   - Firefox on Linux CI decoded frames at 39.4–41.3 dB against a 40 dB gate (this box: 42.1–44.6). The gate is now PSNR ≥ 37 dB **and** ≥ the frame's control (the frame 15 away) + 4 dB. Controls run 30.6–36.0 dB, so a one-frame-off or wrong picture still fails.
   - WebKit's AAC lands **3.25 ms early** through `decodeAudioData` (measured priming 2112 samples, cut by the edit list). The gate is ≤ 5 ms for AAC (≤ 1 ms for Opus). Imperceptible (lip-sync tolerance is ~20 ms), but the cause is not resolved: it needs a Mac to tell whether WebKit's file decoder also trims some priming, or whether `<video>` playback differs from `decodeAudioData`.
2. **Every encoder runs well under the requested bitrate on these pictures; Firefox lowest.** It ignores `bitrateMode` (`'constant'` gave byte-identical output). At 1080p30 (8 Mb/s asked), 30 s Kite Day: Firefox 1.4–1.6 Mb/s, WebKit 2.0, Chromium 2.5–2.7. The quality gate still passes everywhere (≥ 39.4 dB). Whether Firefox's files look soft is for the owner.
3. **Chromium and Firefox can't encode AAC**, so their files are H.264 + **Opus in MP4**. Every engine here plays them, and ffprobe/ffmpeg read them cleanly. **Unverified:** whether QuickTime, iOS Photos/Safari and social-media uploaders accept Opus in MP4. If they don't, a file exported from Chrome or Firefox would not play on a phone. Only WebKit writes AAC.
4. **The Whole-piece camera is the slow one; its frames are not cached.** It draws every line on every frame: ~16–20 ms per 1080p frame on Chromium (CI and here) against ~7 ms for Follow. The real-time margin shrinks with piece length: on Chromium here, 30 s pieces export at 3.0×, a 3-minute piece at **1.53×** (Follow 4.0×). A denser 10-minute piece was not measured. A cache of the past at the fixed camera (build log M8-b) is the fix if it's needed.
5. **The Safari worker path is verified only through CI** (Playwright WebKit on macOS 26; `thread: "worker"`). Safari itself was not run, and neither was iOS.
6. **Streaming save (`showSaveFilePicker`) is Chromium only**, as PLAN says. Elsewhere the file is a Blob in memory, with the 1 GB warning. On Chromium the streaming path is tested against a stubbed picked file, not a real save dialog.
7. **The size estimate is an upper bound.** "Up to N MB" uses the requested bitrates; real files come out at about 55 % of it (build log M8-d), and at 1080p on this content nearer 25–35 % (gap 2).
8. **"3-minute" and "10-minute" pieces are Kite Day with `end.at` moved to 180 s and 600 s.** Its own material ends at 108 s; after that, its lines continue. Camera and playhead motion continue, so the sync checks hold, but the drawing load past 108 s is lighter than a real long piece. The longest bundled composition (Interference, 166 s) was not run.
9. **ffprobe runs only off CI.** The CI runners have no ffmpeg, so `mp4-ffprobe.test.ts` and the ffprobe step in `video-export.spec` skip there. They pass on this box. The box-structure check (`mp4.test.ts`) runs everywhere.

## §15 M8 acceptance lines

| Criterion | Status | Evidence |
|---|---|---|
| Plays in Chromium, Firefox and Safari `<video>`, duration within one frame of the WAV export's length | C+P (Safari = Playwright WebKit on macOS, gap 5) | `video-export.spec` "720p30 export plays…": `elementDuration` vs `wavSeconds` ≤ 1/30 s, and the frame count = ⌈wav·fps⌉. CI v57: Chromium and Firefox 13.140 s, WebKit 13.133 s, against a WAV length of 13.115 s (Δ 25 ms and 18 ms; a frame is 33 ms). VP9 fallback likewise on all three. `video-dialog.spec` "the choices reach exportVideo; the download plays at the WAV length" (9:16 720p, all three engines). `mp4-mux.spec`: both layouts play with the right duration and frames (WebKit h264 + aac; Chromium and Firefox h264 + opus and vp9 + opus) |
| Decoded frame k matches `drawScore` at k / fps; decoded audio matches the WAV within codec tolerance; no drift over a 10-minute piece | C+P (gap 1); drift: C+P on one 10-minute export (gap 8) | Frames: PSNR of frames 0, n/2, a mid-glide frame and the last frame against `referenceFrame` (= `drawVideoFrame` at k/fps), with frame k ± 15 as the control. Audio: `decodeAudioData` against `renderMix` (the WAV export's samples), lag by cross-correlation, RMS. Quoted below. **Drift** (`video-long.spec`, 600 s piece + tail = 606.115 s, 18 184 frames, H.264 + Opus): ffprobe counts 18 184 video packets; the last pts is 606.100 s = (n − 1)/30 exactly; the video stream lasts 606.133 s and the audio stream 606.140 s (whole Opus frames), against a WAV of 606.115 s. Frame 17 850 (5 s before the end), decoded by ffmpeg, is 44.38 dB against its own render and 42.80 and 42.80 dB against frames 17 849 and 17 851, so it is not even one frame off. The audio over the 3 s before it has lag **0 samples** against the WAV. By construction: frame k has timestamp round(k·10⁶/fps) µs on a timescale of fps × 1000; the audio is the WAV render laid out contiguously from its first sample |
| A 1080p30 export of a 3-minute piece finishes faster than real time on a desktop; cancel stops it within 1 s | C+P (real time: this box and CI on 30 s; one 3-minute run here, gap 4) | `video-export.spec` "speed: 30 s at 1080p30, Follow and Whole" (gate > 0.3×; logged). CI v57 real-time factor, Follow / Whole: Chromium 4.20× / 3.58×, Firefox 1.47× / 1.54×, WebKit 4.74× / 3.98×. This box: Chromium 3.60× / 3.02×, Firefox 1.82× / 1.98×. **3-minute run** (`video-long.spec`, Chromium, this box, 186.1 s with the tail, 5584 frames, H.264 High 4.0 + Opus, worker): Follow 46.5 s wall, **4.00×** (120 fps, 57.3 MB, 2.46 Mb/s); Whole 121.9 s wall, **1.53×** (46 fps, 44.3 MB). Cancel: `video-export.spec` "cancel stops within 1 s with an AbortError" (1080p30 Follow, abort at 3 %): 0–0.5 ms here, AbortError, on all three engines in CI. `video-dialog.spec`: Cancel (< 1.5 s, and the picked file is left empty) and Escape |
| The muxer's output passes a box-structure check (and `ffprobe` where available in CI) | C+P (ffprobe off CI, gap 9) | `unit/video/mp4.test.ts` (with the `boxes.ts` reader): box order and every sample at its bytes, timescales, durations and stss, interleaving, co64 and 64-bit mdat, ctts + elst for B-frames, Opus dOps/elst, AAC esds, both layouts give the same tables. `mp4-ffprobe.test.ts` (6, here): ffmpeg-encoded H.264+AAC, H.264 with B-frames, VP9+Opus re-muxed in both layouts, probe alike and decode to the same framemd5. `video-export.spec` ffprobe step, here: `h264 1280 394 frames, opus, 13.140000 s` and `vp9 …` on Chromium and Firefox, with a clean `ffmpeg -f null` decode. `avcc.test.ts`: the repair for Firefox's avcC |

**Frames and audio, CI v57 (`video export <engine>` lines, 720p30, Kite Day cut to 7 s + tail, 394 frames, WAV 13.115 s):**

| Engine (job) | Codecs | Thread | PSNR frames 0 / 197 / 60 / 393 (dB) | Control (dB) | lagMs | rmsDb |
|---|---|---|---|---|---|---|
| chromium (137236282964) | avc1.64001f + opus | worker | 41.22 / 40.38 / 41.19 / 40.87 | 34.86 / 30.86 / 32.17 / 33.27 | 0 | +0.0006 |
| chromium | vp09.00.31.08 + opus | worker | 41.69 / 40.86 / 41.72 / 41.45 | 34.99 / 30.91 / 32.20 / 33.37 | 0 | +0.0006 |
| firefox (137236282896) | avc1.64001f + opus | worker | 41.33 / 39.73 / 40.64 / 40.26 | 35.06 / 31.05 / 32.29 / 33.33 | 0 | −0.0068 |
| firefox | vp09.00.31.08 + opus | worker | 41.23 / 39.46 / 40.23 / 40.03 | 35.03 / 31.03 / 32.27 / 33.28 | 0 | −0.0068 |
| WebKit on macOS (137236283004) | avc1.64001f + mp4a.40.2 (priming 2112) | worker | 44.58 / 42.68 / 45.52 / 42.82 | 35.54 / 30.66 / 32.51 / 33.45 | −3.25 | −0.0100 |
| WebKit | vp09.00.31.08 + mp4a.40.2 | worker | 43.35 / 41.94 / 42.52 / 42.09 | 35.33 / 30.60 / 32.31 / 33.28 | −3.25 | −0.0100 |

- This box: Chromium H.264 43.0–45.2 dB, VP9 43.6–46.1; Firefox H.264 42.4–44.6, VP9 42.1–44.4; lag 0 everywhere.
- `mp4-mux` (CI v57): WebKit h264 + aac passes in both layouts, dev and prod (h264/vp9 + opus skipped: WebKit can't encode Opus). Chromium and Firefox: h264 + opus and vp9 + opus pass, dev and prod (h264 + aac skipped: no AAC encoder).
- Codecs for all 12 aspect/size/fps combinations (`video support` lines): H.264 High at levels 3.1–4.2. AAC on WebKit; Opus on Chromium and Firefox.

## M8 scope items (PLAN §12 "Video export (revision 11)")

| Item | Status | Evidence |
|---|---|---|
| Offline pipeline: the audio is the WAV export's render (same samples); frame k = `drawScore` at k / fps on an `OffscreenCanvas` in a worker where allowed, `VideoFrame` at k / fps | C+P | `video-export.spec` (rmsDb ≤ 0.01 against `renderMix`, lag 0 for Opus; `thread: "worker"` on all three engines in CI); "main-thread fallback makes the same video" (sizes within 5 %); `render/video.test.ts` "frame k is at k / fps…", "draws frame k at t = k / fps…", "is the same frame whatever was drawn before" |
| In-house MP4 muxer, no dependency: `moov` at the front (faststart), or streaming with the `mdat` size patched at the end | C+P | `mp4.test.ts`, `mp4-ffprobe.test.ts`, `mp4-mux.spec` (both layouts play). Streaming puts `moov` at the end with a positioned write for the `mdat` size, as the §12 Memory bullet allows. No fragmented MP4 |
| Progress and cancel as the other exports; closing the dialog cancels | C+P | `video-dialog.spec` Cancel and Escape (every close path calls `closeExport`, which aborts); `video-export.spec` cancel < 1 s. Progress labels by phase (audio / video / finishing; build log M8-d) |
| Codecs: H.264 High + AAC-LC 48 kHz stereo 192 kb/s by `isConfigSupported`; fallbacks VP9 and Opus in the same MP4 | C+P (gap 3) | `video-export.test.ts` "picks H.264 levels and VP9 levels…"; `video-export.spec` "every aspect, size and fps has codecs" and the forced-VP9 run on all three engines. Main and Baseline sit between High and VP9 (an addition) |
| No `VideoEncoder` (or no supported config), or no audio codec: says why and offers nothing | C+P | `video-dialog.spec` "without WebCodecs it says why and disables Export for video only"; `video-export.test.ts` "explains when WebCodecs is missing" |
| Aspects 16:9 1920×1080 (default), 9:16 1080×1920, 1:1 1080×1080; 720p-class option | C+P; legibility in 9:16: Owner | `render/video.test.ts` "gives the 1080- and 720-class pixel sizes", "lays 720p out exactly as 1080p, at two thirds the pixel ratio"; `video-frames.spec` per aspect (PNG attached); `video-dialog.spec` controls and defaults |
| 30 fps (default) or 60; bitrate from size and fps (~8 Mb/s at 1080p30) | C+P (gap 2) | `video-export.test.ts` "scales the bitrate with pixels and fps…"; `export-options.test.ts` defaults. Requested 8 Mb/s × pixels/1080p, ×1.5 at 60 fps; the encoders deliver less |
| Camera Follow (default: editor zoom window, playhead at 35 %, clamped at the ends) or Whole piece (fit; the playhead moves across a still view); time horizontal in every aspect, 9:16 gets more pitch height | C+P; motion smoothness: Owner | `render/video.test.ts` "follows with the playhead at 35 %, clamped…", "whole piece: the fitted piece at every t", "keeps layout px per second across aspects…", "fixes the vertical framing…", "is a pure function of t"; `export-options.test.ts` (Follow passes the editor window, Whole none); `video-dialog.spec` (window 5 after a zoom) |
| Theme (current, light, dark), HUD on, thickness on (off draws equal-width lines), future ghost as the player | C+P | `export-options.test.ts` (Current resolves the app theme); `render/video.test.ts` "player look: heads, canvas playhead, ghost 0.35…", the thickness tests; `video-frames.spec` "thickness off draws different, still non-empty frames" |
| No editor overlays; section labels as the player shows them | C+P | `render/video.test.ts` "…no editor overlays", "section labels and marker times as the player shows them" |
| Memory: stream to disk with `showSaveFilePicker` on Chromium; elsewhere a Blob, with a warning above ~1 GB estimated | C+P (gaps 6, 7) | `video-dialog.spec` "streams the MP4 to a file picked in the save dialog (Chromium)" (no download, ftyp, plays, size in the message); `export-run.test.ts` "video size follows the bitrate…" (the `large` flag at 1 GB); downloads on Firefox and WebKit in `video-dialog.spec` |
| Tail: runs to the piece's end plus the ring-out (the WAV export's length), last frame held | C+P | `render/video.test.ts` "covers the audio: ends within one frame after it", "…held at the piece end through the ring-out"; `video-frames.spec` tail held; `video-export.spec` frame 393 (in the tail) matches |
| Dialog: format "Video (MP4)", options, codec line, size estimate; choices remembered; phone fit | C+P | `video-dialog.spec` (8 tests) |
| Whether the defaults are right; how the videos look and move | Owner | Owner samples: `VIDEO_SAMPLES_DIR=<dir>` with `video-dialog.spec` "owner samples" writes Little Round at 16:9 and 9:16 (720p30 Follow) |

## Owner steps

1. Export Kite Day at the defaults (16:9 1080p30 Follow) from Chrome, and play it in QuickTime and on an iPhone. That file is H.264 + Opus (gap 3).
2. Export the same piece from Safari (H.264 + AAC), and from Firefox. Compare their sharpness with the Chrome file (gap 2).
3. Export a 9:16 video. Check that it is legible on a phone, and that the motion is smooth in Follow and in Whole piece.
4. Say whether the defaults are right: 16:9, 1080p30, Follow at the editor's zoom, the current theme, HUD on, thickness on.
