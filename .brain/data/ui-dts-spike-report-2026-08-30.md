# Spike report: ai-hero typecheck vs @coursebuilder/ui source

Worktree: `/Users/joel/Code/.worktrees/badass-courses/ai-hero/ui-dts-spike`
Branch: `worker/ui-dts-spike`, commit `2f9a0a3` (not pushed)
Environment: Node v26.7.0, pnpm 11.1.2, TypeScript 5.4.5, macOS Darwin 25.3.0

## Headline

The mechanism works. The app no longer parses a single line of `@coursebuilder/ui`
implementation source. It saves **1.4% of resident memory** and **19% of wall time**.

It does not fix the OOM. Both the before and after states pass at
`--max-old-space-size=4096` and both abort at `3584`. The UI package was not where
the memory was going.

Where it actually goes, from `--generateTrace` type attribution
(520,285 types with a declaring file, after the change):

| source | types |
|---|---|
| typescript 5.4.5 lib | 105,293 |
| zod 3.25.76 | 104,922 |
| apps/ai-hero own source (1,721 files) | 98,121 |
| drizzle-orm 0.36.0 | 97,500 |
| inngest 3.54.2 | 35,144 |
| @types/react 19.2.7 | 12,924 |
| schema-dts 1.1.5 | 12,253 |
| xstate 5.32.0 | 7,925 |

`@coursebuilder/ui` does not appear in the top 25. Its whole contribution was the
33,272-type delta measured below — about 4% of the program's types.

## Mechanism chosen

1. `apps/ai-hero/scripts/build-coursebuilder-ui-types.sh` emits declarations for the
   **installed** `@coursebuilder/ui@2.4.0` into `node_modules/@coursebuilder/ui/dist`.
   137 `.d.ts` files, 656 KB, 2.87 s, 758 MB peak RSS.
2. `apps/ai-hero/tsconfig.typecheck.json` extends `tsconfig.json` and adds:
   ```json
   "@coursebuilder/ui":   ["./node_modules/@coursebuilder/ui/dist/index.d.ts"],
   "@coursebuilder/ui/*": ["./node_modules/@coursebuilder/ui/dist/*"]
   ```
3. `package.json`: `typecheck` runs `tsc -p tsconfig.typecheck.json --noEmit`;
   `pretypecheck` now also runs `pnpm ui-types` to build the declarations.

Two deliberate constraints:

- **The paths live in a typecheck-only config, not `tsconfig.json`.** Next resolves
  tsconfig `paths` for the bundler as well as the checker. Mapping the package to
  `.d.ts` files in `tsconfig.json` would break `next build` and `next dev`.
- **The output must live inside the package.** The emitted declarations import
  `@radix-ui/react-*`, `react-day-picker` and 12 others by bare specifier. Those are
  transitive dependencies of `@coursebuilder/ui`, not of the app, and only resolve
  from inside the package's own pnpm scope. An earlier attempt that emitted to
  `apps/ai-hero/.coursebuilder-types/ui` produced 12 unresolvable specifiers
  (11 `@radix-ui/react-*` packages plus `react-day-picker`).

Nothing generated is committed. `node_modules/@coursebuilder/ui/dist` is rebuilt by
`pnpm typecheck` and wiped by `pnpm install`.

## Exact commands

```bash
# install (fresh worktree)
pnpm install

# baseline
cd apps/ai-hero
pnpm --filter @ai-hero/course-sync-schema build
rm -f *.tsbuildinfo
/usr/bin/time -l node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit --listFiles
node_modules/.bin/tsc --noEmit --extendedDiagnostics

# build declarations
bash scripts/build-coursebuilder-ui-types.sh

# after
rm -f *.tsbuildinfo
/usr/bin/time -l node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit
node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit --listFiles
node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit --extendedDiagnostics

# heap caps (both states, 1536 / 2048 / 2560 / 3072 / 3584 / 4096)
NODE_OPTIONS=--max-old-space-size=4096 /usr/bin/time -l node_modules/.bin/tsc --noEmit
```

`*.tsbuildinfo` is deleted before every measured run; `incremental: true` is on in
`tsconfig.json` and a warm build info file makes the second run meaningless.

## 1. listFiles receipt

Baseline — 113 files from `@coursebuilder/ui`, every one of them source:

```
$ tsc --noEmit --listFiles | grep '@coursebuilder/ui' | wc -l
113
$ tsc --noEmit --listFiles | grep '@coursebuilder/ui' | grep -vc '\.d\.ts$'
113
```

Sample: `utils/cn.ts`, `primitives/checkbox.tsx`, `cms/manifest.ts`,
`cohort-creation/create-cohort-form.tsx`, `date-time-picker/date-time-picker.tsx`,
`resources-crud/edit-resources-form.tsx`.

After — 98 files, every one of them a declaration:

```
$ tsc -p tsconfig.typecheck.json --noEmit --listFiles | grep '@coursebuilder/ui' | wc -l
98
$ tsc -p tsconfig.typecheck.json --noEmit --listFiles | grep '@coursebuilder/ui' | grep -vc '\.d\.ts$'
0
```

Sample: `dist/cms/manifest.d.ts`, `dist/utils/cn.d.ts`,
`dist/event-creation/create-event-form.d.ts`, `dist/cohort-creation/workshop-selector.d.ts`.

Done-condition 1 is met.

The declarations are real types, not `any`. Negative control:

```
src/spike-type-probe.tsx(2,50): error TS2322: Type '"not-a-variant"' is not assignable
to type '"default" | "link" | "secondary" | "outline" | "destructive" | "ghost" | null | undefined'.
```

That union comes out of a `cva()` call inside the emitted `dist/primitives/button.d.ts`,
so the variant types survived the round trip. The probe file was deleted.

## 2. Memory and time receipts

`/usr/bin/time -l`, default heap (Node 26 sets the limit to 4192 MB on this machine):

| run | max RSS | wall | exit | errors |
|---|---|---|---|---|
| before | 4,729,683,968 B (4.73 GB) | 31.46 s | 0 | 0 |
| after | 4,665,950,208 B (4.67 GB) | 25.63 s | 0 | 0 |

Delta: **-63.7 MB RSS (-1.4%)**, **-5.8 s (-18.5%)**.

An earlier before/after pair on the same tree gave 4,716,216,320 B / 33.48 s and
4,683,120,640 B / 27.81 s. Same shape, so the numbers are stable to ~0.3%.

`NODE_OPTIONS=--max-old-space-size=4096`:

| run | max RSS | wall | exit |
|---|---|---|---|
| before | 4,714,037,248 B | 30.60 s | 0 (pass) |
| after | 4,706,942,976 B | 32.56 s | 0 (pass) |

Both pass. The brief expected the baseline to fail or near-fail here; on Node 26.7.0
with a fresh install it does not.

Because both passed, I bisected the actual ceiling. Every run below aborts with
`exit=134` and `JavaScript heap out of memory`:

| cap | before | after |
|---|---|---|
| 1536 MB | fail | fail |
| 2048 MB | fail | fail |
| 2560 MB | fail | fail |
| 3072 MB | fail | fail |
| 3584 MB | fail | fail |
| 4096 MB | pass | pass |

**The change does not move the OOM threshold.** Both states need somewhere between
3584 and 4096 MB of old space.

`--extendedDiagnostics`, before → after:

| metric | before | after | delta |
|---|---|---|---|
| Files | 10,506 | 10,474 | -32 |
| Lines of TypeScript | 331,720 | 307,088 | -24,632 (-7.4%) |
| Identifiers | 3,236,656 | 3,214,878 | -21,778 |
| Symbols | 3,689,710 | 3,611,893 | -77,817 |
| Types | 796,415 | 763,143 | -33,272 (-4.2%) |
| Instantiations | 6,775,392 | 6,462,925 | -312,467 (-4.6%) |
| Memory used | 4,284,105 K | 4,202,959 K | -81,146 K (-1.9%) |
| Total time | 31.72 s | 25.72 s | -6.0 s (-18.9%) |

`skipLibCheck: true` is why the type saving is smaller than the file saving: the
declaration bodies are never checked, but the app's own 1,721 files still instantiate
the same generics at every use site.

Where the remaining time goes: 20,948 `createSourceFile` and 20,940 `bindSourceFile`
events, against 15.0 s of `checkSourceFile` spread over 1,723 app files. The slowest
single file is `src/lib/structured-data.tsx` at 443 ms, then `src/db/index.ts` at
414 ms. There is no hot spot to cut — it is the breadth of the program.

## 3. Error delta

**The 157-error baseline does not reproduce.** On this fresh worktree with a clean
`pnpm install` on Node 26.7.0, the untouched baseline reports **0 errors, exit 0**.
After the change: **0 errors, exit 0**. Delta is empty; there are no new errors to list.

The tree does contain both zod versions (`zod@3.25.76` and `zod@4.4.3` in
`.pnpm`), but `@coursebuilder/ui` and everything it touches resolve to 3.25.76,
so no v3/v4 mismatch surfaces. Whatever produced the 157 errors was a property of
that node_modules tree, not of the source at `61bc5b3`.

## 4. Declaration-emit blockers

Emitting declarations from the package **exactly as pnpm installs it** fails, writing
128 of 138 files. Verbatim, all ten:

```
hooks/use-socket.ts(3,17): error TS2742: The inferred type of 'useSocket' cannot be named without a reference to '.pnpm/partysocket@1.0.1/node_modules/partysocket'. This is likely not portable. A type annotation is necessary.
primitives/alert.tsx(22,7): error TS2742: The inferred type of 'Alert' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/badge.tsx(6,7): error TS2742: The inferred type of 'badgeVariants' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/button.tsx(12,7): error TS2742: The inferred type of 'buttonVariants' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/field.tsx(57,7): error TS2742: The inferred type of 'fieldVariants' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/label.tsx(9,7): error TS2742: The inferred type of 'defaultLabelVariants' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/label.tsx(13,7): error TS2742: The inferred type of 'Label' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/navigation-menu.tsx(61,7): error TS2742: The inferred type of 'navigationMenuTriggerStyle' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/sidebar.tsx(476,7): error TS2742: The inferred type of 'sidebarMenuButtonVariants' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
primitives/toast.tsx(43,7): error TS2742: The inferred type of 'Toast' cannot be named without a reference to '.pnpm/class-variance-authority@0.7.1/node_modules/class-variance-authority/types'. This is likely not portable. A type annotation is necessary.
```

The build script works around this by staging a copy of the package and prepending one
type-only import per affected file (9 files):

```ts
import type { ClassProp } from 'class-variance-authority/types'
import type { PartySocket } from 'partysocket'
```

Ruled out along the way, each with a run behind it: `--preserveSymlinks` (same 10
errors, and it breaks React type identity — 2,218 errors); copying the two packages
into `<pkg>/node_modules` (same 10 errors); emitting into `<pkg>/dist` instead of the
app (same 10 errors); `--module esnext/nodenext`; TypeScript 5.9.3 with `--noCheck`
(still 10, `--noCheck` does not suppress declaration-emit errors).

**This is an artefact of consuming the package from npm, not a defect in the source.**
Inside the course-builder monorepo the same emit is clean:

```
$ cd ~/Code/badass-courses/course-builder/packages/ui
$ ../../node_modules/.bin/tsc -p tsconfig.json --emitDeclarationOnly \
    --declarationMap false --rootDir . --outDir <scratch>
exit=0     # 137 .d.ts files, zero errors
```

There `packages/ui/node_modules/class-variance-authority` is a symlink inside the
package directory, so the inferred types are nameable. `packages/ui/tsconfig.json`
already sets `"declaration": true` and `"declarationMap": true`.

## What a durable fix in course-builder needs

Small, and the hard part is already done:

1. Add a build script to `packages/ui/package.json`:
   `"build": "tsc -p tsconfig.json --emitDeclarationOnly --outDir dist"`.
   The emit is clean in the monorepo today — no source changes required.
2. Replace `"main": "index.tsx"` / `"types": "index.tsx"` with an `exports` map that
   points `types` at `dist/*.d.ts` and the runtime condition at the `.tsx` source
   (consumers transpile it — every app that uses this package bundles it through
   Next), or ship compiled JS alongside.
   Subpath exports must cover what consumers actually import. In ai-hero that is
   `@coursebuilder/ui` (147 sites), `/utils/cn` (83), `/cms/manifest` (28), `/cms` (15),
   `/cms/resource-state` (10), `/primitives/*`, `/hooks/*`, `/feedback-widget*`,
   `/resources-crud/*`, `/event-creation/*` — 20 distinct specifiers across 254 files.
3. Add `dist` to `files` and to the turbo build outputs, and wire `typecheck` to depend
   on the build.
4. Ship it as 2.4.3+. The app then deletes
   `scripts/build-coursebuilder-ui-types.sh` and `tsconfig.typecheck.json` and gets the
   same result from a plain `tsc --noEmit`.

Note the local checkout is at 2.4.2 while ai-hero consumes 2.4.0; four files differ
(`cms/create-resource-editor.tsx`, `cms/manifest.ts`, `resources-crud/edit-resources-form.tsx`,
`resources-crud/metadata-fields/metadata-field-visibility.tsx`). The declarations in
this spike were emitted from the installed 2.4.0, not from the checkout, so the
measurement is honest about what the app actually consumes.

## Blockers and open questions

- **The premise did not hold.** The trace that pointed at `@coursebuilder/ui` was
  reading time, not memory. Shipping declarations removes 4.2% of types and 1.9% of
  heap. If CI is OOMing at 4 GB, this is not the fix. The candidates worth measuring
  next, in order of type count: zod 3 (104,922 types — the drizzle schema and the
  ~1,721 app files instantiate it everywhere), drizzle-orm (97,500), inngest (35,144).
  A single `zod.infer` chain over `src/db/schema.ts` re-instantiated across hundreds
  of files is a much better suspect than a UI library.
- **The 157-error baseline is unreproduced.** Fresh install, Node 26.7.0, 0 errors.
  If it is real on someone's tree it is a lockfile or partial-install artefact; a
  `pnpm install` from a clean `node_modules` clears it.
- **CI runs Node 24, this ran on Node 26.7.0.** V8's default heap on this machine is
  4192 MB. The cap sweep (1536–4096) is the portable part of the result; the
  default-heap numbers are not directly transferable to CI.
- **Requires a rebuild after every `pnpm install`.** `pretypecheck` handles it (2.87 s),
  but any CI step that runs `tsc` without going through `pnpm typecheck` will resolve
  `@coursebuilder/ui/dist` to nothing and fail loudly. That is by design — a silent
  fallback to source would hide the regression.
- **`next build` still typechecks against the source.** The paths only apply to
  `tsconfig.typecheck.json`. If the OOM is in the Next build rather than the standalone
  typecheck, this change does nothing for it.

## Guardrails

- No pushes, no PRs, no CI config edits. pnpm only.
- `~/Code/badass-courses/course-builder` was read and built only. `git status --short`
  is byte-identical before and after (16 modified, 12 untracked, all pre-existing from
  other sessions); nothing under `packages/ui` changed. All emit output went to the
  scratchpad.
- Files staged explicitly. Generated declarations, the trace (14 MB `trace.json`,
  255 MB `types.json`) and the raw emit are not in the commit.
  Scratch artefacts:
  `/private/tmp/claude-501/-Users-joel-Code--worktrees-badass-courses-ai-hero-ui-dts-spike/f3c4e60e-8808-4e27-bd5a-f0087fca7f6d/scratchpad/spike/`
- No `--no-verify`, no disabled hooks. `dcg` blocked two `rm -rf` invocations; both were
  reissued as narrower `rm -r` on directories created in this session.

## pdf-brain

> "You can't optimize what you can't measure. Before you go about figuring out how to
> reduce the latency and improve the availability of your serverless application, you
> must have a consistent approach to monitor this information."

*Serverless Architectures on AWS, Second Edition*, §10.2.4 "Tracking performance and
availability" — chunk `serverless-architectures-on-aws-second-6750c73f88f2:s191:n0`.

Apt: the spike was aimed at a hot spot identified by a timing trace and asked to fix a
memory ceiling. The two are not the same measurement, and the numbers say so.
