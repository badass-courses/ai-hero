# Site Footer Redesign

Replace the minimal current footer (`src/components/navigation/footer.tsx`) with a structured, multi-column footer that mirrors primary nav content, surfaces auth-aware account actions, exposes machine-readable artifacts, and consolidates legal/utility links.

## Goals

- Reuse primary nav data (`useNavLinks()`) so Learn / Live / Browse stays in sync between header and footer.
- Surface auth-aware account links (Login, Profile, Invoices, Feedback) at the bottom of every page.
- Expose machine-readable artifacts (`/sitemap.md`, `/llms.txt`, `/rss.xml`) for agents and tools in a dedicated **Wrangler** column.
- Preserve existing footer behaviors: hidden on `/edit`, `print:hidden`, no special handling for lesson routes.

## Layout

### Desktop (`lg:grid-cols-4`)

```
LEARN          LIVE              ACCOUNT          WRANGLER
[curated, flat][curated, flat]   [auth-aware]     /sitemap.md
                                                  /llms.txt
                                                  /rss.xml
─────────────────────────────────────────────────────────────
© AIHero  Browse all  FAQ  Terms                  [Theme ◐]
```

### Responsive

- Default: `grid-cols-1` (single stacked column).
- `sm`: `grid-cols-2` (2x2 grid).
- `lg`: `grid-cols-4` (single row).
- Bottom utility row: stays horizontal at all breakpoints; wraps if needed.

## Column contents

### Learn

- Source: `useNavLinks().learn`.
- Flat list (no sub-headings), no past items.
- All `courses` followed by `freeTutorials.featured` and `freeTutorials.items`.
- Each link tracked with `track('navigation_menu_item_click', { resource, type, category: 'footer' })` where `type` matches existing values (`course`, `tutorial`).

### Live

- Source: `useNavLinks().live`.
- Flat list of current `cohorts` and `events`. **No past items.**
- Empty state: when both `cohorts` and `events` are empty, render
  - "No live events scheduled."
  - "Sign up to get notified" — link to `/newsletter`, tracked as `type: 'newsletter'`.
- When at least one is non-empty, render only the non-empty items.

### Account

Three states, gated client-side:

| State | Items |
|---|---|
| `sessionStatus === 'unauthenticated'` | "Login / Register" → `/login` |
| Authenticated, `!ability.can('read', 'Invoice')` | "Profile" → `/profile`, "Feedback" → opens `useFeedback()` dialog |
| Authenticated, `ability.can('read', 'Invoice')` | "Profile" → `/profile`, "Invoices" → `/invoices`, "Feedback" → opens dialog |

- Use the existing `mounted` pattern (see `user-menu.tsx`) to defer auth-dependent rendering until after hydration. Render skeleton or empty placeholder during SSR + initial client render.
- Reuse `api.ability.getCurrentAbilityRules` + `createAppAbility` from `@/ability`.
- Feedback uses `useFeedback().setIsFeedbackDialogOpen(true)`.

### Wrangler

Hardcoded list — no external data:

- `/sitemap.md`
- `/llms.txt`
- `/rss.xml`

Tracked with `type: 'wrangler'`.

### Bottom utility row

Left to right, with theme toggle right-aligned:

- `© AIHero.dev`
- `Browse all` → `/posts` (from `useNavLinks().browseAll.href`)
- `FAQ` → `/faq`
- `Terms` → `/privacy`
- `<ThemeToggle />` (existing component, dropdown with Light/Dark/System)

## Inherited behaviors

| Behavior | Source | Action |
|---|---|---|
| Hide on `/edit` routes | `pathname.includes('/edit')` | Preserve |
| `print:hidden` | className | Preserve |
| Render on lesson routes | (no special handling) | Preserve |

## Tracking

All click handlers use:

```ts
track('navigation_menu_item_click', {
  resource: '<title or path>',
  type: '<course | tutorial | cohort | event | wrangler | newsletter | account | legal>',
  category: 'footer',
})
```

The `category: 'footer'` differentiates from the existing `category: 'navigation'` on header clicks. Dashboards can slice on category to see surface-level engagement.

## Hydration

- Component is a client component (`'use client'`) — depends on `useSession`, `useFeedback`, `useTheme`, `usePathname`.
- Auth-dependent block (`Account` column) uses local `mounted` state to avoid hydration mismatch. Renders nothing (or a small skeleton) until `mounted === true`.
- Theme toggle is already hydration-safe via `next-themes`.

## File changes

- **Modify:** `apps/ai-hero/src/components/navigation/footer.tsx` — replace contents with new multi-column layout. Keep the `Footer` default export to avoid touching call sites.
- **No new files needed** unless the column components grow large enough to warrant extraction. If extraction is needed, suggested layout:
  - `apps/ai-hero/src/components/navigation/footer/index.tsx`
  - `apps/ai-hero/src/components/navigation/footer/learn-column.tsx`
  - `apps/ai-hero/src/components/navigation/footer/live-column.tsx`
  - `apps/ai-hero/src/components/navigation/footer/account-column.tsx`
  - `apps/ai-hero/src/components/navigation/footer/wrangler-column.tsx`
  - `apps/ai-hero/src/components/navigation/footer/utility-row.tsx`

## Out of scope

- Newsletter signup form embedded in footer (rejected — already prominent elsewhere).
- Logo in footer (rejected — header already carries it).
- Past cohorts / past events in footer (rejected — too noisy for always-visible surface).
- Sub-headings within columns (rejected — flat reads cleaner at footer scale).
- Mobile accordion collapse (rejected in favor of grid stacking).
- Adding GitHub / OpenAPI / robots.txt to Wrangler (rejected — keep Wrangler tight).

## Domain language

See `apps/ai-hero/CONTEXT.md` for the **Wrangler** term and other navigation vocabulary.

## Open implementation questions

- Confirm `track()` signature accepts `category: 'footer'` without dashboard breakage. If existing dashboards filter on `category === 'navigation'` exclusively, decide whether to add 'footer' to those dashboards or keep funnels separate.
- Confirm `/faq` and `/privacy` routes still exist (they did at time of plan).
- Decide whether `Account` column shows a skeleton row or stays empty during the SSR/pre-hydration window — current header uses a skeleton. Match that for consistency.
