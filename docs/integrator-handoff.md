# Integrator handoff

This is for the Claude session that orchestrates AlgoRhythms. Read it top to bottom before acting.

Also read `CLAUDE.md` (rules and the status table) and `docs/build-log.md`, which records every decision, deviation and owner ruling. `PLAN.md` is the spec; read only the sections a task needs.

Last updated: 2026-11-20, fourth integrator session (M4 done).

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
- **Compact at about 200k tokens (owner, 2026-11-20; replaces the fresh-session handoff).** When your context passes that:
  - bring this file, the build log and the CLAUDE.md status up to date first (they are the durable memory; the summary is lossy);
  - ask the owner to type `/compact`, giving a ready-to-paste `/compact <what to keep>` command (owner, 2026-11-20): push state, in-flight builders, open owner questions;
  - the session continues, so in-flight builders still report to it.
  - A fresh session is still fine when the owner prefers one; this file is written for that case too.
- **Keep tasks small: about one to three files each.**
  - Point builders at the exact PLAN sections and files they need, never "read all of §4–§7".
  - Tell them to stop and write up a stubborn bug rather than grind.
  - The first builders were given whole milestones and reached about 550k tokens each; the owner called that "very expensive and inefficient". Small tasks cost about 35–170k.
- **The owner wants speed** ("chop chop"). Run independent tasks in parallel when they touch different files. Sequence tasks that share files.
- **Run cheap checks yourself.** Don't spawn reviewer agents.

- **Owner messaging (2026-11-20):** one line each time a builder returns; otherwise message only for a decision or something they can see. Give local demo links (dev server via `preview_start algorhythms-dev` → http://localhost:5180/algorhythms/) instead of waiting for the CI deploy.

## Environment
- **Repo:** `/Users/raps/algorhythms`. Remote `origin` = https://github.com/baphaelman/algorhythms (public). The site is https://baphaelman.github.io/algorhythms/; the hidden test page is `/algorhythms/fixtures.html`.
- **Shell setup:** start every shell command with `eval "$(/opt/homebrew/bin/brew shellenv)"`. Node 22, pnpm and gh are installed, and gh is logged in as the owner.
- **Commits** use `Claude <noreply@anthropic.com>` via `git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit` (owner switched 2026-11-22; never change the git config, never rewrite older placeholder-author commits), plus a trailer naming the committing model.
- **Only the integrator pushes.**
- **How to push safely.** Builders leave uncommitted work in the tree, so verify the *committed* HEAD in a clean worktree, then push exactly that commit:
  ```sh
  WT=<scratchpad>/verify-head
  git -C ~/algorhythms worktree add --detach "$WT" HEAD   # or: cd "$WT" && git checkout --detach <sha>
  cd "$WT" && pnpm install --frozen-lockfile --prefer-offline && pnpm lint && pnpm typecheck && pnpm test && pnpm build
  git -C ~/algorhythms push origin <sha>:main
  gh run watch <id> --exit-status     # in the background
  ```
  `pnpm test` skips the timing/GC gates (rtf, no-gc, compiler-perf); run `pnpm test:perf` alone, on a quiet box, only when DSP or compiler code changed. CI runs both (build log "Timing gates split from `pnpm test`").
- **This Mac is often loaded, so timing tests flake.** The compiler perf guard is loose (100 ms); the strict 5 ms check runs only with `ALGORHYTHMS_PERF_STRICT=1`.

## Merge routine in the cloud (this session)
- `git merge --no-edit <branch>` aborts silently if the tree is dirty: commit doc edits first and check the merged files exist (once a commit was titled "Merge M4.5-12" with only a PLAN change; fixed by 694709e).
- build-log conflicts: strip the conflict markers (keep both sides), `git add`, commit.
- Verify in `<scratchpad>/verify-head` (detached worktree): lint, typecheck, test, build; add `pnpm test:perf` (run alone) when DSP or compiler code changed. Other unit timeouts under load: rerun alone. `render.spec` 4 ms budget always fails on this box (software raster); CI's guard is 12 ms.
- E2E here: `PLAYWRIGHT_BROWSERS_PATH=<scratchpad>/pw` (symlinks Chromium 1243 as the 1255 Playwright wants; Firefox 1572 installed there via the "algorhythms" cloud environment, which allows Playwright's download hosts). Audio specs need a sink: `apt-get install -y pulseaudio; pulseaudio --start --exit-idle-time=-1; pactl load-module module-null-sink sink_name=ci_null; pactl set-default-sink ci_null`. WebKit runs only on CI (macOS).
- CI skips docs-only pushes (`paths` in ci.yml, M4.5-19), so batch doc commits freely.
- After each push, rebuild and republish the preview artifact (see "Demo links").
- Owner: one line per builder return; commit as Claude <noreply@anthropic.com> with per-command `-c` flags (owner, 2026-11-22).

## Working notes
- **Check your own context size.** You can't run `/context`, but `mcp__ccd_session_mgmt__get_usage` (session `"self"`; load it with ToolSearch) returns `context.tokensUsed`. Call it after each builder report or push. At about 180k, update the docs and ask the owner to `/compact` without being asked (the second integrator overran to ~250k and the owner had to flag it). Keep context lean: headless checks and DOM reads instead of screenshots; test output to files.
- **Ping the owner only when something they can test changes** (a deploy with new features, WAVs to hear, a device check) or a decision is needed. No progress narration (owner, 2026-11-20).
- **Builders run only their own e2e specs**, so a feature can break an older spec (this happened with the menu placeholders). Before pushing app work, have one builder run the whole e2e suite on the merged tree.
- **Integrating builder branches:** `isolation: worktree` builders branch from **origin/main** (the last push), not local main, so tell a builder to `git merge` a local branch first when it needs unpushed work. Merge finished branches into local main yourself. Their `docs/build-log.md` appends always conflict; keep both sides. A fixture recorded on an older base can need re-hashing after a merge (happened with the generate snapshot).
- **Local e2e is muted** (`--mute-audio` on Chromium, `media.volume_scale` 0 on Firefox). WebKit can't be muted, so it runs locally only with `E2E_WEBKIT=1` (CI always runs it). The owner heard tests playing before this; keep audio off.
- **Builder worktrees live in `.claude/worktrees/`** inside the repo, so `pnpm lint` (prettier) in the main checkout trips on their files. Use the clean verify worktree for checks, or add `.claude/` to `.prettierignore` and the ESLint ignores (small task, not done).
- **Push routine that worked:** merge into local main, check out the HEAD in a clean worktree in your scratchpad (`git worktree add --detach`), run lint, typecheck, test, build and `pnpm e2e` (with distinct `E2E_*` ports), re-run load-sensitive failures alone (rtf, compiler-perf, no-gc, stems timeouts flake on this Mac), then push the sha and watch `gh run watch <id> --exit-status` in the background. The deploy is live when the Pages job passes; confirm the bundle hash with curl.

## Milestone state
| Milestone | State |
|---|---|
| M0 | Done. CI is green on Chromium, Firefox and WebKit; the Pages deploy works. |
| M1 compiler | Done; the owner said the generated pieces "sound lovely". Open: compile ~8–10 ms against 5 ms after M4a (strict test: 9.7 ms at load 9.5); incremental compile is the next step; about 2 unresolved crossings per thousands of pieces, both involving newborns from a split (reported as diagnostics, written up in the build log); the compiler should extend the final hold to `died` (noticed by the MIDI builder). |
| M2 sound | Built and verified. Known gap: expo and bezier glides allocate on the audio thread (fix in M6: precompute those segments on a 128-frame grid). |
| M3 | Feature-complete and live: renderer, MIDI, stems, player, Generate (30–900 s), Export dialog, by-pitch colours, HUD chord, unison lock + `wobble` preset. PLAN rev 3 records the lock. No release announcement (owner, 2026-11-21). Next milestone: M4 editor. |
| M4 | Done (2026-11-20). M4a–M4k merged and pushed: compiler speed-up, editor API, persistence, lane, inspector, palette + shortcuts + drag from palette, voices drawer, selection highlight, incremental compile (M4j), polish (M4k). All §15 acceptance checks pass (build log "M4 acceptance checks"; edit → swap 12–43 ms). |
| M4.5 editor view | Approved 2026-11-20; PLAN rev 6 + rev 7 (owner notes 11-21, many via preview-artifact comments). Merged + pushed: 1–22, 24 (octaves before unisons). In flight: 23 score selection + grouped note changes (`note.changes`, "Shift"); 26 open-ended canvas; 29 distinct notes + weights (PLAN rev 8; core/dsp). splitStacked cancelled. Queue: 25 future always dimmed in editor + UI says "notes" (after 23); 27 the start is a moment, schema v2 (after 23 + 29); rare property seeds (build log) after 29; 28 Compose for me in New (after 27); then full e2e (chromium + firefox here) and M4.5 acceptance. Open owner question: should plain chords (no count) also prefer octaves? |
| M5–M7 | Not started. |

## Running in the cloud (owner, 2026-11-20)
The owner moved the integrator to a cloud session to use it from their phone. Linux, 4 cores; repo `/home/user/algorhythms`; `git push origin <sha>:main` works (owner OK); `gh` isn't authenticated, so watch CI with the GitHub MCP tools (`mcp__github__actions_list`). **Demo links from the cloud:** the owner wants a link right away, not after CI. Build with `ALGORHYTHMS_BASE=./ pnpm exec vite build --outDir dist-art --sourcemap false`, drop fixtures.html and its chunk, and publish index.html plus `assets/*` with the Artifact tool (`files` map), republishing the same file path to keep the URL (https://claude.ai/artifact/PkiBVk62JzhoWUaqqDKGgJ). There: no Homebrew (skip the `brew shellenv` lines); localhost demo links don't reach the phone, so the demo is the Pages deploy after a push; check whether `gh` is authenticated before relying on it.

## Cloud session (2026-11-21, moved from the desktop)
- **Owner: no messages until there is a build to show** ("keep your messages to nothing until there is a build to show me, so coming back I see the most recent one"). Work silently; the next message is the new preview/deploy.
- Push target per the cloud harness: `main-7glpov` (session branch) plus `origin <sha>:main` for deploys (owner OK, above).
- **v35 never deployed:** CI on 8106972 failed `pnpm test`: `render-golden` hashes differ on Linux x64 vs the Mac (merge/crossfade pieces). Builder `fix-golden-platform` (from 042abf8) is making the render portable.
- The desktop's in-flight builders (M6-b, split-knot render fix) were lost in the move; restarted here.
- **Pushed 1b6ee64 to main** (= preview version 36; CI green, Pages deployed): portable DSP math (`src/dsp/pmath.ts`, goldens re-pinned on Linux; owner confirmed they pass on the Mac). Local since: M6-b1 timbre moment core, M6-b3 its UI (palette B, Effects row, Sound drawer rename/delete), split-knot fix (`render/ghost.ts`). Verify 0754b7a: unit 1803/1803, chromium e2e 476/477 (render 4 ms budget, known on this box). Firefox isn't installed here; CI covers it. Held from main until M6-b2 (timbre crossfade DSP, running) lands, so the public site doesn't get a silent timbre moment.
- **Queue (owner, 2026-11-21 cloud):** bell redesign (running; candidates to the owner); tune "Melody on" picker (running, branch tune-line); then, on top of tune-line: tune makes a random melody (inspector button + new tunes start with one), and with a tune selected, double-clicking its line on the score adds a tune note there. Then M6 master FX, M6 acceptance.
- **Pushed a5cefbf to main** (preview version 38): M6-b timbre moments (v37), knot fix, Next always holds a bar / 2 s after the last end, playhead labels show Hz only.
- **State 2026-11-21 late:** another owner session pushed the second compositions set + Roman numeral ruling straight to origin/main (c6de72d); merged into main-7glpov (405bf4f). main-7glpov is ahead of main with M6 master FX (held: some mix jumps click), short-score fix. Running: fx-smooth (click-free FX changes), score-min-height (score never shorter than its paddings), melody-move (Melody on transposes the tune + hover highlights the line), blank-template (New → Blank: no opening note, key moment selected with the inspector open; first moment always at 0:00). Push all together as the next version.
- **Queue after that:** M6 acceptance audit (PLAN §15 M6); then the owner-liked suggestions in docs/composing.md §3 (1–11), smallest/most useful first: 10 numeral hint, 2 root in the bass, 3 tune rests/re-strike/transpose with key, 4 parts start from silence + warning, 6 range folding must not merge, 9 pulse note order, 8 multi-part targets, 1 progression moment, 5 walk chord tones, 7 pulse envelope drawing, 11 smaller.
- **CI has been red on main since 3ba6f0c (v37)**; Pages still serves 1b6ee64 (v36). test:perf fails on ubuntu-latest: RTF M6 workload 6.8–9.9× (gate 10×), plain 9.65× once, no-GC fx budget (since fx-smooth); Firefox first-sound 3.37 s > 3 s once. Builder `perf-gates` (from bcfcf3a) is on it. **Lesson: after every push to main, check the CI run (curl the public API: `/repos/baphaelman/algorhythms/actions/runs?branch=main`, then `/check-runs/<job>/annotations` for messages) before telling the owner it's live.**
- **State 2026-11-22 ~11:00:** main = 446b30c (v52: M7 recording, live = take match, release grace, voice fill, main-thread post-first + per-note latency log). v51 (5d4dea4) failed CI WebKit @latency (one note 72–381 ms late; engine side fine) so Pages still serves v50; v52 CI running (lint/unit/firefox green) — if WebKit fails again, read the per-note `slip` in the job log (`curl -sL https://api.github.com/repos/baphaelman/algorhythms/actions/jobs/<id>/logs`): slip ≈ lateness means WebKit's audio clock stalled (likely our worklet too slow on a press in JSC: check rewind/compaction cost). main-7glpov 32f18f3 adds claude/blissful-archimedes-s6qupa (weights stay within their voices; owner must listen: Cartographers' Rain 94 s+, Tide Pools 70 s+); unit + perf pass; full chromium e2e running (`<scratchpad>/e2e-v53.log`) → push v53, republish preview. Other sessions: list them with mcp list_sessions; message with send_message. M7 left: WebKit latency outcome; write docs/m7-acceptance.md (3 lines; known edge: key within 11 ms of a fade end, 2/372 random seeds, ≤ −30 dB); leftovers (Play no-op while live; Notes-drawer edits don't reach live; opening another piece while live keeps old voices). Owner dropped the iPad check. After M7: ask owner which 'Later' item first.
- **State 2026-11-22 ~08:30:** main = f8c8baf (v50: Live drawer, typing, MIDI; CI all green, Pages live). main-7glpov c22605a adds M7-c recording (not yet e2e'd as a whole). Commit author is now Claude <noreply@anthropic.com> (owner). Running from 99cddd2 (`m7-live-match`, M7-d partial: live ports the compiler's planner rules): `m7d-match` (not-yet-born forks, remaining random seeds, test:perf; ports 5297/4297) and `live-grace-fill` (60 ms release grace, fill live voices to 4; ports 5298/4298). Then merge both + 99cddd2 into main-7glpov, full e2e, push v51 with recording, update docs/m7-acceptance (write it), owner preview.
- **State 2026-11-22 ~05:45:** main = eb72891 (preview v48; CI lint/unit/firefox/webkit green, chromium + Pages pending). main-7glpov 156cfaa adds: claude/youthful-mendel (forks take parent's level; tide-pools golden re-pinned), silence-level (parentless births start at level 1; no piece changes), M7-a merged (live engine; latency ≤ 10 ms). Full chromium e2e running (`<scratchpad>/e2e-v49.log`) → push as v49. Running: M7-b (`m7b-live-inputs`: Live drawer, musical typing, Web MIDI, ruler input, live lines, normalise-while-live fix; ports 5292/4292) and M7-c (`m7c-live-record`: record into silence, 15 ms merge, playback match ≤ 1 cent/1 block; ports 5293/4293). Wire M7-c's Record API into M7-b's drawer after both land. Watch for the other session's `levelMerging` ('Weights within their voices') branch.
- **State 2026-11-22 ~05:30:** main = 5de05b7 (preview v47: progression owner notes); CI for it not yet checked. main-7glpov 9ca3e3d adds part-norm-default (per-part normalisation is the default, owner said yes; 8 composition goldens re-pinned) + prog-default (progression defaults to the key's own chords); unit + test:perf pass there; chromium e2e running (`<scratchpad>/e2e-v48.log`; rerun perf failures alone, render.spec 4 ms always fails here) → push as v48, republish preview.
- **Separate owner-started cloud sessions push `claude/*` branches** (from task cards builders queued). The owner OK'd it on condition they push their own branch, not main. Pending: `claude/youthful-mendel-kpqpzk` daffaff "Forks take their parent's level" (on d6f1419): merge after v48; tide-pools render golden conflicts with part-norm-default → take ours, then `UPDATE_RENDER_GOLDEN=1 pnpm exec vitest run tests/dsp/render-golden.test.ts` and check only tide-pools changed. Its open question (a part returning from silence keeps its old level): integrator call told to owner = reset to 1 unless a level moment addresses it; queue a small core builder. A related session ("Weights within their voices", `levelMerging`, line weights above voice counts) may push another `claude/*` branch: merge with the same care.
- **Running:** M7-a builder (`m7a-live-engine`: live voice leading, `live` segments, interactive context, LiveEngine API, latency test). Told: no push, no subagents. Next: M7-b inputs (musical typing mode + indicator + shortcut suppression, Web MIDI, piano ruler as input, Live drawer settings), M7-c recording into silence (15 ms chord merge, playback within 1 cent/1 block). composing.md §3 suggestions are all done.
- **Next queue:** composing.md §3 suggestions left: 3 tune rests/re-strike/transpose with key, 9 pulse note order, 8 multi-part targets, 1 progression moment, 5 walk chord tones, 7 pulse envelope drawing, 11 smaller. Then M7.
- Cloud box setup: pulseaudio null sink installed via apt; Playwright chromium via `PLAYWRIGHT_BROWSERS_PATH=<scratchpad>/pw` symlinks (1255 → 1243).

## M4.5 builder split (approved; walk = freeze into `fixed`, not `edits`)
1. **Core frozen walks** (Opus medium): `types.ts`, `schema.ts`, `moments/walk.ts`, compiler emit of `walkSteps`; tests incl. incremental compile. Independent.
2. **Camera + follow + zoom** (Opus medium): `render/camera.ts`, `app/loop.ts`, `ViewBar.tsx`, store view slice; future dimmed. First of the UI chain.
3. **Ruler + single playhead** (after 2): new `Ruler.tsx`, `App.tsx`, `Transport.tsx` (scrubber only in the player layout); `drawScore` skips the playhead in the editor.
4. **Rows on the shared axis** (after 2): `Lane.tsx`, `editor/lane.ts`, `lane.css`: Moments, Transitions, Level.
5. **Chord picker** (independent): new inspector component + `NoteSetField.tsx`; slash `C/C` parse check.
6. **Transition/level/voices controls** (after 5, shares `TypeFields.tsx`/`CommonFields.tsx`).
7. **Walk steps UI** (after 1, 2): steps list + dots overlay.
8. **Generate confirm** (small, independent): `GeneratePanel.tsx`.
Rev 6 queue (owner 2026-11-20): 9. arrive together + `no-effect` + palette helper (core; running). 10. chord `count` (core, after 9). 11. chord "Notes: n" + per-note editor + Arrive toggle + hide targeting under Advanced, drop Top/Bottom n (inspector, after 10). 12. dimmed no-op markers + context palette with hover preview (after 4 and 9). 13. next-move suggestions (after 12). 14. `note` moment core (after 10). 15. note point UI: double-click a line, drag, dot, inspector (after 14, 11).
Then one builder runs the full e2e on the merged tree.

Last pushed: M4 done (merge `086f094` + docs), verified in a clean worktree (871/871 tests, lint, typecheck, build, 224 e2e on Chromium + Firefox, 0 failed). CI: see `gh run list`.

## Next tasks
- **Push state:** see the build log tail / `git log origin/main`. If local main is ahead, verify HEAD in a clean worktree and push (routine above).
- **M4 follow-ups (optional):** compile in a worker if edit latency on long pieces gets tight (worst ≈ 46 ms); incremental compile could stop early once the resumed state re-converges; palette drag has no touch path (M5 touch work).
- **Editor view redesign before M5 (owner, 2026-11-20).** Owner direction and mockup link: build log "Editor view redesign". Revise PLAN (§10 view, editor sections) first; **don't start builders until the owner says go.**
- **Then M5** (PLAN §15). Confirm with the owner whether tablet touch editing is in scope (phones are not a priority).
- **E2E ports:** give every builder distinct `E2E_DEV_PORT`/`E2E_PROD_PORT`/`E2E_OUT_DIR` in its brief; Playwright reuses whatever is on 5180 (the integrator's dev server).
- **Builder Alt rule (integrator call):** Alt at press duplicates; Alt held disables snapping (PLAN gives Alt both meanings).
- **Machine load:** parallel builders push load to 40–60, so their full `pnpm test` runs fail timing tests (rtf, compiler-perf, dsp export, stems). Rerun those alone; don't treat them as regressions.
- **Watch items:** the unison lock is getting intricate (group pass + glide warp, stems 6× slower); plan a consolidation pass in M6. Hard DSP briefs must be narrow.
- **Stems speed:** skip voices that can never join the stem voice's group. Not urgent.
- **Later backlog:** the expo/bezier allocation fix (M6); choir ideas (breath noise in M6, two oscillators per voice, formants per register, more partials for bass).

## Waiting on the owner
- **Device checks:** MIDI in FL Studio once the owner has it (until then the automatic round-trip tests stand). The iPhone silent-switch check is optional, not a release blocker.
- **Generate:** answered 2026-11-21: no warning; an edited, unnamed piece gets a name prompt before the next opens (PLAN §11.4).
- **To hear:** `renders/gen-30s.wav`, `gen-60s.wav` (short Generate pieces); the unison glide WAVs once they exist.
- **HUD chord choices to review if the owner cares:** written chord symbols get no inversion slash; a single pitch class reads "A (unison)"; the key and follow mode share one HUD line.
- **Older, unanswered:** reed A/B (`reed-before`/`-after`); the fixture page on the live site; the roman numeral convention (kept, owner 2026-11-21). The app uses system fonts, not IBM Plex (bundling Plex would be a dependency).

## Owner rulings so far (details in the build log)
- **Phones are not a priority (2026-11-20).** Desktop is the focus. Keep the phone layout usable, but don't spend effort on phone-specific testing or polish: no phone screenshots or e2e beyond what exists, and no device checks as blockers. Tablets (M5 touch editing) are probably low priority too (integrator's reading; confirm with the owner before M5).
- **§16 answers:** MIT; time in seconds with an optional BPM grid; no DAW yet (FL Studio later); GitHub Pages; the name is AlgoRhythms (plural) everywhere; 32 voices; M3 before the editor.
- **Line crossing:** forbidden in the app. The core compile option `crossings: 'allow'` remains for tests; the `?dev` panel was removed (2026-11-20).
- **Unisons and merges:** steady by default (the unison lock); wobble is its own opt-in timbre setting and preset. After the lock: holds were fine, but the owner still heard wobble as voices glide in/out (fix in flight).
- **Choir:** reworked; the owner heard the difference (2026-11-20).
- **Line colours:** "Per voice" removed; "By pitch" is the default (2026-11-20). Old files with `"voice"` load as `"pitch"`.
- **HUD:** shows the chord currently playing (2026-11-20, done: `chordAt`, harmony timeline in the compiled score).
- **Generate:** length 30–900 s, slider default 2:30, "natural length" optional and off by default (2026-11-20).
- **Export:** closing the dialog mid-export cancels it (2026-11-20).
- **MIDI:** per-voice tracks skip channel 10 (integrator call).

## Owner feedback via preview comments
- The owner comments on the preview artifact. Each comment wakes this session (a webhook notification). Read it with ArtifactComments `read` + `thread_id`, reply on the thread, then put the change in PLAN and give it to a builder. Comments carry text and the `#score` anchor only, with no image or position.

## State (local integrator, 2026-11-21)
The cloud integrator is done; this local session owns everything. Comment watch on the preview is armed here.
- **Owner was away (2026-11-21 evening; back now):** keep the queue moving; message only when a demo (preview republish) is finished; ignore the ~200k compact rule for now. Technical calls are the integrator's; product/sound questions and product-visible calls go in `docs/owner-decisions.md` ("Needs you" / "Decided by the integrator"). Keep it current.
- **Pushed:** e0604f2 = M4.5-23 (score selection, grouped notes), M4.5-26 (open canvas), e2e spec fixes (lane Escape, view-follow race). CI green on all three engines; Pages deployed; preview artifact already shows this bundle.
- **Also pushed:** d8b0d0b = M4.5-25 ("notes" wording; owner withdrew the dimming fix) + these docs; preview republished (version 14).
- **Pushed:** 91d9c86 = M4.5-33 Shift-drag octaves + M4.5-34 all-notes timbre (preview version 18). 2ad5e9b = M4.5-31 shift slider; ab94dbf = M4.5-30 spread at range edges; 7ac4632 = M4.5-29a distinct notes (merged with 30 as d82b0e9) + M4.5-32 arrival tick fix (smooth articulation attack, 12 ms floor; changes pluck 2→12 ms and organ 3→12 ms: owner to listen) + context-moments e2e wording. Preview version 17. Threads 4f2fa9f1 and 05bf32cb: "in the preview" notes posted (owner had already resolved them).
- **Verify 7ac4632:** unit 1159, perf, build pass; e2e 377/378, note-points.spec:99 flaky since 29a (13.4 vs 10.2; passes alone); React "NaN for value" warning in the dev log.
- **Pushed 55c7a4a (preview version 19):** 29b weights, 35 drag preview + auditioning, property seeds, 36 key carry-forward, 37 Space, R9-5 silent lines vanish (+ integration, e2e fixture URLs), e2e-flake-nan (score click-seek holds the view; lane-rows NaN), and rev 9 compositions in the preview. Verify: unit 1245/1245 at 48a2e74, integration branch unit 1256/1256, full e2e chromium+firefox 421/422 at 445b86a (score-select:138 load flake; 56/56 targeted rerun at 55c7a4a). Seeds left open: −41577023/907 ("walk step cuts m00000 at 22.9", maybe from the hand-over birth fix); the 4×1000 sweeps never finished; `test:perf` not run; the CrChd2 register rule (owner-decisions.md). Next core builder = seeds-2 for those, then R9-1.
- **Polish follow-ups (one app builder, after verify):** key-carry must not remap a note moment's `from` when its note is held from before the key moment; audition hooks for ▲/▼ on walk steps and inspector chord notes, and for Shift+▲/▼ on dots.
- **Pushed 240a399 (preview version 20):** polish (key-carry keeps held `from`; auditions for walk/chord-note ▲/▼ and Shift+▲/▼ dots). Acceptance audit in `docs/m4.5-acceptance.md` (b9c478c): M4.5 not yet acceptable — 27 and 28 not built; test gaps being closed.
- **Pushed 4da2629 (preview version 21):** seeds-2 (all core properties 4×1000 green; dying line waits for survivor, walk span checkpoint, crowded spread order; free octaves stay inside an explicit register, CrChd2 now merges on 79). Perf: compile median 24.9 ms, RTF 17×.
- **Pushed 9bd2e44 (preview version 25):** M4.5-27 start is a moment + schema v2; M4.5-28 Compose for me; M4.5 final acceptance (lane opening is a point; mouse-only.spec); mouse-only gaps (Undo/Redo buttons, chord fill to a triad on a fresh piece, loop rounding). M4.5 passes §15 per `docs/m4.5-acceptance.md`.
- **Owner back (2026-11-21 night), answered:** softer pluck/organ attack is good; arrival tick gone; key = fixed key moment at 0:00 (editable, not deletable/movable). New owner feedback, in PLAN: lane previews for palette hover/drag; compose in play order with one final edit sweep, no recompose after finish, panel closes on own edits.
- **Pushed 0a473e7 (preview version 26):** M4.5-38 compose in play order (one detail sweep, upper-neighbour `note` pass, "Compose again", panel closes on own edits); M4.5-39 lane ghost previews + piece key as a fixed Key-row moment at 0:00 (`PIECE_KEY_ID`, `foldOpeningKeys`). Verify: unit 1358/1358, e2e chromium+firefox dev/prod 472/472.
- **Pushed a2abd7d (preview version 28):** R9-1 parts core (+ walk-steps `{part}` app line, owner-approved after the classifier refused the core builder), R9-6 parts UI, no-GC fix (probe inlined, harness counts in-run GCs, young-gen growth gate), TextField draft fix, name-before-moving-on popup (Generate confirm removed). Verify: e2e 478/478 at de61cdc; unit 1395/1395 at a2abd7d; targeted e2e 147/147.
- **Pushed 2311686 (preview version 29):** lane overflow fix v1 (owner rejected its compact rows), R9-2 land + split/merge stagger, test hardening. Local main since: thickness ropes (d4aca63), ease fix (a748515), PLAN dense lanes v2 + crossfade.
- **Owner asleep (from 2026-11-21 ~05:00):** "keep going … I won't be able to confirm 30 … work on the next stages (mostly UI, I'll change it later) … note everything I should try/address". Keep the "When you're back" list at the top of docs/owner-decisions.md current; push versions without waiting for the owner.
- **v35 pushed** (8106972: v34 + M5 touch gaps (lane pinch, octave by touch, piano-key overlap fix) + M6-a FM/noise/stretch/bell; full verify green) = preview version 35. art-old.txt matches it.
- **In flight:** M6-b per-voice timbre + `timbre` moment; M6-c harmonic editor + preset save/load + more presets. **Composition rewrite done, parked on local branch `compositions-rev9` (ddfe9d4), unmerged until the owner listens** (renders in renders/rev9-compositions/; owner says "ship the compositions" → a builder merges main into it (share-link canonicalisation re-pinned the old compositions' goldens), then verify and push). Then M6 acceptance, M7. CI: v31/v32 runs failed only on e2e specs writing to /private/tmp (fixed in d14a1ab; lint now bans /tmp literals in tests).
- **Owner style (2026-11-21):** builder results to the owner in one line each; send the preview link when a version is up.
- **Next:** after R9-2: crossfade core builder (PLAN §11.3 "Merges and splits crossfade": loudness ramps across the approach, constant power, one shared time function with the render strand widths from the thickness builder); then seeds-3 core builder for chord-count −320129613/300 and crossings −883975252/819, −440599787/662 (pre-existing), ease.property "standard eases … monotone" seed 353562081 (fixed by 793776c: smootherstep 3.7e-15 dip; the 3e-6 values were inputs); 1000-run seeds from R9-3a: compiler "no crossings" 893200642 and distinct-notes "no two resting lines share a pitch" 1028843820 (not pulse: same without pulses); then R9-3a pulse core, R9-4 tune core, R9-9 land UI; R9-3b after 3a; R9-7/8 after 3a+4; composition rewrite last. Builders: run targeted tests + one full suite; integrator runs full cross-browser.
- **After R9-1:** R9-2 land + split/merge stagger, R9-3a pulse core, R9-4 tune core (sequence the core ones: they all touch the compiler), R9-6 UI parts. After 3a: 3b pulse DSP. Then R9-7/8/9 UI. After 1, 2, 3a/3b, 4: composition rewrite builder (brief: docs/composing.md §1).
- **Order (integrator call):** after seeds-2, M4.5-27 (start is a moment, schema v2) goes before R9-1, so parts lands on schema v2 with one migration; then R9-1 and 28 in parallel (28 is app/composer, R9-1 core); redo the M4 manual checks after 27.
- **PLAN rev 9 pushed** by the "Algorithm audio instrument demos" session for the owner (0de91b6 compositions + rev 9, 3d1be6a docs/composing.md). Examples: Originals (5) + Compositions (Harbour Song, Night Ferry, Kite Day; featured = Kite Day); `?example=<id>`; every e2e spec opens `./?example=tidewater-hymn`. That session is gone; do not message it.
- **Rev 9 queue (owner confirmed 2026-11-21: start as the current M4.5 builders finish; R9-1 waits for the seeds builder (compiler), R9-5 for 29b (draw.ts)):** R9-1 parts core (VoiceDef.part, schema, `{part}` selector, distinct notes merge only within a part); R9-2 `glide.land` + split/merge honour stagger/order (after 1); R9-3a pulse core → per-voice hit records in flat.ts (after 1); R9-3b pulse DSP, allocation-free envelope × level, strike re-triggers articulation, MIDI CC11 (after 3a, Opus high); R9-4 tune core, merges only within its part (after 1); R9-5 silent lines vanish (render, independent); R9-6 UI parts: drawer grouped by part, Part chooser (after 1); R9-7 pulse + tune inspectors, lane regions, palette (after 3a, 4); R9-8 tune dots drag + typed input "F#5 2, E5 1" (after 7); R9-9 Land toggle + Transitions bar ending at the marker, Snap to beats (after 2). R9-10 (double-click seek/follow race) is the e2e-flake-nan builder's. After 1, 2, 3a/3b, 4: a builder rewrites the compositions with docs/composing.md §1 as brief (generators in renders/demos-2026-11-20/songs/generators/, gitignored). Integrator call kept: normalisation still counts silent voices. Low priority: Three Clocks chord OoFIhJ count change crosses lines; freezeChord does not reproduce it.
- **Accepted 29a calls:** surplus newborns bound for a parent/sibling note join that line; a shared rest is allowed only while one line leaves within 10 s; balance test skips merge/count→unison and spread→chord spans; free octaves come from the lines' range (may fall outside an explicit register). Cartographers gained `crossing-untargeted` at CrChd2 (seeds builder checks).
- **Full e2e** runs Chromium + Firefox here; WebKit only on CI (it can't be muted on the Mac).
- **Load:** the Mac has 6 cores. Five or six builders at once drove the load to about 300 (2026-11-21), so keep at most three running and brief them to use `--maxWorkers=2` and Playwright `--workers=1` (now in CLAUDE.md). With builders running, unit tests time out at 5 s; rerun alone with `--testTimeout=60000`. A full e2e at load ~20 gave 37 spurious failures (zero-RMS audio, page timeouts); run e2e on a quiet box.
