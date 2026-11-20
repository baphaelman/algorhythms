# Integrator handoff

This is for the Claude session that orchestrates AlgoRhythms. Read it top to bottom before acting.

Also read `CLAUDE.md` (rules and the status table) and `docs/build-log.md`, which records every decision, deviation and owner ruling. `PLAN.md` is the spec; read only the sections a task needs.

Last updated: 2026-11-20, by the first integrator session.

## Your role (the owner's standing instructions)
- **Don't write project code yourself.** Delegate all coding to builder subagents. You:
  - assign work;
  - verify the acceptance criteria (PLAN §15) by running tests and builds;
  - keep the pieces cohesive;
  - push;
  - report to the owner at milestones.
- You may edit PLAN.md (you own it), the CLAUDE.md status table, this file and the build log.
- **Builders default to Opus at medium effort** (owner instruction, 2026-11-20).
  - Go lower (Sonnet, low effort) only for tiny mechanical fixes.
  - Go higher (Opus high) only for subtle algorithm or DSP work, such as compiler bugs or the unison lock.
  - Pass `model` and `effort` explicitly on every spawn.
- **Be concise** with the owner, in prompts and in docs.
- **Offer a handoff at about 200k tokens.** When your own context passes that (a long session, many reports), tell the owner and offer to hand off:
  - update this file first;
  - then they start a fresh integrator session.
  - Background builders report only to the session that spawned them, so let in-flight builders report first, or note them here.
- **Keep tasks small: about one to three files each.**
  - Point builders at the exact PLAN sections and files they need, never "read all of §4–§7".
  - Tell them to stop and write up a stubborn bug rather than grind.
  - The first builders were given whole milestones and reached about 550k tokens each; the owner called that "very expensive and inefficient". Small tasks cost about 35–170k.
- **The owner wants speed** ("chop chop"). Run independent tasks in parallel when they touch different files. Sequence tasks that share files.
- **Run cheap checks yourself.** Don't spawn reviewer agents.

## Environment
- **Repo:** `/Users/raps/algorhythms`. Remote `origin` = https://github.com/baphaelman/algorhythms (public). The site is https://baphaelman.github.io/algorhythms/; the hidden test page is `/algorhythms/fixtures.html`.
- **Shell setup:** start every shell command with `eval "$(/opt/homebrew/bin/brew shellenv)"`. Node 22, pnpm and gh are installed, and gh is logged in as the owner.
- **Commits** use the placeholder author `AlgoRhythms builder <builder@algorhythms.invalid>`, which the owner chose to keep, plus a trailer naming the committing model.
- **Only the integrator pushes.**
- **How to push safely.** Builders leave uncommitted work in the tree, so verify the *committed* HEAD in a clean worktree, then push exactly that commit:
  ```sh
  WT=<scratchpad>/verify-head
  git -C ~/algorhythms worktree add --detach "$WT" HEAD   # or: cd "$WT" && git checkout --detach <sha>
  cd "$WT" && pnpm install --frozen-lockfile --prefer-offline && pnpm lint && pnpm typecheck && pnpm test && pnpm build
  git -C ~/algorhythms push origin <sha>:main
  gh run watch <id> --exit-status     # in the background
  ```
- **This Mac is often loaded, so timing tests flake.** The compiler perf guard is loose (100 ms); the strict 5 ms check runs only with `ALGORHYTHMS_PERF_STRICT=1`.

## Milestone state
| Milestone | State |
|---|---|
| M0 | Done. CI is green on Chromium, Firefox and WebKit; the Pages deploy works. |
| M1 compiler | Done; the owner said the generated pieces "sound lovely". Open: about 16 ms compile against 5 ms (deal with it in M4: a worker or incremental compile); about 2 unresolved crossings per thousands of pieces, both involving newborns from a split (reported as diagnostics, written up in the build log); the compiler should extend the final hold to `died` (noticed by the MIDI builder). |
| M2 sound | Built and verified. Owner feedback has been folded in (choir, unison). Known gap: expo and bezier glides allocate on the audio thread (fix in M6: precompute those segments on a 128-frame grid). |
| M3 | Renderer (M3a) and MIDI (M3b) are done. Stems (M3c), the player app (M3d1) and the unison lock are in flight (below). Not started: M3d2. |
| M4–M7 | Not started. |

Last pushed and CI-verified commit: `7e1c9e8`, after the choir rework.

## In flight when this handoff was written
Their reports go to the old session. If you don't have them, check `git log`, `git status` and the build log.

1. **M3c stems export: DONE** (commit `90d8c54`; 18 unit tests verified).
   - **Results:**
     - residual −144 dBFS in Node and −142.6 in all three browsers;
     - peak memory +53 to +78 MB for 5 min × 24 voices streamed to disk;
     - fflate can't write ZIP64, so there's an in-house streaming ZIP64 writer, `src/audio/zip.ts`.
   - **API for M3d2:** `src/audio/stems-client.ts`.
     - `exportStems(score, mix, opts)` returns `{blob|null, bytes, entries, zip64}`.
     - `estimateStemsSize(...)` gives the exact size plus a `large` flag above 1 GB.
     - `canSaveToDisk()` and `pickStemsFile(name)`: call the picker from the click handler and pass the handle as `target`.
     - Options: sampleRate, bitDepth 16/24/32 (default 32f), mono, voiceNames, onProgress, signal.
     - **Lazy-load it**, because it pulls in the DSP graph.
2. **M3d1 player app: DONE (committed; not yet verified in a clean worktree).**
   - **Results:**
     - e2e passed on all 6 projects before the DSP edits;
     - the 4 Chromium-dev failures came from the unison builder's half-edited `graph.ts`, so re-verify after it lands;
     - 16.7 ms frame interval with 0.8 ms work per frame;
     - first sound 300–650 ms in prod.
   - **API for M3d2 (in `src/app/store.ts` and `audio.ts`):**
     - the `usePlayer` store `{piece, compiled, view, transport, notices}`;
     - `loadPiece(piece)` for a fresh open and `setPiece(piece)` for an edit (coalesced recompile, then swap);
     - `getEngine()` and `whenReady()`;
     - `pushNotice`;
     - the share helpers in `share.ts`;
     - empty layout slots `[data-slot=lane]` and `[data-slot=inspector]` for M4.
   - **Deleted** M0's test-tone files.
   - **Parallel e2e:** `playwright.config.ts` now takes `E2E_DEV_PORT`, `E2E_PROD_PORT` and `E2E_OUT_DIR`. Give parallel builders distinct values plus `--output=<dir>`, or their runs collide.
   - **Owner questions:**
     - The app uses system fonts instead of the prototype's IBM Plex from Google Fonts (to avoid third-party requests). Bundling Plex would be a dependency.
     - The iPhone silent-switch check needs the owner's device.
   - Screenshots are in `renders/app-screenshots/`.
3. **Unison lock + `wobble` preset** (Opus high): `src/dsp/**` and timbres.
   - **Asked for:** steady converged voices by default (phase lock or equivalent), group-aware normalisation, no clicks, stems still exact, RTF ≥ 10×, an opt-in timbre wobble control and a `wobble` preset.
   - Owner A/B WAVs go in `renders/` (`unison8-*`, `merge-*`, `wobble-preset`, `gen-1-dorian-after`).
   - The design goes in the build log under "Unison lock". **Then you update PLAN.md §8.4 and P2** to match.
   - **Handoff:** at 300k tokens this builder was told to stop and write "Unison lock (handoff)" in the build log. Finish the work with a fresh agent (Opus; medium, or high if the remaining work is subtle) that starts from that note.

## Next tasks (queued)
- **Compile option `crossings: 'allow'`** (Sonnet medium, `src/core/compiler`): skips crossing enforcement.
  - The owner wants it **only as a temporary dev toggle**, never a Piece field. They expect not to need it.
- **M3d2** (Sonnet high, `src/app`, after M3d1 and M3c):
  - Generate panel (seed, mode, length, voices, density; uses `generate()`);
  - Export dialog: WAV (16/24/32f, 44.1/48), stems (size estimate, >1 GB warning, progress and cancel, `showSaveFilePicker` on Chromium), MIDI (per-voice / MPE / notes-only, bend range, CC11, zip when there are several files);
  - a temporary dev panel with the crossings toggle.
- **Then M3 acceptance:**
  - Playwright on all three engines;
  - 60 fps;
  - first sound ≤ 3 s;
  - stems residual;
  - stems memory;
  - **owner device checks:** an iPhone with the silent switch on, and MIDI in FL Studio once the owner has it. Until then, MIDI is verified by the automatic round-trip tests, as the owner agreed.
- Then push, and announce the first public release to the owner.
- **Later backlog:** the expo/bezier allocation fix (M6); choir ideas from the builder (breath noise in M6, two oscillators per voice, formants per register, more partials for bass); the compiler perf work (M4).

## Waiting on the owner
- **Choir A/B:** `renders/choir-before.wav` / `choir-after.wav`, also `reed-before` / `reed-after`.
- **The fixture page on the live site** (deployed with `7e1c9e8`): click checks, and the presets.
- **Unison and wobble A/B** WAVs once that task lands.
- **Roman numeral convention:** numerals are read against the major scale (in A dorian, `III` = C♯ major; write `bIII` for C). The owner hasn't replied; keep it unless they object.

## Owner rulings so far (details in the build log)
- **§16 answers:** MIT; time in seconds with an optional BPM grid; no DAW yet (FL Studio later); GitHub Pages; the name is AlgoRhythms (plural) everywhere; 32 voices; M3 before the editor.
- **Line crossing:** add the option as a temporary toggle only.
- **Unisons and merges:** steady by default; wobble becomes its own opt-in sound and preset.
- **Choir:** was "goofy, robotic" and has been reworked; awaiting the owner's ears.
- **MIDI:** per-voice tracks skip channel 10 (integrator call).
