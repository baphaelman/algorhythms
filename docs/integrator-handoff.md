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
  - ask the owner to type `/compact` (you can't run it), suggesting what to keep: push state, in-flight builders, open owner questions;
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
| M3 | Feature-complete and live: renderer, MIDI, stems, player, Generate (30–900 s), Export dialog, by-pitch colours, HUD chord, unison lock + `wobble` preset. PLAN rev 3 records the lock. Left: announce the first public release (the iPhone check is not a blocker). Next milestone: M4 editor. |
| M4 | Done (2026-11-20). M4a–M4k merged and pushed: compiler speed-up, editor API, persistence, lane, inspector, palette + shortcuts + drag from palette, voices drawer, selection highlight, incremental compile (M4j), polish (M4k). All §15 acceptance checks pass (build log "M4 acceptance checks"; edit → swap 12–43 ms). |
| M4.5 editor view | Approved 2026-11-20 (build log "M4.5 approved"). Builders running. |
| M5–M7 | Not started. |

## Running in the cloud (owner, 2026-11-20)
The owner moved the integrator to a cloud session to use it from their phone. Linux, 4 cores; repo `/home/user/algorhythms`; `git push origin <sha>:main` works (owner OK); `gh` isn't authenticated, so watch CI with the GitHub MCP tools (`mcp__github__actions_list`). There: no Homebrew (skip the `brew shellenv` lines); localhost demo links don't reach the phone, so the demo is the Pages deploy after a push; check whether `gh` is authenticated before relying on it.

## M4.5 builder split (approved; walk = freeze into `fixed`, not `edits`)
1. **Core frozen walks** (Opus medium): `types.ts`, `schema.ts`, `moments/walk.ts`, compiler emit of `walkSteps`; tests incl. incremental compile. Independent.
2. **Camera + follow + zoom** (Opus medium): `render/camera.ts`, `app/loop.ts`, `ViewBar.tsx`, store view slice; future dimmed. First of the UI chain.
3. **Ruler + single playhead** (after 2): new `Ruler.tsx`, `App.tsx`, `Transport.tsx` (scrubber only in the player layout); `drawScore` skips the playhead in the editor.
4. **Rows on the shared axis** (after 2): `Lane.tsx`, `editor/lane.ts`, `lane.css`: Moments, Transitions, Level.
5. **Chord picker** (independent): new inspector component + `NoteSetField.tsx`; slash `C/C` parse check.
6. **Transition/level/voices controls** (after 5, shares `TypeFields.tsx`/`CommonFields.tsx`).
7. **Walk steps UI** (after 1, 2): steps list + dots overlay.
8. **Generate confirm** (small, independent): `GeneratePanel.tsx`.
Rev 6 queue (owner 2026-11-20): 9. arrive together + `no-effect` + palette helper (core; running). 10. chord `count` (core, after 9). 11. per-voice chord editor + Arrive toggle (inspector, after 7 and 10). 12. dimmed no-op markers + context palette with hover preview (after 4 and 9). 13. next-move suggestions (after 12).
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
- **Generate:** warn before replacing the open piece? Unanswered; it doesn't warn. Less pressing now: edited pieces autosave to My pieces.
- **To hear:** `renders/gen-30s.wav`, `gen-60s.wav` (short Generate pieces); the unison glide WAVs once they exist.
- **HUD chord choices to review if the owner cares:** written chord symbols get no inversion slash; a single pitch class reads "A (unison)"; the key and follow mode share one HUD line.
- **Older, unanswered:** reed A/B (`reed-before`/`-after`); the fixture page on the live site; the roman numeral convention (numerals read against the major scale: in A dorian, `III` = C♯ major, `bIII` = C; keep unless they object). The app uses system fonts, not IBM Plex (bundling Plex would be a dependency).

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
