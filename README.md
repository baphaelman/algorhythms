# AlgoRhythms

AlgoRhythms is a free, open-source website that is both an **instrument** and a **composer** for pitch-line music. A set of voices glide continuously between pitches. They are drawn as lines, with time on the x-axis and pitch on the y-axis. The picture and the sound come from the same data, so the lines on screen are exactly the pitches you hear. You compose by placing **moments** on a timeline ("all voices to unison", "split into five voices", "move to D minor 9", "walk freely for 8 seconds"), and the engine works out every voice's path from them. You can also play it live from a computer keyboard or a MIDI controller.

## Status

Early development. Milestone M0 (scaffold, shared contracts and the AudioWorklet build pipeline) is built but not yet deployed; the site is a placeholder page that plays a test tone. See [PLAN.md](PLAN.md) for the design and the milestone plan (§15).

## Development

You need Node 22 LTS and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm dev          # Vite dev server at http://localhost:5173/
pnpm test         # unit, property, golden and DSP tests (Vitest)
pnpm test:perf    # timing and GC gates (load-sensitive; CI runs them)
pnpm lint         # ESLint (import boundaries, portable math in core/) and Prettier
pnpm typecheck    # TypeScript, strict
pnpm build        # production build into dist/ (base /algorhythms/ for GitHub Pages)
pnpm preview      # serve the production build
pnpm e2e          # Playwright on Chromium, Firefox and WebKit, against dev and prod builds
```

The first `pnpm e2e` needs the browsers: `pnpm exec playwright install chromium firefox webkit`.

Code layout, layer rules and the decisions log: [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/build-log.md](docs/build-log.md).

## Attribution

AlgoRhythms was inspired by the YouTube video **"Listen to this algorithm · Nebula"** by the channel **Bounce Gravity** (published 2026-10-24): [watch it on YouTube](https://www.youtube.com/watch?v=TnSs5w5F5YA).

AlgoRhythms is an independent implementation of the general technique (pitch-versus-time lines that drive oscillators). It is not affiliated with, endorsed by, or connected to the video's creator or channel, and it uses none of the video's material.

## FAQ

**Who owns the music I make?** Music you make with AlgoRhythms is yours. The license covers the code, not your output.

## License

Code: [MIT](LICENSE). Example pieces in `examples/`: CC0.
