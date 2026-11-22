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
- **The Mac has 6 cores and several builders share it.** While iterating, run only the tests you need, with `--maxWorkers=2`, and run Playwright with `--workers=1`. Run the full `pnpm test` once at the end, also with `--maxWorkers=2`. Timing gates (rtf, compile perf, render budget) miss under load: report them, don't chase them. For e2e, run only the specs your change touches, with `pnpm e2e:quick <specs> --workers=1` (skips the `@perf` timing gates). Never run the whole e2e suite: the integrator runs it once per merge.
- **Never play audio out loud on the owner's Mac.** Don't use the built-in browser pane (`mcp__Claude_Browser__*`) or a dev-server preview to listen. Judge sound from offline WAV renders analysed numerically. Use only headless Playwright, whose config mutes chromium and firefox.
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
- Commit as Claude (owner, 2026-11-22; earlier commits keep the old placeholder author, and are never rewritten):
  `git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit …`
  Don't change the git config.
- End commit messages with a trailer that names **your own** model, for example:
  - `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Status
| Milestone | State |
|---|---|
| M0 Scaffold + shared contracts | **done** 2026-11-20. CI green on all three engines; site live |
| M1 Core compiler | **done** 2026-11-20. The owner's listening test passed. Open: the strict §7.10 5 ms target is missed (~8 ms full compile); M4j's incremental compile makes late edits cheap |
| M2 Sound engine + WAV | **done** 2026-11-21: the owner's listening check passed. Known gap: expo and bezier glides allocate on the audio thread (fix planned for M6) |
| M3 Player, Generate, exports (first public release) | feature-complete and live 2026-11-20 (player, Generate, Export WAV/stems/MIDI, HUD chord, unison lock + wobble preset). unison glide fix approved and pushed. No release announcement (owner, 2026-11-21); phones are not a priority |
| M4 Editor core | **done** 2026-11-20: all §15 acceptance checks pass (build log "M4 acceptance checks"); incremental compile and editor polish merged and pushed. Awaiting the owner's look. Next: M5 |
| M4.5 Editor view redesign | **done** 2026-11-21: all §15 acceptance lines pass (`docs/m4.5-acceptance.md`); owner approved the preview. Follow-up: name-before-moving-on prompt (PLAN §11.4) |
| R9 Parts, pulse, tune, land (PLAN rev 9) | **done** 2026-11-21 (R9-1…9, crossfade, arrival bloom), pushed in v30–v32. The composition rewrite is on local branch `compositions-rev9`, waiting for the owner to listen |
| M5 Editor completion | **feature-complete** 2026-11-21 (share links, multi-select/copy/paste/Freeze/piano ruler, touch), pushed in v33–v34. Acceptance: `docs/m5-acceptance.md`; no iPad check (owner, 2026-11-22). Open: the old compositions' links stay over 2,000 characters until the rewrite ships |
| M6 Timbre depth | **feature-complete** 2026-11-22: all §15 acceptance lines pass (`docs/m6-acceptance.md`); FM, noise, additive, redesigned bell, presets, Sound drawer (timbre editor + master FX), `timbre` moment. Owner picked the church bell (2026-11-22) |
| M7 Live instrument | **done** 2026-11-22: all §15 acceptance lines pass (`docs/m7-acceptance.md`); latency ≤ 10 ms on all three engines in CI; owner played it ("its good"). Pushed in v50–v54 |
| M8 Video export | **feature-complete** 2026-11-22: all §15 acceptance lines pass (`docs/m8-acceptance.md`); live in v57 (Chromium, Firefox, Safari). Waiting for the owner to watch exports (QuickTime/iPhone playback of Chrome's H.264 + Opus, 9:16 legibility, defaults) |
| M9 Poster export | **feature-complete** 2026-11-22 (PLAN rev 12–13): PNG/SVG posters and the export Look panel (every visual decision an option; owner's export defaults; HUD checklist), pushed in v58. Acceptance doc pending |
