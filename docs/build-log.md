# Build log: deviations and decisions

Newest milestone first. Each entry says what departs from (or fills a gap in) PLAN.md, and why. PLAN.md itself is owned by the integrator and is not edited by builders.

---

## M1b: compiler, voice leading, interruption, query API (2026-11-19, in progress)

### Contract change (additive): cut segments, `Segment.curve`, flat layout v2
§7.5 step 1 says "truncate S at tᵢ". The M0 `Segment` cannot represent a truncated eased glide: x is normalised over [t0, t1], so moving t1 changes the curve's shape, and no restriction of e.g. smootherstep to a sub-interval lies in the family p0 + Δ·e(x) + m0·H(x). Without a fix, either the part of the glide that already sounded would change shape after the fact, or C⁰ and P1 would break.
- **`Segment.curve?: { t1, p1 }`** (types.ts): present only on a cut segment. It holds the *planned* end time and target, and the curve keeps that parametrisation: x = (t − t0)/(curve.t1 − t0), p = p0 + (curve.p1 − p0)·e(x) + m0·H(x). `t1`/`p1` stay the segment's *real* end and its pitch there, so contiguity (seg[i].t1 === seg[i+1].t0), exact joins (seg[i].p1 === seg[i+1].p0) and every consumer that reads only t0/t1/p0/p1 are unaffected.
- **segment.ts:** `segmentPitch` and `segmentVelocity` take two optional trailing parameters `curveT1 = t1`, `curveP1 = p1`; for uncut segments the arithmetic is bit-identical to M0's. `evalSegment`, `evalSegmentVelocity` and `evalFlatSegment` read the cut fields.
- **New in segment.ts:** `segmentMotion` / `evalSegmentMotion` / `evalFlatSegmentMotion`: motion 0..1 = sin(π·x) over the planned glide, 0 on holds (§7.9 `motionAt`). It lives in the leaf so that the DSP's accent term (§8.4) and the renderer read the same value (P1).
- **flat.ts:** segment records gain `SEG_CURVE_T1` (11) and `SEG_CURVE_P1` (12), always filled (equal to t1/p1 when uncut); **`SEG_STRIDE` is 13** and **`FLAT_LAYOUT_VERSION` is 2**. Existing offsets are unchanged. `unflatten` restores `curve` only when it differs from (t1, p1).
- **M2:** use `evalFlatSegment` / `evalFlatSegmentMotion` and the constants, as before; nothing else changes.

---

## M0: scaffold, shared contracts, worklet pipeline (2026-11-19)

### Toolchain
- Node 22.23.5 (Homebrew `node@22`, keg-only but linked into `/opt/homebrew/bin`), pnpm 12.18.0 (Homebrew), gh 2.103.3 (not logged in).
- **TypeScript 6.0.3, not the current 7.x.** typescript-eslint 8.73 (the newest) supports only `typescript < 6.1`. Revisit when typescript-eslint supports 7.
- Vite 8.3 (Rolldown), @vitejs/plugin-react 6, React 18.3, Zustand 5, Zod 4 (`z.looseObject` for the passthrough rule of §5), fflate 0.8, Vitest 5, fast-check 4, Playwright 1.65, ESLint 10 (flat config), typescript-eslint 8, eslint-plugin-react-hooks 7, Prettier 3. All MIT or Apache-2.0.
- No `@types/audioworklet`: worklet globals are declared in `src/audio/worklet/audioworklet-globals.d.ts` instead (about 60 lines), to avoid a dependency and its DOM-lib conflicts.

### Deviation: the DSP imports `core/ease` and `core/segment` by value (option b)
§14 says `dsp` imports only *types* from `core`. Pitch evaluation must be the same code on the main thread (compiler, renderer, MIDI) and the audio thread (P1), so:
- `dsp` may value-import exactly two pure leaf modules, **`core/ease.ts`** and **`core/segment.ts`**. Everything else in `core` is type-only (`import type …`, declaration form; inline `import { type X }` is rejected because it leaves a runtime import under `verbatimModuleSyntax`).
- Both are **leaves**: `ease.ts` imports only types; `segment.ts` imports only types and `ease.ts`. The lint rule enforces this, so the DSP can never pull in the compiler transitively.
- **The flat record layouts (strides and offsets) live in `core/segment.ts`**, not `core/flat.ts`, because the DSP must read lives, levels, timbre changes and voice params as well as segments, and it may import only the two leaves. `core/flat.ts` re-exports every constant, so main-thread code imports them from `flat.ts` as the task specified.
- The portable helpers `sinPi`, `cosPi` and `exp2` live in `ease.ts`, because ease.ts must stay a leaf and the cosine and expo eases need them. **M1: `core/math.ts` should re-export them rather than duplicate them.**

### Decision: import boundaries are a local ESLint rule
`no-restricted-imports` matches specifier strings, and a relative path like `../dsp/x` lands in different layers depending on how deep the importing file is. `eslint.boundaries.js` resolves each specifier against the importing file and judges the layer it actually lands in (static imports, `export … from`, and dynamic `import()`). It also forbids `src/` files outside `app/` from importing anything outside `src/`. Messages cite PLAN.md §14. `tests/unit/lint-rules.test.ts` proves every rule fires, using the ESLint API with in-memory code.

### Additions to the §7.11 lint ban
- In `core/`, besides `Math.sin`, `cos`, `tan`, `pow`, `exp`, `log`, `log2`, `log10` and `random`, the ban also covers `asin`, `acos`, `atan`, `atan2`, the hyperbolic functions, `expm1`, `log1p`, `cbrt` and `hypot`. None of these is required to be correctly rounded, so they carry the same cross-engine risk. `**` is allowed only with a non-negative integer literal exponent, and `**=` is banned.
- `Date` and `performance` (wall-clock time) are banned in both `core/` and `dsp/`; `Math.random` is banned in both.

### Decision: P3 ("no DOM in core or dsp") is enforced by the typecheck
`tsc -b` checks four projects:
- `tsconfig.pure.json` (core, dsp): `lib: ES2023` with no DOM, so `window`, `AudioContext` and friends are type errors;
- `tsconfig.worklet.json` (`src/**/*.worklet.ts`): no DOM, plus the AudioWorkletGlobalScope declarations;
- `tsconfig.app.json` (everything else in `src`): DOM;
- `tsconfig.node.json` (config files and tests): Node, plus DOM for Playwright's `page.evaluate` callbacks.

`noUncheckedIndexedAccess` is off on purpose. With it, every typed-array read in the DSP would need a `!`.

### Decision: how the worklet is loaded (§14's "fiddly" part)
- `import url from './worklet/x.worklet.ts?worker&url'`. Vite treats the file as a worker entry and returns its URL without constructing a Worker.
  - In **dev** the URL is `/src/audio/worklet/test-tone.worklet.ts?worker_file&type=module`; its imports of `dsp/` and `core/` are fetched as separate ES modules, which module worklets allow.
  - In **production** the worklet and its imports are bundled into one ES module, `assets/test-tone.worklet-<hash>.js`, under the base path.
- `worker.format: 'es'` (the AudioWorklet module is a module script; M2's export worker should be created with `{ type: 'module' }`).
- A plain `new URL('./x.ts', import.meta.url)` would copy the uncompiled .ts file into the build, so it is not used.
- Convention for M2: name worklet-scope entry files `*.worklet.ts`. They get the worklet tsconfig and globals automatically.
- **Vite `base`:** `/algorhythms/` for `vite build` *and* `vite preview` (preview serves the build, so it needs the same base), and `/` for `vite dev`. The env var `ALGORHYTHMS_BASE` overrides it; CI sets it to `/<repository name>/`, so forks work.

### Contract decisions in `src/core/types.ts`
- **Parsed form.** The types describe a piece *after* the M1 Zod schema has filled defaults. Fields marked `@default` may be omitted in files. Optional (`?`) fields may be absent even after parsing. This mirrors the §6.2 table: `voicing` and `assign` are required with defaults ('even', 'ordered'); `register`, `split.notes` and `walk.bass` stay optional.
- **Moments:** a discriminated union `Moment` over the ten v1 types, plus `MomentOf<'walk'>`. The `timbre` moment (M6) is not in the union yet.
- **Keys:** `PitchClass` is the 17 common spellings ('C', 'C#', 'Db', …). `ScaleRef` is a built-in `ScaleName` (major, minor, the modes, harmonic and melodic minor, both pentatonics, blues, whole-tone, chromatic) or `{ kind: 'custom', intervals }`. M1 implements the tables.
- **`VoiceDef.sends?`** (per-voice reverb/delay send overrides) is new. `MixSettings.sends` holds the defaults.
- **`MixSettings`** (designed from §8.6): `reverb {size, decay, damping, preDelay, returnLevel}`, `delay {time, feedback, returnLevel}`, `sends {reverb, delay}`, `tone {tilt, lowpassHz}`, `limiter {ceilingDb}`, `panAuto: 'index' | 'pitch'`. Levels are linear.
- **`ViewSettings`:** `window`, `colors` ('ink' | 'voice' | 'pitch' | 'custom'), `hud`, `gridBpm?`, `futureOpacity?` (default 0), `playheadX?` (default 0.78). Theme is a user preference, not piece data.
- **`CompiledScore` extensions:**
  - `keys` (the key timeline; first entry at t = 0);
  - `referenceHz` and `seed`, so the DSP needs only the compiled score.
- **`CompiledVoice` extensions:**
  - `index` (pool index);
  - static `gain`, `pan`, `mute`, `solo` and `sends`, for the same reason.
  - `voices` holds **every pool voice in pool order**, including voices that never sound (with empty `lives`).
- **`Life` semantics** (§7.9 left them open):
  - `born` is the *audible* onset (the start of the fade-in, and the t0 of the life's first segment);
  - `died` is the *end* of the fade-out, so the fade-out runs over [died − fadeOut, died];
  - an absent `died` means the voice is alive at the end;
  - the "active from the birth moment's time" state of §7.1 is internal to the compiler;
  - the fade *shape* is M2's choice, and MIDI CC11 must follow it.
- **Level timeline:** the level is 1 before the first entry, and each entry ramps linearly in amplitude from the level in effect at `t`. **Timbre timeline:** the first entry is `{ t: 0, preset: VoiceDef.timbre, fade: 0 }`.
- **`Diagnostic.code`** (a required, stable kebab-case string) is new, so tests and the UI can match diagnostics without parsing messages.
- Constants: `PIECE_FORMAT = 'algorhythms'`, `PIECE_VERSION = 1`, `MAX_VOICES = 32`.

### Decisions in `core/ease.ts` and `core/segment.ts`
- **`expo`:** ease-in-out exponential, *normalised* so that it passes exactly through 0, 1/2 and 1: e(x) = (2^(20x−10) − 2^−10) / (2(1 − 2^−10)) for x ≤ 1/2, mirrored above. The common definition jumps by 2^−11 at each end, which would break C⁰ continuity. Its e′(0) = 10·ln2/1023 ≈ 0.00678, so it is not 0.
- **`cosine`:** uses a degree-17 odd Taylor polynomial for sin(πu), normalised so that it is exact at ±1/2; the error is below 1e-14.
- **Clamping:** the standard eases are clamped to [0, 1], because rounding gave 1.0000000000000002 near x = 1. They are monotone up to rounding (1 ulp).
- **`bezier`:** CSS cubic-bezier, solved by Newton's method (to |Δx| < 1e-14) and then bisection to full precision. `easeSlope0` follows the CSS extrapolation rule (the tangent through P1 if x1 > 0, else through P2 if x2 > 0, else 0). A vertical tangent returns ±Infinity from `easeDeriv`. Curves with vertical tangents are ill-conditioned for any double-precision solver (about 3e-6 near the tangent), which is still within the 1e-4 requirement.
- Each function has two forms: allocation-free scalar `…Raw(code, x, x1, y1, x2, y2)` functions for the audio thread, and object-taking wrappers (`ease(code, x, bezier)`, `easeDeriv`, `easeSlope0`).
- **`easeDeriv` (e′ everywhere) and `evalSegmentVelocity` are new.** The compiler needs the velocity at any interruption time, not just e′(0) (§7.5).
- `evalSegment` returns p0 before t0 and p1 from t1 on, *by branch*, so the endpoints are exact. A zero-length segment is a step at t0. H(x) is computed as x(1 − x)².

### Decisions in `core/flat.ts`
- **Segment records:** stride 11 (t0, t1, p0, p1, easeCode, x1, y1, x2, y2, m0, clamped).
  - Non-bézier eases store (0, 0, 1, 1).
  - Life stride 4, with `died = +Infinity` when open. Level stride 3. Timbre stride 3 (the preset is an index into `timbreNames`).
  - Voice params stride 7: gain, pan (NaN = auto), mute, solo, reverb send (NaN = default), delay send (NaN = default), and the id hash.
- **Version:** `FLAT_LAYOUT_VERSION = 1`. Bump it on any change.
- **Voice-id hash:** the per-voice hash for seeding detune and phase is **FNV-1a 32-bit** (integer operations only). If M1 prefers `rng.hash32`, switch `hashVoiceId` to it; the layout doesn't change, but the seeded detune of existing pieces would.
- **Not carried:** moment spans, diagnostics, keys and `Segment.momentId`. `unflatten` returns them empty and canonicalises optional fields.
- `transferList(flat)` lists each ArrayBuffer once. The arrays are typed `Float64Array<ArrayBuffer>`, so `.buffer` is transferable.

### M0 placeholders (to be replaced later)
- `src/dsp/test-tone.ts`: a 4096-point sine table with linear interpolation and smootherstep fades. `src/audio/worklet/test-tone.worklet.ts` and `src/audio/test-tone.ts` load it. M2 may delete or absorb them.
- `src/app/debug.ts` sets `window.__algorhythms = { workletUrl, processorName, context?, analyser? }` for the e2e tests. M3 should replace this with whatever the player tests need.

### Tooling decisions
- `pnpm lint` runs `eslint .` and then `prettier --check .`. Prettier ignores Markdown (PLAN.md and CLAUDE.md belong to the integrator, and prose is written by hand) and `prototype/`.
- **e2e:** each engine runs as a `<engine>-dev` project against `vite` on port 5180, and as a `<engine>-prod` project against `vite build && vite preview` on port 4180, at `/algorhythms/`. CI selects them with `--project='webkit-*'` and similar patterns.
- **CI** starts a PulseAudio null sink on Ubuntu so that live AudioContexts have an output device. Whether live audio runs on GitHub's macOS runners is **unverified** until the first CI run; the offline-render test doesn't depend on a device.

### Open items
- The README attribution links to a YouTube *search* for the video's title, because the direct URL couldn't be found from here. The owner should replace it (there is a TODO comment in README.md).
- M0's acceptance ("CI is green, the site is live") needs a GitHub remote, Pages source set to "GitHub Actions", and a first push.

### Local results (macOS 26.4, Apple Silicon, headless)

| Engine | `vite dev` | production build (`vite preview`) |
|---|---|---|
| Chromium 159 | pass (4/4) | pass (4/4) |
| Firefox 159 | pass (4/4) | pass (4/4) |
| WebKit 27.2 | pass (4/4) | pass (4/4) |

The four tests are:
1. the page title;
2. the worklet URL comes from the expected pipeline;
3. an OfflineAudioContext render is 440 ± 1 Hz at the requested amplitude;
4. the Play button gives a live 440 ± 2 Hz sine (RMS > 0.1) through an AnalyserNode in a running AudioContext.
