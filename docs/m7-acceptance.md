# M7 acceptance audit (2026-11-22, base `main-7glpov` bbe1583)

Scope: PLAN §15 M7 (musical typing mode, Web MIDI input, live voice leading with no debounce delay, the live panel, the 'interactive' context, recording into silence with chord merging), plus §9 Live instrument mode. CI evidence is from v52 (`main` 446b30c), which passed every job.

**New test (this audit):**
- `tests/e2e/live-context.spec.ts`: opening the Live drawer and arming Record each create an AudioContext with `latencyHint: 'interactive'`; after the drawer closes, Play creates a `'playback'` one. Before this, no test checked the hint.

**Runs on this tree (`--maxWorkers=2`, `--workers=1`):**
- lint and typecheck are clean.
- Unit and dsp: `live`, `live-fill`, `live-grace`, `live-take`, `live-take-moments`, `live-take-random` (dsp); `core/live`, `app/typing-keys`, `app/midi-input` (unit). 164 passed, 1 skipped (the measured-seeds test, which runs only with `LIVE_TAKE_SEEDS`), 9 files.
- Measured seeds (`LIVE_TAKE_SEEDS=73-372`, about 11 min): 2 of 300 seeds miss (gap 2).
- E2E, chromium-dev and chromium-prod: `live` (@latency included), `live-drawer`, `live-record`, `musical-typing`, `live-context`. 18/18 passed.
- Firefox and WebKit are not installed on this box. For those engines, the evidence is CI v52.
- The full `pnpm test` and `pnpm test:perf` were not run here. The build log's last M7 entry has them passing: 2445 passed, and test:perf 11/11 with the live no-GC run at 1976 B.

Status key: **C+P** covered and passing; **Part** partly covered; **None** not covered; **Owner** needs the owner's ears or hands.

## Gaps and findings (read first)

1. **Being fixed (another builder, in parallel):**
   - Play is a no-op while live.
   - Notes-drawer edits (gain, timbre) don't reach the live engine.
   - Opening another piece while live keeps the old live voices.
2. **Known take/live edge (not gating).** 2 of the measured random seeds 73–372 miss: 116 (stagger 0.12, random order; worst 30.1 c, 6 missed blocks) and 181 (octaves; worst 65.4 c, 15 missed blocks). This was measured here: 2 of 300 seeds miss, the same as in the build log. The cause is the same for both (build log "M7: line identity"). A key lands within MIN_GLIDE + CLOSE_GAP (11 ms) of the end of a fade release. The take's re-establishing `merge` then starts before the fade ends, so for about 10 ms it re-targets lines that are still gliding. Live keeps those lines on their glide. All of this happens in the fade's tail, at −30 dB or lower. Seeds 1–72 and every scripted take gate at 0.0000 c and ≤ 1 block.
3. **"Device output latency" includes one device callback, and Firefox's own output latency is not checked.** The gate is total − device ≤ 10 ms, with device = min(outputLatency, timestamp lag) + the measured callback period. On Firefox the output timestamp carries no lag, so device is the callback alone (17–20 ms). The gate therefore proves only that the glide is rendered within 10 ms plus one callback; the time the device takes to play it is unmeasured. WebKit reports outputLatency 0, so it is gated the same way. A note that misses the callback in progress starts with the next one, and this is counted as device latency (build log "Live latency gate on Firefox").
4. **Deviation from §9, within the 15 ms window.** §9 says a chord press is re-targeted through the interruption rule with carried velocity. Since M7-c, keys within 15 ms re-plan the press from its first key (`LiveTracks.rewind`), so a key-by-key chord plays exactly as the one chord the take records. Two consequences, both excluded from the gate:
   - From silence, the first key sounds alone, at attack level, for ≤ 15 ms.
   - On a fast glide, the heard path inside a press window can differ from the take by up to 32 cents, for ≤ 10.7 ms.
5. **Not recorded:** pitch bend (no moment holds it) and note velocity (logged on the event but not voiced). A partial release re-targets 60 ms late (the release grace), and the take records it where it sounded.
6. **Main thread at 6× CPU throttling:** call → post has a median of 1.4–1.9 ms. The max is not ≤ 2 ms: it goes up to 13–20 ms, the same as a bare busy loop shows under the throttler. The gate is ≤ 5 ms unthrottled; CI's max is 2 ms (WebKit).
7. **WebKit skips** `musical-typing`, `live-record`, `live-drawer` and `live-context` (deliberately: "Chromium and Firefox are enough"). On WebKit only `live.spec` runs (latency, enter, exit).

## §15 M7 acceptance lines

| Criterion | Status | Evidence |
|---|---|---|
| Key-to-glide start ≤ 10 ms plus device output latency | C+P (gap 3); feel: Owner | `tests/e2e/live.spec.ts` @latency: 12 notes per run. Gated on every note: `frame = receivedFrame`, engine ≤ 10 ms + callback, total − device ≤ 10 ms, call → post ≤ 5 ms. CI v52 (446b30c), quoted below; this box below that |
| A recorded take plays back with pitch paths matching the live ones within 1 cent and 1 block | C+P (gaps 2, 4) | `dsp/live-take.test.ts`: scripted take (silence, key-by-key chords, re-targets mid-glide, hold, tonic and fade releases, re-entry, sustain), glide settings (stagger and order, range voicing, linear ease), split of a doubled line mid-glide, staggered releases in each release mode, partial release with a press during the grace. All at 0.0000 c, 0 misses. `live-take-random.test.ts`: seeds 1–72 gate, each at ≤ 1 cent and ≤ 128 frames with no miss. `live-fill.test.ts` "plays back as played". `live-take-moments.test.ts`: a key 14.9 ms after the first joins its press, 15.1 ms starts a new one. E2E `live-record.spec.ts`: a take armed at 30 s compiles equal to the live pitches within 1 cent at 6 settled times; a chord on 1 voice filled to 4 plays back; Play plays the take |
| No editor shortcut fires from a letter key while musical typing is on | C+P | `musical-typing.spec.ts` "while musical typing is on, no editor shortcut fires from a letter key": a–z and Shift+A–Z, with a selection. The piece JSON, moment count, selection and undo label are unchanged; C4 and C5 played; nothing held after. With the mode toggled off by `` ` ``, C adds a moment. `unit/app/typing-keys.test.ts` "with the mode on, every letter is taken…", "letters without a note are taken too", "Space, Escape, Delete, arrows and ⌘/Ctrl/Alt chords stay editor keys", "text fields keep their keys". Every single-letter shortcut (`editor/shortcuts.ts`: C U S M T P W R E O I K L B, and N-held) is a letter in that sweep |

**Latency, CI v52 (`live latency (…)` lines; dev run first, then prod):**

- chromium (job 137179741035, ubuntu):
  - `live latency (12 notes, 44100 Hz, baseLatency 11.6 ms, outputLatency 32.0 ms, callback 11.6–11.6 ms, timestamp lag 31.3–52.2 ms): engine median 0.0 / max 2.9 ms; key → heard median 41.9 / max 51.4 ms; beyond device latency median -4.0 / max 0.9 ms; call → post median 0.30 / max 0.90 ms`
  - `live latency (12 notes, 44100 Hz, baseLatency 11.6 ms, outputLatency 48.0 ms, callback 11.6–11.6 ms, timestamp lag 43.0–55.9 ms): engine median 0.0 / max 0.0 ms; key → heard median 46.7 / max 53.9 ms; beyond device latency median -3.1 / max -0.5 ms; call → post median 0.30 / max 1.00 ms`
- firefox (job 137179740806, ubuntu):
  - `live latency (12 notes, 44100 Hz, baseLatency 0.0 ms, outputLatency 39.8 ms, callback 17.4–20.3 ms, timestamp lag -0.0–-0.0 ms): engine median 0.0 / max 0.0 ms; key → heard median 13.0 / max 17.0 ms; beyond device latency median -4.4 / max -1.4 ms; call → post median 0.00 / max 1.00 ms`
  - `live latency (12 notes, 44100 Hz, baseLatency 0.0 ms, outputLatency 37.2 ms, callback 17.4–20.3 ms, timestamp lag -1.0–-0.0 ms): engine median 0.0 / max 0.0 ms; key → heard median 10.0 / max 13.0 ms; beyond device latency median -7.4 / max -5.4 ms; call → post median 0.00 / max 1.00 ms`
- WebKit on macOS (job 137179741012):
  - `live latency (12 notes, 48000 Hz, baseLatency 2.7 ms, outputLatency 0.0 ms, callback 2.7–2.7 ms, timestamp lag -3.0–0.0 ms): engine median 2.7 / max 5.3 ms; key → heard median 0.7 / max 4.3 ms; beyond device latency median -2.0 / max 1.7 ms; call → post median 1.00 / max 1.00 ms`
  - `live latency (12 notes, 48000 Hz, baseLatency 2.7 ms, outputLatency 0.0 ms, callback 2.7–2.7 ms, timestamp lag -3.0–0.0 ms): engine median 2.7 / max 8.0 ms; key → heard median -0.7 / max 6.3 ms; beyond device latency median -3.3 / max 3.7 ms; call → post median 1.00 / max 2.00 ms`
  - v51 (5d4dea4) failed here: one note per run was 72–381 ms late to the ear, with engine ≤ 2.7 ms, which points to an audio-clock stall. In v52 no note's `slip` exceeds 2.0 ms, and the largest key → heard is 6.3 ms.
- **Worst beyond device latency across CI:** 0.9 ms (chromium), −1.4 ms (firefox), 3.7 ms (WebKit), against a limit of 10.
- **This box** (chromium, pulseaudio null sink): dev beyond-device max −0.1 ms, engine max 2.9 ms; prod max −0.9 ms, engine max 0.0 ms; call → post max 0.8 ms.

## M7 scope items

| Item | PLAN | Status | Evidence |
|---|---|---|---|
| Musical typing layout `A W S E D F T G Y H U J K`; `Z`/`X` octave | §9 Inputs | C+P | `typing-keys.test.ts` "A W S E D F T G Y H U J K play C up to the next C", "Z/X shift the octave within the limits", "keys are read by position (code)…"; `musical-typing.spec` "octave keys, key repeat, blur…" |
| A mode: transport button or `` ` ``, clear indicator, on by default only while the Live drawer is open | §9 | C+P | `typing-keys.test.ts` "` toggles the mode"; `musical-typing.spec` (Typing button `aria-pressed`, "Typing C4" indicator, off by `` ` ``, turned off on close; a note key with typing on and the drawer closed opens the drawer and plays) |
| Space, Escape, ⌘/Ctrl shortcuts still work while it is on | §9 | C+P | `typing-keys.test.ts` "Space, Escape, Delete, arrows and ⌘/Ctrl/Alt chords stay editor keys"; `musical-typing.spec` (⌘/Ctrl-Z undoes); `live-record.spec` (Space and Escape stop a take) |
| Piano ruler as an input | §9 | C+P | `live-drawer.spec` (press, drag key to key, release, `data-held`) |
| Web MIDI on Chromium and Firefox; Firefox add-on help; Safari falls back to the keyboard | §9 | C+P (fake MIDI); real device: Owner | `unit/app/midi-input.test.ts` (parser: velocity 0, running status, real-time bytes, SysEx; hub; connect, unplug, select, feature detection); `live-drawer.spec` (fake MIDIAccess: velocity, pedal, mod wheel, bend, unplug; help text names the add-on and "Safari has no Web MIDI"). The Firefox add-on prompt and a real keyboard are Owner |
| Held set H is the live target; no debounce; chord press within 15 ms | §9 Behaviour | C+P (gap 4) | `core/live.test.ts` (targets for each setting); `dsp/live.test.ts` "apply on the next block, at its first frame…", "a chord pressed key by key within 15 ms plays as the chord from its first key", "a key beyond 15 ms re-targets mid-glide, carrying velocity" |
| Recording merges notes within 15 ms into one moment | §9 Recording | C+P | `live-take-moments.test.ts` "a key 14.9 ms after the first joins its press; 15.1 ms starts a new one"; `live-record.spec` (a 3-note chord recorded as one `chord` [60, 64, 67]) |
| \|H\| = 1 unison or octaves; \|H\| > 1 exact notes or across the range | §9 | C+P | `core/live.test.ts` "\|H\| = 1, unison", "…octaves", "\|H\| > 1, exact…", "…range"; random takes cover every mode |
| Release: hold, fade or return to the tonic | §9 | C+P | `core/live.test.ts` release tests; `live-grace.test.ts` (60 ms grace in each mode, the boundary at 22 and 23 blocks, sustain); `live-take.test.ts` staggered releases |
| Glide length, stagger and order from the live panel | §9 | C+P | `live-drawer.spec` "settings reach the engine"; `live-record.spec` (stagger 0.1 and low-first carried into the take's moments); `core/live.test.ts` "glide, stagger and order come from the settings" |
| CC1 sets the glide length; CC64 holds; pitch bend ±2 semitones, continuous | §9 | C+P | `core/live.test.ts` "CC1 sets the glide length exponentially", "bend is ±range…", "keys and the pedal"; `midi-input.test.ts` CC and bend; `dsp/live.test.ts` "bend shifts every voice continuously"; `live-drawer.spec` (mod wheel moves the slider) |
| Engine path: main-thread mirror, the core voice leading, the worklet stamps the frame | §9 Engine path | C+P | `dsp/live.test.ts` "the mirror equals the worklet after a rapid session (compaction included)", "glides start at the stamped frame…"; no-GC `live` run (test:perf, build log: 1976 B, 0 GC) |
| Live panel (Live drawer) | §15 | C+P | `live-drawer.spec` (open → live, settings, MIDI picker and status, live lines drawn, close → playback) |
| The switch to an 'interactive' context | §9 Latency, §15 | C+P (new) | `live-context.spec` (Live drawer and Record: 'interactive'; after closing, Play: 'playback'); `live.spec` (enter closes the playback context; exit closes the live one and a new playback engine loads) |
| Worklet latency ≤ one block plus message latency | §9 Latency | C+P | `live.spec` `frame = receivedFrame` on every note (CI, all three engines); `dsp/live.test.ts` "apply on the next block, at its first frame" |
| Record into silence: the transport runs, moments at their times with the glide settings, ordinary editable moments | §9 Recording | C+P | `live-record.spec` (arm at T₀, the playhead runs, `merge`, establishing chord, unison and chord at the stamped times with glide settings; one undo restores the piece exactly, redo; Escape, Space and close stop; an empty take changes nothing); `live-take.test.ts` `takeBase` |
| No layering over playback (v1) | §9, §17 | C+P | `takeBase`: moments at T₀ and later are removed and every line has died by `silentFrom` (`live-take.test.ts` "a take into a sounding piece…") |
| Voices filled to 4 when fewer sound | build log M7 | C+P | `live-fill.test.ts`; `live-record.spec` (1 voice filled to 4) |
| Play, Notes-drawer edits, opening another piece while live | §9 / §11 | Part (gap 1) | Being fixed |
| Playing with a real MIDI keyboard; the feel of latency and glides | §9 | Owner | — |

## Owner steps

1. Open the Live drawer on Kite Day and play with the computer keyboard: single notes, chords, Z/X. Check that the response feels immediate.
2. Connect a MIDI keyboard (on Firefox, the site-permission add-on prompt appears). Try the mod wheel (glide), the sustain pedal and pitch bend.
3. Record a take of a few chords, stop, close the drawer and press Play. The playback should sound as you played it.
