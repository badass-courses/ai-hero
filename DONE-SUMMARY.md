DONE

# Phase 4 workshop static hardening

Branch: `worker/static-hardening-phase4`

Task claim: `/Users/joel/Code/badass-courses/aihero-support/.brain/tasks/aih-static-phase4-workshops.svx` has `assignee: "p4-worker"`.

## Route receipts

- `/workshops` is a static anonymous page. It reads cached public workshop rows and anonymous pricing only. Session, editor inventory, purchases, and personalized prices now hydrate through client tRPC queries.
- `/workshops/[module]` is on-demand Incremental Static Regeneration (ISR). `dynamic = 'force-static'`, `dynamicParams = true`, and an empty `generateStaticParams()` let the first request create the cache entry without a build-time database fan-out. The cached shell contains marketing copy, the curriculum outline, anonymous pricing, and links only for curriculum rows marked `tier: free`.
- Member ability, progress, editor controls, GitHub/start actions, purchased state, and member pricing hydrate after the static shell. The server render does not read the session.
- `/workshops/[module]/[lesson]` stays dynamic on purpose. It is now explicit `dynamic = 'force-dynamic'` and no longer enumerates lessons during the build. The existing server ability check still runs before MDX compilation, transcript loading, or Mux playback lookup. Paid lesson bodies and playback IDs therefore never enter a static artifact.
- Exercise and solution lesson variants inherit the dynamic, session-aware lesson layout and remain dynamic.

## Middleware and organization context

`/workshops/:path*` left the proxy matcher. A cached workshop hit therefore no longer pays the middleware NextAuth/database read. The matcher tests now treat workshop index, module, and lesson URLs as excluded.

Member tRPC calls still use the Phase 1 session callback. It resolves organization context from the request header, the `organizationId` cookie, or the first active learner/owner role. `REDIRECT_TO_ORG_LIST` and `SET_OWNER_ORG` still run on the remaining matched member and commerce routes.

Residual edge: a direct workshop visit no longer redirects a signed-in multi-org user to `/organization-list` or writes the selected-org cookie. Users with no active learner/owner role and no existing cookie resolve with no organization. Users with several learner/owner roles get the resolver's first default until they select an organization on a matched surface.

## Route table

Before: the untouched `0b904fb` build compiled and typechecked, then failed while collecting `/workshops/[module]/[lesson]` data with a database error. Next did not print a route table. The original index and module code read `searchParams` and `getServerAuthSession()` during rendering; the lesson route also enumerated every workshop and lesson at build time.

After, from the successful production build:

```text
├ ○ /workshops                                              10m      1y
├ ○ /workshops/[module]
├ ƒ /workshops/[module]/[lesson]
├ ƒ /workshops/[module]/[lesson]/edit
├ ƒ /workshops/[module]/[lesson]/exercise
├ ƒ /workshops/[module]/[lesson]/solution
├ ƒ /workshops/[module]/[lesson]/solution/edit
├ ƒ /workshops/[module]/edit
└ ƒ /workshops/new
```

`○` is static content. The module path is generated on first request and cached. `ƒ` is request-time rendering.

## Verification

- `pnpm --filter ai-hero typecheck`: pass.
- Workshop component, progress, and proxy matcher suite: 12 files and 74 tests passed. The final curriculum change also passed its focused 8-test rerun.
- Production build with `/Users/joel/Code/badass-courses/ai-hero/apps/ai-hero/.env.vercel`: exit 0. No environment values were copied or printed.
- Anonymous `next start` smoke on `/workshops`: `200`, `x-nextjs-cache: HIT`, `x-nextjs-prerender: 1`, `Cache-Control: s-maxage=600`.
- Anonymous module smoke on `/workshops/ai-sdk-v6-crash-course`: first request `MISS`, second request `HIT`, both `200` with `x-nextjs-prerender: 1` and `s-maxage=600`.
- The module HTML linked the free preview `/what-is-the-ai-sdk~9cogs` once and did not link paid `/calling-tools~476vh`.
- Direct anonymous paid-lesson smoke returned `307` to the module page with `Cache-Control: private, no-cache, no-store`. Its response contained no lesson `<article>` and no playback ID.
- Anonymous index, module, and denied paid-lesson HTML contained no serialized `userId`, purchases, session-cookie names, Mux playback ID, `New Workshop`, or Edit control.
- Static entry files and their server pricing component contain no `getServerAuthSession`, `cookies()`, or `headers()` call. Paid lesson source order is ability lookup, `canViewLesson` redirect, then `compileMDX`; video lookup is also conditional on `canViewLesson`.
- `git diff --check`: pass.

An accidental full-suite run reached 1,565 passing tests and found two unrelated failures in Phase 3-owned skill files: the existing router invariant in `skills-hero.test.tsx` and stale copy expectation in `skills-install-options.test.tsx`. This branch does not touch those files.

The production prebuild also reported two existing CTA declaration flags for Phase 3 skill pages. The build itself completed successfully.
