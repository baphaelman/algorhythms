# Contributing to AlgoRhythms

Thanks for your interest. AlgoRhythms is a small project; [PLAN.md](PLAN.md) is the spec.

## Ground rules

- **TypeScript, strict.** No Rust or WASM.
- **Layers** (`src/`), enforced by `pnpm lint`:
  - `core/` (compiler, data model) imports nothing internal and uses only portable math: no `Math.sin`, `cos`, `tan`, `pow`, `exp`, `log`…, no `Math.random`, no `Date`. Use `core/ease.ts` (`sinPi`, `cosPi`, `exp2`) or `core/math.ts`.
  - `dsp/` (pure-TS synthesis) imports only types from `core/`, plus `core/ease` and `core/segment`. No `Math.random` or `Date`.
  - `render/` and `midi/` import `core/`; `audio/` imports `core/` and `dsp/`; `app/` imports anything.
  - `core/` and `dsp/` never touch the DOM or Web Audio (`pnpm typecheck` checks them without DOM types).
- **Audio thread:** nothing in `process()` allocates (no literals, closures, spread or `for…of`).
- **Every feature ships with tests.** Before you open a pull request, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` must pass, and `pnpm e2e` should too.
- **Dependencies:** MIT, BSD, ISC or Apache-2.0 only, and as few as possible. Ask first.
- **Decisions:** anything that departs from PLAN.md goes into [docs/build-log.md](docs/build-log.md) with its reason.

## Workflow

1. `pnpm install`, then `pnpm dev`.
2. Format with `pnpm format` (Prettier; Markdown is formatted by hand).
3. Keep commits focused, with clear messages.

By contributing you agree that your contribution is licensed under the MIT license.
