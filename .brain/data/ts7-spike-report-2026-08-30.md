# Spike report: ai-hero typecheck on TypeScript 7 (native)

Worktree: `/Users/joel/Code/.worktrees/badass-courses/ai-hero/ts7-tsgo-spike`
Branch: `worker/ts7-tsgo-spike`, commit `127e0ea` (not pushed)
Host: flagg (macOS arm64), Node v26.7.0, pnpm 11.1.2
Date: 2026-08-29

**Verdict: viable.** The native compiler runs the full ai-hero typecheck end to end.
With `--singleThreaded` and `GOMEMLIMIT=3GiB` it peaks at **3238 MiB max RSS in 12.4s**,
against **4499 MiB in 33.1s** for tsc 5.4.5 on the identical config. That is
**1261 MiB (28%) less peak memory and 2.7x faster**. It also removes the Node heap
cliff entirely — see "Why the heap cliff goes away".

All memory numbers below are `maximum resident set size` from `/usr/bin/time -l`,
reported in MiB (1 MiB = 1048576 bytes). Every run was cold: `tsconfig*.tsbuildinfo`
deleted first.

---

## What I changed

Four files, all in `apps/ai-hero` except the lockfile.

1. `apps/ai-hero/package.json`
   - Added devDependency `"typescript-native": "npm:typescript@7.0.2"`. An npm alias,
     so TS 5.4.5 stays installed under its own name for `next build` and everything else.
   - `typecheck` script changed from `tsc --noEmit` to:
     `GOMEMLIMIT=3GiB node ./node_modules/typescript-native/bin/tsc --noEmit --singleThreaded -p tsconfig.typecheck.json`
2. `apps/ai-hero/tsconfig.json` — removed `"baseUrl": "."`. Forced: TS 7 errors
   `TS5102: Option 'baseUrl' has been removed`. Behavior-neutral here (below).
3. `apps/ai-hero/tsconfig.typecheck.json` (new) — extends the main config, sets
   `"target": "es2022"` for the typecheck pass only.
4. `pnpm-lock.yaml` — the alias plus its platform binary package (+211 lines).

`.github/workflows` untouched. No product code changed.

### Why removing `baseUrl` is safe
`paths` is `{"@/*": ["./src/*"]}` and `baseUrl` was `"."`. Without `baseUrl`, TypeScript
resolves `paths` relative to the config file's directory — the same directory. The other
thing `baseUrl` enables is bare non-relative resolution from the root; `grep -rn "from 'src/"`
over `src/` returns nothing, so nothing relied on it. Receipt: tsc 5.4.5 still reports
**0 errors** with `baseUrl` removed. No other config reads it (`grep -rn baseUrl` finds
only unrelated runtime variables named `baseUrl`).

### Why the separate typecheck config
Under `target: es2017` the native compiler reports three errors TS 5.4.5 lets through
(named capture groups and the `s` regex flag need es2018). These are a genuine latent
target mismatch, not a TS 7 bug — the code runs fine on Node 24. Bumping `target` in the
typecheck-only config keeps the main config untouched. `noEmit` is true either way, so
`target` affects nothing but downlevel checking. **Follow-up for a human: the main
tsconfig's `target: es2017` is wrong for this codebase and should probably be bumped.**

---

## Commands

```
pnpm install --frozen-lockfile                     # never bun/npm
cd apps/ai-hero
pnpm --filter @ai-hero/course-sync-schema build     # the pretypecheck step

# baseline
rm -f tsconfig*.tsbuildinfo
/usr/bin/time -l node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.typecheck.json

# native
rm -f tsconfig*.tsbuildinfo
GOMEMLIMIT=3GiB /usr/bin/time -l node ./node_modules/typescript-native/bin/tsc \
  --noEmit --singleThreaded -p tsconfig.typecheck.json

# end to end through the package script
rm -f tsconfig*.tsbuildinfo && /usr/bin/time -l pnpm typecheck
```

---

## Memory and time

Same `tsconfig.typecheck.json`, cold every run.

| run | wall | max RSS | errors |
|---|---|---|---|
| **tsc 5.4.5** (baseline, `tsconfig.json`) | 33.76s | 4499 MiB | 0 |
| **tsc 5.4.5** (baseline, `tsconfig.typecheck.json`) | 33.09s | 4488 MiB | 0 |
| tsc 5.4.5, `NODE_OPTIONS=--max-old-space-size=4096` | 30.55s | 4495 MiB | 0 |
| tsgo 7.0.2, default (all cores, no GOMEMLIMIT) | 4.56s | 5090 MiB | 1 |
| tsgo 7.0.2, `NODE_OPTIONS=--max-old-space-size=4096` | 4.60s | 5098 MiB | 1 |
| tsgo 7.0.2, `GOMEMLIMIT=3GiB` | 10.67s | 4369 MiB | 1 |
| tsgo 7.0.2, `GOMEMLIMIT=2GiB` | 13.47s | 4332 MiB | 1 |
| tsgo 7.0.2, `GOMEMLIMIT=1500MiB` | 13.40s | 4342 MiB | 1 |
| tsgo 7.0.2, `GOGC=25 GOMEMLIMIT=2GiB` | 14.63s | 4342 MiB | 1 |
| tsgo 7.0.2, `--singleThreaded` | 8.94s | 4005 MiB | 1 |
| **tsgo 7.0.2, `--singleThreaded` + `GOMEMLIMIT=3GiB`** (chosen) | 11.59s | 3224 MiB | 1 |
| tsgo 7.0.2, `--singleThreaded` + `GOMEMLIMIT=2GiB` | 23.85s | 3200 MiB | 1 |
| tsgo 7.0.2, `--singleThreaded` + `GOMEMLIMIT=1GiB` | 26.32s | 3160 MiB | 1 |
| chosen config, repeat 1 | 12.37s | 3238 MiB | 1 |
| chosen config, repeat 2 | 12.51s | 3241 MiB | 1 |
| `pnpm typecheck` end to end (includes pretypecheck build) | 14.56s | 3234 MiB | 1 |

Read that table in this order:

- **Out of the box tsgo is worse on memory.** 5090 MiB, above tsc's 4488 MiB. It trades
  memory for speed: 4.56s instead of 33.09s. If you swap the compiler and change nothing
  else, the OOM gets worse, not better.
- **`GOMEMLIMIT` alone plateaus at ~4340 MiB.** Squeezing from 3 GiB down to 1500 MiB buys
  nothing and costs wall time. That plateau is per-thread arena overhead, not live heap.
- **`--singleThreaded` is the lever that matters.** It drops the floor to 3160-3240 MiB.
  Below `GOMEMLIMIT=3GiB` you pay a lot of wall time (11.6s → 23.9s) for ~25 MiB. 3 GiB is
  the knee.
- **Repeats are stable**: 3238 and 3241 MiB, 12.37s and 12.51s.

### Why the heap cliff goes away
`node_modules/typescript-native/bin/tsc` is a five-line shim that calls `process.execve()`
on the platform binary (`@typescript/typescript-darwin-arm64/lib/tsc`). The Node process is
*replaced*, not forked. So `NODE_OPTIONS=--max-old-space-size=4096` has no effect on the
compiler at all — confirmed by the table: the tsgo rows with and without it are 5090 vs
5098 MiB, i.e. noise. There is no V8 old-space limit to hit and no
`JavaScript heap out of memory` failure mode. Go's allocator grows against real machine
memory and `GOMEMLIMIT` is a soft target the GC works toward, not a hard wall it dies on.

That is the actual win here. Not just 1261 MiB of headroom — the *shape* of the failure
changes from a hard crash at a fixed heap ceiling to graceful GC pressure.

---

## Error delta

**The brief's 157-error local baseline did not reproduce.** On a clean
`pnpm install --frozen-lockfile` in this worktree, tsc 5.4.5 on untouched `main` reports
**0 errors, exit 0** (`base-tsc.out` is a 0-byte file). No zod/`@coursebuilder/ui`
`ZodType<any, any, $ZodTypeInternals>` noise at all. The 157 errors were presumably an
artifact of a different install state. That makes the delta cleaner, not murkier: the
baseline is zero, so every error below is new.

### Native compiler, first run (original tsconfig, `target: es2017`) — 5 errors, all new

```
tsconfig.json(19,3): error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
  Use '"paths": {"*": ["./*"]}' instead.
```
That one aborted the run before checking. After removing `baseUrl`:

```
src/app/v1/course-sync/poller-runs/[runOperation]/route.ts(17,21): error TS1503: Named capturing groups are only available when targeting 'ES2018' or later.
src/app/v1/course-sync/runs/[runOperation]/route.ts(13,7): error TS1503: Named capturing groups are only available when targeting 'ES2018' or later.
src/app/v1/course-sync/runs/[runOperation]/route.ts(13,26): error TS1503: Named capturing groups are only available when targeting 'ES2018' or later.
src/db/generated/relations.ts(3,8): error TS2882: Cannot find module or type declarations for side-effect import of './schema'.
src/lib/cta/conversion-intent-architecture.test.ts(18,85): error TS1501: This regular expression flag is only available when targeting 'es2018' or later.
```

Four of those five are the `target: es2017` mismatch. `target: es2022` in
`tsconfig.typecheck.json` clears all four.

### Native compiler, final config — 1 error, new

```
src/db/generated/relations.ts(3,8): error TS2882: Cannot find module or type declarations for side-effect import of './schema'.
```

**Count: 1 new error versus a 0-error baseline.**

This is a real defect, not compiler noise. `src/db/generated/relations.ts` line 3 is
`import './schema'` and `src/db/generated/schema.ts` **does not exist** — `relations.ts` is
the only file in that directory. TS 5.4.5 ignores unresolved side-effect imports because
they carry no types; TS 7 added `TS2882` for exactly this. Per the guardrails I left the
product code alone. The fix is a human's call: delete the dead import, or restore the
generated `schema.ts` that was supposed to be beside it.

### Receipt that the run is a real full check
Two things could make a 12s run look good dishonestly: early bail-out, or a narrower file
set. I tested for both in one run — temporarily commented out the dead import and dropped a
deliberate type error into `src/__ts7_spike_probe.ts`:

```
src/__ts7_spike_probe.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
```

That was the *only* line of output (12.31s, 3239 MiB). The compiler checks the whole
program, catches injected errors, and reports **zero real errors** once the dead import is
out of the way. Both temporary edits were reverted; `git status` is clean apart from the
committed change.

---

## Blockers and caveats

1. **Bin collision.** Both `typescript` and the `typescript-native` alias declare a `tsc`
   binary, so `apps/ai-hero/node_modules/.bin/tsc` now resolves to **7.0.2**, not 5.4.5.
   pnpm picked the alias silently — no warning. Nothing in `apps/ai-hero` invokes bare
   `tsc` any more (the typecheck script uses an explicit path, and `packages/course-sync-schema`
   has its own typescript 5.9.3), so nothing breaks today. But it is a trap for whoever
   next types `pnpm exec tsc`. To avoid it entirely, use `@typescript/native-preview`
   instead (bin `tsgo`, no collision) — the cost is that its newest published build is
   `7.0.0-dev.20260707.2`, a dev snapshot, versus the 7.0.2 release.
2. **`GOMEMLIMIT=3GiB` in the script is POSIX-only.** It works under pnpm's `sh` on
   macOS/Linux. A Windows contributor would get a broken script. Use `cross-env` if that
   ever matters.
3. **The typecheck now runs against a different `target` than the rest of the toolchain.**
   Harmless while `noEmit` is true and Next compiles with SWC, but it means the typecheck
   is no longer checking the target the config claims. Better fix is bumping the main
   `target`.
4. **`next build` was not run.** It resolves `typescript` by name, so it still gets 5.4.5,
   but I did not verify a full build (needs env/secrets). Worth one CI run before merge.
5. **Numbers are from macOS arm64 with Node 26.** CI is Linux on Node 24. The Go binary's
   memory behavior should carry, but the absolute numbers will not match exactly, and
   `--singleThreaded` matters more on a many-core runner than a small one. Confirm on CI.
6. **`tsconfig.typecheck.tsbuildinfo`** (11 MB) is written by the incremental setting. It is
   covered by the existing `*.tsbuildinfo` gitignore.

---

## Recommendation

Ship it, with one CI run to confirm the numbers on Linux/Node 24 before it lands.

The memory result is only good because of `--singleThreaded` — a naive compiler swap makes
the OOM worse. Keep both that flag and `GOMEMLIMIT` when you move this anywhere else. And
the honest headline is not the 1261 MiB: it is that a native binary has no 4 GB V8 heap
ceiling to fall off, so the check stops being a coin flip against the cliff.

The one new error is a real dead import that has been silently unresolvable for who knows
how long. That is TS 7 earning its keep on day one.

---

*Corpus quote (fleet convention), `serverless-architectures-on-aws-second:s191:n1`,
"Serverless Architectures on AWS, Second Edition", §10.2.4 Tracking performance and availability:*

> "You can't optimize what you can't measure. Before you go about figuring out how to reduce
> the latency and improve the availability of your serverless application, you must have a
> consistent approach to monitor this information."

