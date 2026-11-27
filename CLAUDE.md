# AlgoRhythms: rules for every agent working here

**PLAN.md is the spec.** Read the sections your task names before writing code. If you must deviate from it, record the deviation and the reason in `docs/build-log.md` and mention it in your final report. Never change PLAN.md yourself; the integrator owns it.

**If you are the integrator,** read `docs/integrator-handoff.md` before doing anything else.

**Be concise:** in reports, build-log entries, commit messages and code comments. Say what matters, and skip the narration.

**The build log is for what the code and commits don't say:** deviations from PLAN, contracts between builders, handoff notes, traps. A routine fix needs only its commit message. Newest entries go at the bottom; entries before M14 are in `docs/archive/build-log-to-m12.md`.

**Builders don't spawn subagents.** When your context gets big (past about 300k tokens, or once it has been compacted), stop at the next stable point and do this:
- write a concise handoff note in `docs/build-log.md`: the design, what's done, what's left, the test status and any traps;
- commit if typecheck and tests pass, otherwise list the WIP files;
- report back.

The integrator continues the work with a fresh agent.

## Roles
- The **owner** decides product questions (PLAN.md §2, §16).
- The **integrator** (one long-lived T3 thread) assigns milestones and verifies their acceptance criteria. It does not write code. It never starts a new milestone until it has mapped it out (scope, builder split, open questions) and the owner approves.
- **Builder agents** (the integrator's `delegate_task` children) write all the code, each within the directories its task gives it.
- **Composers** (their own threads, talking to the owner directly) make pieces with the instrument. Read `gallery/README.md` ("When you compose a piece") and `docs/composing.md` first; experimental composers also read `gallery/experimental-composer.md`. A piece meant for the app goes on its own branch; the integrator merges it.

## Naming
- The product name is **AlgoRhythms**: plural, with that capitalisation, everywhere.
- In identifiers, use `algorhythms`: the package name, the `format: 'algorhythms'` field, `.algorhythms.json` files.
- The old singular "AlgoRhythm" must not appear anywhere.

## Environment
- Homebrew is not on the default PATH. Start every shell command with `eval "$(/opt/homebrew/bin/brew shellenv)"`, or use absolute paths.
- Tools (installed in M0 with Homebrew): Node 22 (`node@22`, 22.23.5), pnpm 12.18.0, and `gh` 2.103.3 (logged in as the owner).
  - `node@22` is keg-only but is linked into `/opt/homebrew/bin`, so `brew shellenv` finds it.
  - If `node --version` is not v22 (for example after something installs the `node` formula), run `brew link --force --overwrite node@22`. Or put it first on the PATH: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- **The Mac has 6 cores and several builders share it.** Builders don't run the full `pnpm test`: run the unit tests for what you touched (`pnpm exec vitest run <files or folders> --maxWorkers=2`), plus `pnpm lint` and `pnpm typecheck`. The integrator runs the full suite once per merge batch. Timing gates (rtf, compile perf, render budget) and 5 s timeouts miss under load: report them, don't chase them. For e2e, run only the specs your change touches, with `pnpm e2e:quick <specs> --workers=1` (skips the `@perf` timing gates). Never run the whole e2e suite: GitHub CI runs it, sharded, on every push. Known flakes and traps: the top of `docs/build-log.md`.
- **Never play audio out loud on the owner's Mac.** Don't listen through any in-app browser or preview (the built-in browser pane, T3's `preview_*` tools, a dev server). Judge sound from offline WAV renders analysed numerically. Use only headless Playwright, whose config mutes chromium and firefox; WebKit can't be muted, so run it only with `E2E_WEBKIT=1` and never press play there.
- **Gallery:** `gallery/` is local only (gitignored) and holds art made with the instrument: posters, videos, pieces and the offline renderer. Read `gallery/README.md` before adding to it. Never commit or push it unless the owner asks for specific files.
  - **Composer deliverables (owner, 2026-11-24):** don't render an `.mp4` video for a composed piece. Send a share link that opens the piece on the live site (https://baphaelman.github.io/algorhythms/#p=…, saved as `gallery/pieces/<kind>/<slug>.share-link.txt`). The audio, the poster and the note stay (`gallery/README.md`, "When you compose a piece"). When the owner asks for a video, every earlier video rule still applies (README step 3, dark by default, YouTube-ready).
- Playwright's browsers live in `~/Library/Caches/ms-playwright`. Reinstall them with `pnpm exec playwright install chromium firefox webkit`.
- Commands, set up in M0:
  - `pnpm test` runs Vitest without the timing and GC gates;
  - `pnpm test:perf` runs those gates (rtf, no-gc, compile perf). CI runs both. Run it on a quiet machine after touching `src/dsp` or the compiler;
  - `pnpm lint` runs ESLint, including the import boundaries and the core math ban;
  - `pnpm typecheck`;
  - `pnpm build`;
  - `pnpm e2e` runs Playwright.

## Hard rules (from PLAN.md)
- **TypeScript strict.** No Rust or WASM (D2).
- **Import boundaries (§14).**
  - `core` imports nothing internal.
  - `dsp` imports only *types* from `core`. The exception is values from the pure leaves `core/ease` and `core/segment`, which also hold the flat record layouts (see `docs/archive/build-log-to-m12.md`, M0).
  - `render` and `midi` import `core`.
  - `audio` imports `core` and `dsp`.
  - `app` may import anything.
  - `core` and `dsp` never touch the DOM or Web Audio (P3).
- **Portable math in `src/core` (§7.11):**
  - no `Math.sin`, `cos`, `pow`, `exp` or `log`, and no non-integer `**`;
  - use `core/math.ts`;
  - no `Math.random` or `Date` in `core` or `dsp`.
- **Worklet code is allocation-free in `process()` (§8.11).**
- **Dependencies:** MIT, BSD, ISC or Apache-2.0 only, and as few as possible. Ask before adding anything that isn't in §14's stack.
- **Tests:** every feature ships with its tests. Don't mark work done while your tests, `pnpm lint` or `pnpm typecheck` fail. Nothing merges to `main` while the full `pnpm test` fails.
- **Shared contracts:**
  - `src/core/types.ts` (the §5/§7.9 types) and `src/core/flat.ts` (the typed-array score layout, §8.11) are shared between agents working in parallel.
  - Extend them; don't rename or reshape existing fields without noting it in `docs/build-log.md`.

## Git
- Commit locally at sensible checkpoints, with clear messages.
- **`~/algorhythms` stays on `main`.** Don't switch its branch, and don't commit in it: T3 starts new worktrees from whatever it has checked out, and other sessions merge there. Any session that commits works in its own worktree (`git worktree add -b <branch> <path> main`), builders and composers included. The integrator merges in a scratchpad worktree and moves `main` with `git update-ref`.
- The remote is `origin`: https://github.com/baphaelman/algorhythms, which is public. The site deploys to https://baphaelman.github.io/algorhythms/ from `main`.
- **Only the integrator pushes.** Builders commit locally and never push.
- Commit as Claude (owner, 2026-11-22; earlier commits keep the old placeholder author, and are never rewritten):
  `git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit …`
  Don't change the git config.
- End commit messages with a trailer that names **your own** model, for example:
  - `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Status
Milestone state and the current work: `docs/integrator-handoff.md` → "Now". Finished milestones: PLAN.md §15.
