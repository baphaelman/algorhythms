# Integrator handoff

This is for the Claude session that orchestrates AlgoRhythms. Read it top to bottom before acting.

Also read `CLAUDE.md` (rules and the status table) and `docs/build-log.md`, which records every decision, deviation and owner ruling. `PLAN.md` is the spec; read only the sections a task needs.

Last updated: 2026-11-20, end of the second integrator session (handoff at ~240k tokens).

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

## Working notes
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
| M1 compiler | Done; the owner said the generated pieces "sound lovely". Open: about 16 ms compile against 5 ms (deal with it in M4: a worker or incremental compile); about 2 unresolved crossings per thousands of pieces, both involving newborns from a split (reported as diagnostics, written up in the build log); the compiler should extend the final hold to `died` (noticed by the MIDI builder). |
| M2 sound | Built and verified. Known gap: expo and bezier glides allocate on the audio thread (fix in M6: precompute those segments on a 128-frame grid). |
| M3 | Feature-complete and live: renderer, MIDI, stems, player, Generate (30–900 s), Export dialog, by-pitch colours, HUD chord, unison lock + `wobble` preset. PLAN rev 3 records the lock. Left: the unison glide fix (in flight), owner device checks, then announce the first public release. |
| M4–M7 | Not started. |

Last pushed: `f77952c`, verified in a clean worktree (745/745 tests, lint, typecheck, build, 170 e2e on Chromium + Firefox); CI green on all three engines and deployed (bundle `main-RYkdSH3g.js`).

## Next tasks
- **In flight: unison lock, steady glide in/out** (Opus high, started by the second integrator; its report goes to that session).
  - **Problem (owner):** holds are steady now, but the level still wobbles as voices glide into a unison and as they split. Measured on `renders/unison8-after.wav` (50 ms RMS, CV per 2 s): hold 0.000, approach 0.17–0.20, split 0.25. Cause: between ~20 and ~2 cents the voices beat before the lock engages, and eases linger there.
  - **Brief:** a metric (mix envelope ÷ incoherent sum at 50 ms, approach and split, N = 2/8/32), target ±1 dB; keep holds, merges, seek, clicks, exact stems, determinism, no-GC, RTF ≥ 10×, wobble preset, and leave intervals ≥ a semitone and passing glides alone. WAVs `renders/unison8-glide-after.wav`, `merge-glide-after.wav`, `gen-1-dorian-glide-after.wav`. Build-log entry "Unison lock: steady approach and parting".
  - **Where:** worktree `.claude/worktrees/agent-a9f5e3a18c67e3bb7`, branch `worktree-agent-a9f5e3a18c67e3bb7`, based on `06a437c`. At handoff it had uncommitted edits to `src/dsp/graph.ts` and `voice.ts` and no commits.
  - **If its report never reaches you:** check that branch and worktree (`git -C <wt> log`, `status`, its build-log entry). If it committed, merge into main (build-log conflict: keep both), verify, push, update PLAN §8.4 per its deviations, and send the owner the WAVs with a one-line comparison to the `-after` files. If it stopped mid-way, start a fresh Opus-high builder in that worktree from its handoff note.
- **Stems speed:** since the lock, each stem pass runs every voice silently, so stems are about 6× slower (0.46× real time of CPU for 24 voices). Optimisation: skip voices that can never join the stem voice's group. Not urgent.
- **M4 editor:** next milestone. Includes the compiler perf work (worker or incremental compile).
- **Later backlog:** the expo/bezier allocation fix (M6); choir ideas (breath noise in M6, two oscillators per voice, formants per register, more partials for bass).

## Waiting on the owner
- **Device checks:** the iPhone silent-switch test on the live site; MIDI in FL Studio once they have it (until then the automatic round-trip tests stand, as agreed).
- **Generate:** warn before replacing the open piece? Unanswered; it doesn't warn.
- **To hear:** `renders/gen-30s.wav`, `gen-60s.wav` (short Generate pieces); the unison glide WAVs once they exist.
- **HUD chord choices to review if the owner cares:** written chord symbols get no inversion slash; a single pitch class reads "A (unison)"; the key and follow mode share one HUD line.
- **Older, unanswered:** reed A/B (`reed-before`/`-after`); the fixture page on the live site; the roman numeral convention (numerals read against the major scale: in A dorian, `III` = C♯ major, `bIII` = C; keep unless they object). The app uses system fonts, not IBM Plex (bundling Plex would be a dependency).

## Owner rulings so far (details in the build log)
- **§16 answers:** MIT; time in seconds with an optional BPM grid; no DAW yet (FL Studio later); GitHub Pages; the name is AlgoRhythms (plural) everywhere; 32 voices; M3 before the editor.
- **Line crossing:** forbidden in the app. The core compile option `crossings: 'allow'` remains for tests; the `?dev` panel was removed (2026-11-20).
- **Unisons and merges:** steady by default (the unison lock); wobble is its own opt-in timbre setting and preset. After the lock: holds were fine, but the owner still heard wobble as voices glide in/out (fix in flight).
- **Choir:** reworked; the owner heard the difference (2026-11-20).
- **Line colours:** "Per voice" removed; "By pitch" is the default (2026-11-20). Old files with `"voice"` load as `"pitch"`.
- **HUD:** shows the chord currently playing (2026-11-20, done: `chordAt`, harmony timeline in the compiled score).
- **Generate:** length 30–900 s, slider default 2:30, "natural length" optional and off by default (2026-11-20).
- **Export:** closing the dialog mid-export cancels it (2026-11-20).
- **MIDI:** per-voice tracks skip channel 10 (integrator call).
