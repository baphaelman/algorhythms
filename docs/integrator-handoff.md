# Integrator handoff

For the T3 thread that orchestrates AlgoRhythms. Read it before acting, and keep **Now** current: overwrite it, don't append. Also read `CLAUDE.md` (the rules for every agent) and the traps list at the top of `docs/build-log.md`. `PLAN.md` is the spec; read only the sections a task needs. Owner rulings are in `docs/owner-decisions.md` and PLAN; older text is in git.

## Now (2026-11-27)
- **main:** PLAN rev 21 (M17) on 10c0b32, docs only, not pushed. **Live:** b871add (Pages `main-DzidMlva.js`). **Preview artifact:** v90.
- **In flight:** M17 W1 (the video in the piece + watch-link format; ports 6140/4140) and W3 (pictures that open; ports 6150/4150).
- **Queue:** M17 W2 watch view + W4 QR (after W1), W5 acceptance. M13 alongside, one builder at a time, once the owner OKs the split (K1 hover to hear, K2 folds/widths/Next, K3 shift sequences + walks, K4 sound, K5 acceptance). M16 after the owner's screen reorganization.
- **Open owner questions** (also in owner-decisions "Needs you"):
  - M13 split?
  - The owner's reorganization of the screens (for M16).
  - Push the composer's `late-bloom` branch (b27f38c "Songs: add Late Bloom" plus copies of ba08e99/06afce4)?
  - Once Late Bloom is settled, put `~/algorhythms` back on `main`, after checking that no session is using it.
- **Small open items:**
  - poster: a split line doesn't follow its part's in-row move;
  - poster: Layers doesn't highlight a row piece's part;
  - poster: old wide text boxes keep their width until edited;
  - poster: a text box corner resize can land 1–2 px off a guide;
  - poster: gradient handles have no keyboard path;
  - poster: in the Poster section strip, a press moves the nearer handle;
  - video: the One-row camera hides only whole parts.
- **Ports used** up to 6150/4150; the next builder gets 6160/4160. The integrator verifies on 5490/4490.

| Milestone | State |
|---|---|
| M0–M3 | done / feature-complete 2026-11-20–21 (scaffold, compiler, sound + WAV, player + Generate + audio exports). Compile ~8 ms vs the strict 5 ms target. |
| M4, M4.5, M5 | Editor: done 2026-11-20–21 (`docs/m4.5-acceptance.md`, `docs/m5-acceptance.md`). |
| M6, M7 | Timbre depth, live instrument: done 2026-11-22 (`docs/m6-…`, `docs/m7-acceptance.md`). |
| M8, M9 | Video and poster export: feature-complete 2026-11-22–23. Known gap: macOS WebKit transparent posters' translucent colours. |
| M10, M11, M11.5 | Editor overhaul, exports you can shape, camera path: done 2026-11-23. |
| M12 | Directed Compose: done 2026-11-25. |
| M14 | Poster workspace: done 2026-11-25. Owner follow-ups (Save/Revert bar, selection panel, per-row placements, Text tool, round 3 incl. zoom and per-row hiding) live at b871add. |
| M15 | Play the poster: done 2026-11-26 (`docs/m15-acceptance.md`). |
| M16, then M13 | Not started; both need mapping and the owner's yes. |

## Standing rules (owner)
- **Don't write code.** Builders write all of it. You assign, verify, merge, push and report. You own PLAN.md, this file, `docs/owner-decisions.md` and the build log's traps list.
- **New milestones:** map each one first (scope, builder split, open questions, acceptance), and launch nothing for it before the owner's yes. Fixes the owner asks for, and their notes on live work, don't need a map. When the owner asks for your thoughts first, answer before launching.
- **Decisions:** make technical calls yourself. Product calls go in `docs/owner-decisions.md`.
- **Messaging:**
  - one line per builder result;
  - otherwise only when something is testable or a decision is needed;
  - after each push, republish the preview artifact at once and send the link, then send the Pages link once CI is green;
  - be concise.
- **Listening checks:** send share links that open on the live site. Never play audio on the Mac (CLAUDE.md).
- **Builders:** Opus 5.5 at medium effort by default. Use high for subtle algorithm, DSP or geometry work, and Sonnet at low effort for tiny mechanical fixes. Pass the model and effort on every launch.
  - Run about 3 at once at most.
  - Give each one as much context as it needs, plus the handoff rule.
  - Don't spawn reviewer agents; run the checks yourself.
- **Context:** the thread auto-compacts. Keep **Now** current so nothing lives only in the conversation.

## Routine
1. **Launch:** `delegate_task` with `isolation: "worktree"` and target `{driverKind: "claudeAgent", model, options: {effort}}`, using the brief below.
   - Send follow-ups with `t3_thread_send`: `steer` while the thread runs, `queue`/`auto` once it's idle.
   - A new review or re-check is a new `delegate_task`.
2. **On a report:** confirm the work sits on current main (`git merge-base --is-ancestor main <tip>`).
3. **Merge** in `<scratchpad>/integrate`, a detached worktree. Never merge or commit in `~/algorhythms`.
   - `git checkout --detach main`, then `git merge --no-edit <sha>` for each finished builder.
   - The build log merges by union.
4. **Verify** in `<scratchpad>/verify-head` with `git checkout --detach <merge>` and `pnpm install --frozen-lockfile --prefer-offline`, then:
   - `pnpm lint`, `pnpm typecheck`, the full `pnpm test -- --maxWorkers=3` and `pnpm build`;
   - the e2e specs the batch touches, plus any spec that greps for a changed name or testid:
     `E2E_DEV_PORT=5490 E2E_PROD_PORT=4490 E2E_OUT_DIR=dist-e2e-5490 pnpm exec playwright test <specs> --project=chromium-dev --project=firefox-dev --workers=3 --grep-invert '@perf|@latency'`
   - then rerun the failures alone with `--last-failed --workers=1`;
   - a failure that also fails on the live sha is this Mac (see the traps list). Add `pnpm test:perf`, run alone, after DSP or compiler changes.
5. **Push:** `git -C ~/algorhythms update-ref refs/heads/main <new> <old>` (full shas), then `git push origin main`. Docs-only pushes skip CI.
6. **Preview artifact** https://claude.ai/artifact/PkiBVk62JzhoWUaqqDKGgJ, republished right after the push:
   1. in verify-head, `rm -rf dist-art && ALGORHYTHMS_BASE=./ pnpm exec vite build --outDir dist-art --sourcemap false`, then `rm -f dist-art/fixtures.html dist-art/assets/fixtures-*.js`;
   2. diff `ls dist-art/assets` against the last publish (`<scratchpad>/art-new.txt`): new files map to `dist-art/assets/…`, gone files to `null`;
   3. publish with `url`, `file_path` = `verify-head/dist-art/index.html`, `root` = verify-head, and that `files` map.

   Other sessions publish to it too. On a conflict, list its files, publish your superset and null the stale assets.
7. **CI:** run `gh run watch <id> --exit-status` in the background. Pages deploys only when every job is green; confirm the new bundle with `curl`. Rerun known flakes (the WebKit playback-speed shard).
8. **Update Now**, and the traps list if something new bit.

## Builder brief template
```
You are a builder on AlgoRhythms (TypeScript, React, Zustand, Vitest, Playwright). Read CLAUDE.md first and follow it (commit as Claude with your own model's trailer, never push, no subagents, never play audio, hand off per CLAUDE.md).

**First:** run `git reset --hard <main sha>` and check that `git log --oneline -1` shows it (T3 starts worktrees from the main checkout's branch).

## Task
<the owner's words, quoted; the decisions (owner-decisions entry, PLAN §); the files and functions to start from; parallel builders and the files they own>

## Tests and checks
- Every change ships with its tests: unit for the logic, e2e for the UI.
- Run targeted unit tests (`pnpm exec vitest run <files> --maxWorkers=2`), `pnpm lint`, `pnpm typecheck` and `pnpm build`. Not the full `pnpm test`.
- Grep every spec in tests/e2e/ for the names, testids and layouts you change, and update them.
- Run e2e only for the specs you touch, on your ports: `E2E_DEV_PORT=<p> E2E_PROD_PORT=<q> E2E_OUT_DIR=dist-e2e-<p> pnpm e2e:quick <specs> --workers=1`.
- Known Mac-only failures and flakes are at the top of docs/build-log.md.

## Report
Commits; what you tested and the results; deviations (also in docs/build-log.md); what's left open. Concise.
```
