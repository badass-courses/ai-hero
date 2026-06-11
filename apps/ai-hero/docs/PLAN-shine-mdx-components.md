# Plan — Shine MDX Components

Dynamic MDX components for surfacing **Cohorts**, **Workshops**, and **Tutorials** in landing copy. Renders as image-led rows that "shine more" than the existing `<Resource>` rows.

## Goals

- Author hand-picks specific Workshops and Tutorials by slug; the next purchasable Cohort is auto-selected.
- Each row pulls live product/pricing/coupon data — price, discount %, coupon countdown, cohort start date — at render time.
- Same row shape across all three types so they feel cohesive on a landing page.
- Match the existing `<Resource slugOrId="..." />` API pattern. Server components, no client-side data fetching.

## Components

| Component | Selection | Content type | Has product? |
|---|---|---|---|
| `<Cohort slugOrId="..." />` | manual | `cohort` | yes |
| `<UpcomingCohort />` | auto | `cohort` | yes |
| `<Workshop slugOrId="..." />` | manual | `workshop` | yes |
| `<Tutorial slugOrId="..." />` | manual | `tutorial` | no (always free) |

### `<UpcomingCohort />` selection rule

Picks the cohort whose attached **Product is currently in its enrollment window** (`product.fields.openEnrollment <= now <= product.fields.closeEnrollment`), sorted by `cohort.fields.startsAt` ascending, taking the first.

`null` if no cohort matches. (Edge case 1 below.)

## Layout

Image-on-side row.

```
┌─────────┐  TYPE-LABEL · OPTIONAL META          [BADGE]
│         │  Title
│  IMAGE  │  Optional description (1–2 lines)
│         │  Optional price line                    →
└─────────┘
```

- **Image:** 16:9, ~240px wide on desktop on the left, full-width stacked above content on mobile. Source: `fields.image`. If missing, a `bg-stripes` placeholder with the type label centered, mirroring the `ResourceCard` ARTICLE fallback.
- **Whole row is a clickable `<Link>`** to the resource's path via `getResourcePath(type, slug, 'view')`.
- **Hover treatment:** same gradient frame inset animation as `ResourceRow`. No always-on visual shine — the image + meta + badges carry the differentiation.

### Per-type slot content

#### Cohort
- Type label: `COHORT · Starts Jun 15` (humanized date, no year if current year)
- Title
- Description (optional)
- Price line: `$299 ̶$̶3̶9̶9̶` (strikethrough on original when discounted)
- Badge: `<DiscountBadge>` — top-right, only when active default coupon exists. Shows `25% OFF · 2d 4h left`. Coupon source: `courseBuilderAdapter.getDefaultCoupon([productId])`.

#### Workshop
- Type label: `WORKSHOP · 12 LESSONS` (lesson count from `resources.length`)
- Title
- Description (optional)
- Price line: same as Cohort
- Badge: `<DiscountBadge>` — same logic as Cohort

#### Tutorial
- Type label: `TUTORIAL · 8 LESSONS`
- Title
- Description (optional)
- No price line
- Badge: `FREE` pill — top-right, always shown. Different visual register from `DiscountBadge` (calm, accent color, no countdown).

### Compact coupon countdown

Driven by `coupon.expires`. Granularity:
- `> 24h` → `2d 4h left`
- `1h–24h` → `4h 12m left`
- `< 1h` → `23m left`
- Drop seconds-level updates entirely.

Source data identical to the existing `<DiscountCountdown>` on the cohort page; new `<CompactCountdown>` is a client component for the tick.

## File layout

```
src/components/landing/
├── cohort.tsx              # async server component: fetch + delegate to ShineRow
├── upcoming-cohort.tsx     # async server component: runs picker, delegates to <Cohort>
├── workshop.tsx            # async server component
├── tutorial.tsx            # async server component
├── shine-row.tsx           # presentational primitive (no fetching)
├── discount-badge.tsx      # presentational
└── compact-countdown.tsx   # 'use client' — ticks the countdown
```

`<ShineRow>` props:

```ts
type ShineRowProps = {
  href: string
  image?: string
  title: string
  description?: string
  typeLabel: string             // "COHORT · STARTS JUN 15", etc.
  badge?: React.ReactNode       // <DiscountBadge>, "FREE" pill, or null
  meta?: React.ReactNode        // price line, or null
  fallbackPlaceholder: string   // "COHORT" / "WORKSHOP" / "TUTORIAL" for bg-stripes
}
```

Each of `<Cohort>` / `<Workshop>` / `<Tutorial>` is ~30 lines: a data fetch + a `<ShineRow {...} />` call.

## Data fetching

Inline `await` inside async server components. Matches `<Resource>` pattern. No Suspense, no skeletons in v1.

Sibling async server components in Next.js App Router render concurrently — multiple shine components on a page fetch in parallel without plumbing.

Per-component fetch:
- `<Tutorial>`: 1 query — `contentResource` lookup by slug.
- `<Workshop>` / `<Cohort>`: 4 queries (parallel via `Promise.all`):
  - `contentResource` lookup (with `resourceProducts.product.price` and `resources` for lesson count)
  - `getPricingData({ productId })`
  - `courseBuilderAdapter.getDefaultCoupon([productId])`
- `<UpcomingCohort>`: 1 query (the picker), then delegates to `<Cohort>` which does its own 4-query fan-out.

If pricing becomes a perf bottleneck on landing renders, swap in the existing `pricingDataLoader` + `<PricingInline>` Suspense pattern. Opt-in, not architectural.

## Edge cases

| # | Scenario | Behavior |
|---|---|---|
| 1 | `<UpcomingCohort />` finds no purchasable cohort | Render `null` silently |
| 2 | Manual `slugOrId` doesn't resolve | Render `null` + `log.warn('landing.{type}.missing', {slugOrId})` |
| 3 | `<Cohort>` or `<Workshop>` resolves but has no Product attached | Render row without price line and without discount badge |
| 4 | Resource exists but `state ≠ published` or `visibility ≠ public` | Render `null` + `log.warn` — don't leak drafts |
| 5 | Active coupon exists but `expires` is null | Render `<DiscountBadge>` with `25% OFF` only — no countdown text |

### Explicitly not in scope (v1)

- **Already-purchased state:** no `useSession` / `<HasPurchased>` check on landing rows. The linked product page handles owned-vs-not. Avoids turning these into request-personalized components and killing static caching.
- **`<UpcomingCohort limit={N} />` / multi-cohort variants:** auto-pick is strictly one cohort. A multi-cohort component is a different feature.
- **Seats remaining:** schema has `maxSeats` but no `seatsRemaining`. Computing it requires a purchases query per render. Skip until it's actually a conversion lever.
- **Auto-derived images:** no fallback chain to lesson thumbnails or Mux frames. `fields.image` is the single source. Missing image = striped placeholder = editor signal to fix.
- **Total workshop duration:** lesson count, not duration. Adding duration requires loading `videoResource.duration` per lesson — defer.
- **Per-type accent palettes:** no warm/cool/neutral tinting. v1 stays uniform; layer in later if shine still feels weak.

## Wiring into MDX

Add the four components to the MDX `components` map in `src/app/landing/page.tsx`:

```tsx
const components = {
  ...existing,
  Cohort,
  UpcomingCohort,
  Workshop,
  Tutorial,
}
```

Author usage in `content/landing.md`:

```mdx
<UpcomingCohort />

<Workshop slugOrId="vercel-ai-sdk-mastery" />

<Tutorial slugOrId="model-context-protocol-tutorial" />
```

## Build order

1. `shine-row.tsx`, `discount-badge.tsx`, `compact-countdown.tsx` — presentational primitives.
2. `tutorial.tsx` — simplest fetch path, validates the layout end-to-end.
3. `workshop.tsx` — adds product + coupon fetch + price line.
4. `cohort.tsx` — adds `startsAt` formatting on top of workshop's pattern.
5. `upcoming-cohort.tsx` — picker query, delegates to `<Cohort>`.
6. Wire all four into `src/app/landing/page.tsx` MDX components map.
7. Add usage to `content/landing.md` for visual verification.
