# Navigation Redesign

Redesign AIHero navigation so visitors arriving from talks, YouTube, Twitter/X, GitHub, search, or direct links immediately understand the site is a deep technical resource — not just a blog or a course sales page. Core goal: **internal promotion and discoverability** — help people see what else exists after they land on a single page.

Source materials live in `~/Downloads/Navigation redesign project/` (`navigation-redesign-implementation-plan.md`, `Nav Redesign Decisions.html`, wireframe walkthrough + screenshots). This doc is the Phase 1 deliverable: route classification, component/data inventory, locked decisions, and the per-phase implementation approach grounded in the actual codebase.

## Strategy

Two navigation modes, selected by route type:

- **Full top nav** — homepage and course/sales pages. Carries identity + all primary destinations. No sidebar.
- **Hub top nav + docs sidebar** — free learning/resource pages. The top nav keeps the SAME primary items as full mode (Start Here, Principles, Skills, Tools, Courses); the only difference is the docs sidebar, which adds depth (topics, What's New, resources). The wireframe's "..." on hub pages meant "same items as the homepage", not a collapsed nav.

One universal mobile top bar replaces both desktop modes.

## Locked decisions

- **Top nav presentation:** full-width sticky bar with bottom border (current pattern). Keep presentation swappable without touching route logic — floating/rounded is a later, isolated change.
- **Primary learning entry label:** **Start Here** (emphasized first item). Wire as a single config constant so it stays trivial to change.
- **Sidebar component:** use the **shadcn `sidebar`** component, not a bespoke one. **Already available** from `@coursebuilder/ui` (v2.0.12) — same import path the nav uses today. No install needed. Exports `Sidebar`, `SidebarProvider`, `SidebarContent`, `SidebarHeader`, `SidebarFooter`, `SidebarGroup`/`SidebarGroupLabel`/`SidebarGroupContent`, `SidebarMenu`/`SidebarMenuItem`/`SidebarMenuButton`, `SidebarMenuSub`/`SidebarMenuSubItem`/`SidebarMenuSubButton`, `SidebarRail`, `SidebarTrigger`, `SidebarInset`, `useSidebar`. Verify sidebar CSS vars (`--sidebar`, `--sidebar-foreground`, etc.) resolve in `src/styles/globals.css`; add them if missing.
- **Search icon (v1):** links directly to `/posts`. No command-K.
- **Brand mark:** Matt's face/avatar moves to the left and becomes the primary recognition mark, likely replacing `LogoMark`. Assets exist (see inventory).
- **Mobile hamburger:** stays on the **right**, matching current site.
- **No skill-level quiz/gate.** Organize discovery by visitor intent/activity.

## Rendering & caching safety (nav-mode selection)

Cache Components is **off** (`next.config.mjs` `experimental` has no `cacheComponents`/`ppr`; Next 16.2.5, classic App Router with `unstable_cache` + ~29 pages exporting `dynamic`/`revalidate`). Nav-mode selection must not perturb this.

- **Select the mode client-side via `usePathname`.** `Navigation` is already `'use client'` and already calls `usePathname()`/`useParams()`/`useRouter()`/`useSession()`. `getNavMode(pathname)` is a **pure synchronous function of an already-read value** — no fetch, no `await`, no Suspense, no effect. It cannot affect `loading.tsx`, streaming, or page data.
- **`usePathname` does NOT force dynamic rendering** (unlike `cookies()`/`headers()`/`searchParams`). Client components are still SSR'd/prerendered; static and `unstable_cache`d pages stay as-is. The current nav already proves this.
- **Page content is untouched** — server-rendered pages flow through `LayoutClient` as the `children` prop; passing a Server Component as `children` to a Client Component does not clientize it.
- **Derive mode directly from pathname** (no `mounted` gate) so SSR and client agree → no hydration flash. Client-nav between FULL/HUB re-renders the nav, same mechanism the nav already uses on pathname change.
- **Do NOT** select mode on the server via middleware/`headers()` — that forces consuming routes dynamic and breaks static prerendering + caching. Keep `getNavMode` in the client nav, never in a layout/middleware.
- **Cache Components future-proofing:** `usePathname` stays safe even if enabled later — the `use cache` runtime-data ban applies only to server-side `use cache` scopes, not client hooks.
- **Caching care applies in Phase 3, not here:** sidebar data (What's New, topic tree) does server fetching — route it through existing cached queries (`getAllPosts` is already `unstable_cache`d) and/or Suspense. Mode selection itself is inert.

## Current architecture (audit findings)

- **Single nav, injected globally.** There are **no route-group layouts**. `<Navigation>` (`src/components/navigation/index.tsx`) is rendered by `LayoutClient` (`src/components/layout-client.tsx`) via a `withNavigation` prop, used by essentially every page. → Nav-mode selection must come from a **route-classification helper** that the nav reads from `usePathname()` (preferred — keeps the single injection point) or that `LayoutClient` passes down.
- **Current top nav:** `Learn` dropdown + `Live` dropdown + `Browse all` (→ `/posts`) + `UserMenu`; newsletter CTA for unauthenticated non-subscribers. Nav data is hardcoded in `src/components/navigation/use-nav-links.tsx`.
- **Mobile nav** (`src/components/navigation/mobile-navigation.tsx`): Radix `Sheet side="right"`, **overlays** content (does not push down), scrollable. Hamburger already on the right. → Plan wants push-down, not overlay.
- `--nav-height: 63px` in `src/styles/globals.css`; OKLCH shadcn tokens; Tailwind v4. Designed `Tooltip` at `src/components/ui/tooltip.tsx`.

## Route classification → nav mode

The deliverable mapping. `FULL` = full top nav, no sidebar. `HUB` = same full top nav + docs sidebar. `MOBILE` = universal bar (applies everywhere on small screens). Editor/admin/auth/utility routes keep the current minimal nav (treat as `FULL` without emphasis, or exclude from redesign).

| Route (URL pattern) | Page file | Mode | Notes |
|---|---|---|---|
| `/` | `src/app/page.tsx` | FULL | Homepage. Hero/CTA/social proof. No sidebar. |
| `/posts` | `(content)/posts/page.tsx` | HUB | Browse/search destination (knowledge-graph). Search icon points here. |
| `/[post]` | `(content)/[post]/page.tsx` | HUB | Articles + the tentpole tutorials below resolve here. Sidebar + breadcrumbs. |
| `/llm-fundamentals`, `/ai-engineer-roadmap`, `/vercel-ai-sdk-tutorial`, `/model-context-protocol-tutorial` | resolve via `(content)/[post]` | HUB | Tentpole resources — no dedicated dirs; they are list/post slugs. |
| `/ai-coding-dictionary`, `/ai-coding-dictionary/[slug]` | `(content)/ai-coding-dictionary/*` | HUB | Reference content. Sidebar + breadcrumbs. |
| `/skills`, `/skills/[slug]` | `(content)/skills/*` | HUB | Promote to top-level. Sidebar (collapsed icon-rail option for the catalog if it crowds). |
| `/tools` (new) | to build | HUB | New curated landing — no Tools content type exists. |
| `/principles` (new) | to build | HUB | New tentpole — Matt's engineering philosophy/process. |
| `/learn` (or final hub name) | to build | HUB | Learning Hub / Map page. Sidebar present. |
| `/workshops`, `/workshops/[module]` | `(content)/workshops/*` | FULL | Course/sales. **No sidebar.** (lesson `(view)` routes keep their own in-course nav.) |
| `/cohorts`, `/cohorts/[slug]` | `(content)/cohorts/*` | FULL | Live/sales. No sidebar. |
| `/events`, `/events/[slug]` | `(content)/events/*` | FULL | Live/sales. No sidebar. |
| `/products`, `/products/[slug]`, `/for-your-team` | `(commerce)/*` | FULL | Sales/conversion. No sidebar. |
| `/profile`, `/team`, `/login`, `/activate`, `/settings/*`, `/organization-list` | `(user)`, `(organization)` | current | Account/utility — keep minimal nav. |
| `/admin/*`, `*/edit`, `*/new`, `(email-list)/*`, `(commerce)` utility, `/q`, `/survey/*`, `/faq`, `/privacy`, `/brand`, `/discord`, `/ask`, `/boss` | various | current | Editors/admin/auth/utility — out of scope; minimal nav. |

Implementation: a `getNavMode(pathname)` helper (e.g. `src/components/navigation/nav-mode.ts`) returning `'full' | 'hub' | 'minimal'`, plus an explicit allowlist of HUB prefixes so new learning routes opt in deliberately. Course/sales prefixes force `full`. Default unmatched → `full` (homepage-style) for marketing-ish pages, `minimal` for editor/admin.

## Component & data inventory

### Reuse as-is

- `/posts` — already a strong knowledge-graph browse/search page. Good enough as the v1 search target; revisit "does it need improvement" later.
- `/skills` landing + `/skills/[slug]`, `/ai-coding-dictionary`, tutorial slugs — content already exists.
- Tags: `tag` table (type `topic`, `fields.contexts`, `fields.popularity_order`), queries in `src/lib/tags-query.ts` — basis for the sidebar topic tree.
- Recent items for **What's New**: `getAllPosts()` (`src/lib/posts-query.ts`, cached, `createdAt DESC`) and `getSkillChangelogEntries()` (`src/lib/skill-changelog-query.ts`).
- `Tooltip` (`src/components/ui/tooltip.tsx`) for designed nav hover tooltips.
- Dismissal pattern: cookie-based via `cookieUtil` + `src/lib/sale-banner.ts` + toast notifiers (`use-sale-toast-notifier`, `use-live-event-toast-notifier`) — reuse for promo dismissal.
- Brand/face assets: `/public/matt-pocock.jpg`, `/public/landing/matt-pocock@2x.png`, `/public/landing/matt-pocock-left@2x.png`, `/public/instructor.png`; existing `LogoMark`/`Logo`/`AiHeroMascot` in `src/components/brand/`.

### Build new

- **Route-classification helper** + nav-mode wiring (Phase 2).
- **Top nav variants** — refactor `navigation/index.tsx` into a shell with `full` and `hub` variants sharing one brand/account/search core.
- **Docs sidebar** (shadcn `sidebar`) + central sidebar data source + active-state matching (Phase 3).
- **General breadcrumbs** — only `WorkshopBreadcrumb` exists today (`(content)/workshops/_components/workshop-breadcrumb.tsx`); generalize.
- **Learning Hub** page, **Tools** landing, **Principles** page (Phases 4–5).
- **Promo strip** — top banner doesn't exist (only toasts). See "Promo bar" below: server-rendered, **not dismissible**, no layout shift.
- **Newsletter subscriber count** — no public count endpoint. Needs a new tRPC procedure hitting the ConvertKit API (`CONVERTKIT_API_KEY`), cached (Upstash Redis is available). Or omit intentionally for v1.
- **Mobile nav rework** — convert overlay → push-down; sidebar-like sections; Courses/Login prominent near top.

### Promo bar — server-rendered, no layout shift, NOT dismissible

Locked: **the promo bar is not dismissible.** This removes any cookie read, so the bar is a pure **Server Component** that fetches content server-side and renders in the initial SSR HTML → **zero layout shift, and static rendering is preserved** (no `cookies()` ⇒ no forced dynamic rendering).

- **Component:** `<PromoBar>` Server Component. Resolve the active promo server-side, awaited before render: **manual override wins** (curated/featured promo) → fallback to **latest content** (`getAllPosts()`, already `unstable_cache`d) → sale via existing `getCouponForCode` + `getSaleBannerData(coupon)` (`src/lib/sale-banner.ts`). One active message at a time.
- **Placement:** render in root `src/app/layout.tsx`, above `children`, so DOM order is PromoBar → page (`LayoutClient → Navigation`). Nav stays `sticky top-0`; promo scrolls away (not sticky). Default full-width above nav; content-width is a later visual option.
- **Rendering:** server-fetch only; no client `useQuery`/pop-in. Reuse existing cached queries so the bar stays static-friendly. Mobile: same bar above nav, shorter copy, scrolls away.
- Overrides the source plan's "dismissible if a dismissal pattern exists" — dismissibility intentionally dropped.

## Phase plan (implementation order)

1. **Phase 1 — Discovery (this doc).** ✅ Route classification + inventory + locked decisions.
2. **Phase 2 — Nav shell.** `getNavMode` helper; refactor top nav into `full`/`hub` variants; left brand = Matt avatar (Start Here emphasized, Principles/Skills/Tools/Courses, search→`/posts`, newsletter, login). Full-width presentation.
3. **Phase 3 — Sidebar.** shadcn `sidebar` (from `@coursebuilder/ui`); central data model (Explore / Resources / What's New / Topic tree); active highlighting; breadcrumbs above nested content; collapsed icon-rail option for catalog pages.
   - **As built:** `HubSidebar` (client, desktop-only) + `HubLayout` (server, fetches What's New). Wired into `/learn`, `/principles`, `/tools`, `/skills`, `/skills/[slug]`, `/ai-coding-dictionary/[slug]`, and standalone articles + list landings via the `[post]` layout.
   - **Context-dependent articles:** posts in a list/series keep `ListResourceNavigation`; standalone posts get the hub sidebar (branch on `Boolean(list)`).
   - **Excluded by decision:** `/posts` keeps its own full-width list + knowledge-graph layout (no docs sidebar). The dictionary index keeps its bespoke A–Z `DictionarySidebar`; only dictionary entries get the hub sidebar.
   - **Breadcrumbs:** reusable `Breadcrumbs` component built. The skills/dictionary entry pages already have back-links; broader breadcrumb trails wait on the topic taxonomy (open decision).
4. **Phase 4 — Learning Hub page** (`/learn` or final name). Curated starts, browse-by-goal, tentpoles, what's new, featured Skills/Tools, contextual course CTA.
5. **Phase 5 — Tentpole pages.** Principles/Process, Skills landing treatment, Tools landing, Courses/Workshops page (no sidebar on sales pages).
6. **Phase 6 — Search entry.** Wire search icon → `/posts` in both modes. Command-K deferred.
7. **Phase 7 — Promo system.** One active promo, manual override wins, else latest post/video; server-rendered, NOT dismissible; scrolls away. See the promo bar section above.
8. **Phase 8 — In-content cross-promo.** MDX callout components (rich + slim) with optional auto-insertion; CTA mapped to intent.
9. **Phase 9 — Mobile nav.** Universal bar; hamburger right; push-down (not overlay) scrollable menu; breadcrumbs on nested pages; promo strip above nav scrolls away.
10. **Phase 10 — QA & launch checks.** Per-route mode correctness, active states, breadcrumbs, promo fallback/override, mobile push-down, responsive/visual/a11y.

## Open decisions (pre-launch)

- Final public name for the hub/map page (`Learning Hub` is internal-only).
- `Principles` vs `Process` vs `Engineering` label.
- `Courses` vs `Workshops` label.
- Sidebar topic taxonomy + labels (placeholders until content inventory finalized).
- Skills/Tools pages: full sidebar vs collapsed icon-rail.
- Promo placement default (full-width above nav vs content-width).
- Newsletter count: build the ConvertKit count endpoint, or omit for v1.
- Whether `/posts` needs improvement to serve as the search/browse destination.

## DESIGN.md constraints (must follow for any UI)

Container `border-x`, no horizontal padding on section wrappers (pad inner content). Grid hairlines via `bg-border` + `gap-px`, cells `bg-background`. shadcn semantic tokens only. Headings get `tracking-tight`. Light + dark mode both required.
