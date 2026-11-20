# AlgoRhythms: rules for every agent working here

**PLAN.md is the spec.** Read the sections your task names before writing code. If you must deviate from it, record the deviation and the reason in `docs/build-log.md` and mention it in your final report. Never change PLAN.md yourself; the integrator owns it.

**If you are the integrator,** read `docs/integrator-handoff.md` before doing anything else.

**Be concise:** in reports, build-log entries, commit messages and code comments. Say what matters, and skip the narration.

**Builders don't spawn subagents.** If your context passes about 200k tokens, stop at a stable point and do this:
- write a concise handoff note in `docs/build-log.md`: the design, what's done, what's left, the test status and any traps;
- commit if typecheck and tests pass, otherwise list the WIP files;
- report back.

The integrator continues the work with a fresh agent.

## Roles
- The **owner** decides product questions (PLAN.md §2, §16).
- The **integrator** (the main Claude session) assigns milestones and verifies their acceptance criteria. It does not write code.
- **Builder agents** write all the code, each within the directories its task gives it.

## Naming
- The product name is **AlgoRhythms**: plural, with that capitalisation, everywhere.
- In identifiers, use `algorhythms`: the package name, the `format: 'algorhythms'` field, `.algorhythms.json` files.
- The old singular "AlgoRhythm" must not appear anywhere.

## Environment
- Homebrew is not on the default PATH. Start every shell command with `eval "$(/opt/homebrew/bin/brew shellenv)"`, or use absolute paths.
- Tools (installed in M0 with Homebrew): Node 22 (`node@22`, 22.23.5), pnpm 12.18.0, and `gh` 2.103.3, which is not logged in until the owner runs `gh auth login`.
  - `node@22` is keg-only but is linked into `/opt/homebrew/bin`, so `brew shellenv` finds it.
  - If `node --version` is not v22 (for example after something installs the `node` formula), run `brew link --force --overwrite node@22`. Or put it first on the PATH: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- Playwright's browsers live in `~/Library/Caches/ms-playwright`. Reinstall them with `pnpm exec playwright install chromium firefox webkit`.
- Commands, set up in M0:
  - `pnpm test` runs Vitest;
  - `pnpm lint` runs ESLint, including the import boundaries and the core math ban;
  - `pnpm typecheck`;
  - `pnpm build`;
  - `pnpm e2e` runs Playwright.

## Hard rules (from PLAN.md)
- **TypeScript strict.** No Rust or WASM (D2).
- **Import boundaries (§14).**
  - `core` imports nothing internal.
  - `dsp` imports only *types* from `core`. The exception is values from the pure leaves `core/ease` and `core/segment`, which also hold the flat record layouts (see `docs/build-log.md`, M0).
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
- **Tests:** every feature ships with its tests. Don't mark work done while `pnpm test`, `pnpm lint` and `pnpm typecheck` fail.
- **Shared contracts:**
  - `src/core/types.ts` (the §5/§7.9 types) and `src/core/flat.ts` (the typed-array score layout, §8.11) are shared between agents working in parallel.
  - Extend them; don't rename or reshape existing fields without noting it in `docs/build-log.md`.

## Git
- Commit locally at sensible checkpoints, with clear messages.
- The remote is `origin`: https://github.com/baphaelman/algorhythms, which is public. The site deploys to https://baphaelman.github.io/algorhythms/ from `main`.
- **Only the integrator pushes.** Builders commit locally and never push.
- Commit as the placeholder author, whom the owner chose to keep:
  `git -c user.name="AlgoRhythms builder" -c user.email="builder@algorhythms.invalid" commit …`
  Don't change the git config.
- End commit messages with a trailer that names **your own** model, for example:
  - `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Status
| Milestone | State |
|---|---|
| M0 Scaffold + shared contracts | **done** 2026-11-20. CI green on all three engines; site live |
| M1 Core compiler | **done** 2026-11-20. The owner's listening test passed. Open: the strict §7.10 5 ms target is missed (about 16 ms on a loaded Mac); address it in M4 with a worker or incremental compile |
| M2 Sound engine + WAV | built and verified 2026-11-20; awaiting the owner's listening check on fixtures.html. Known gap: expo and bezier glides allocate on the audio thread (fix planned for M6) |
| M3 Player, Generate, exports (first public release) | in progress: M3a renderer, M3b MIDI. Next: stems export, app shell and wiring |
| M4 Editor core | not started |
| M5 Editor completion | not started |
| M6 Timbre depth | not started |
| M7 Live instrument | not started |
