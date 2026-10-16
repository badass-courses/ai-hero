# SEO head proof

Base: `77c57d6b`. All content and commerce reads in the proof use synthetic fixtures. No production database, checkout, customer record, or service credential was used.

## Head before and after

The complete fragments are checked into [`seo-head.test.tsx.snap`](../src/lib/__snapshots__/seo-head.test.tsx.snap), for:

- `/`
- `/workshops/ai-sdk-v6-crash-course`
- `/workshops/ai-coding-crash-course`
- `/ai-coding-dictionary/agent`

The test executes the actual metadata declarations and workshop JSON-LD component with synthetic read adapters. It uses Next's metadata resolver for inherited title, description, canonical and Open Graph values, then React's server renderer for the fragment. The baseline declarations were extracted verbatim from `77c57d6b` into `src/lib/__fixtures__/seo-head-base.json`, so shallow CI checkouts do not need Git history. Existing site and dictionary JSON-LD components are included. Scripts are collected alongside the head tags in the proof fragment; their placement in the application body has not changed.

This is a metadata test render, not a full application build or a production capture. Fixture descriptions and the fixture price are not customer copy or advertised prices.

| Route | Before | After |
| --- | --- | --- |
| Homepage | No canonical | `https://www.aihero.dev/`; identical with `?utm_source=x` |
| AI SDK v6 fixture | Literal `*you*` and link syntax | Plain text in description, OG and Course JSON-LD |
| AI Coding fixture | Long description | Whole-word prefix, at most 155 characters including the ellipsis |
| Dictionary fixture | Markdown and encoded entity text | Plain text, decoded before HTML escaping |
| Workshop Course | No provider or offer | AI Hero provider and the loaded primary price/currency; sold out when no seats remain |

Homepage title, description and H1 remain unchanged. Inner-page canonicals remain unchanged. The homepage sets its own `metadataBase` to `null` because its URLs are absolute: Next otherwise normalizes the root canonical to the bare origin and drops the trailing slash. The resolver-backed test checks the emitted value, not just the input metadata object.

## Description contract

One pure `metaDescription` function parses Markdown, flattens HTML, decodes entities, collapses whitespace and reserves space for an ellipsis only when cutting. It never cuts a word. A word longer than the available space produces only an ellipsis rather than part of the word. A zero limit produces an empty string.

The property test runs 2,000 seeded cases with variable word lengths, Markdown links/emphasis, entities and limits from 1 to 155. It checks the bound, stripped syntax, a whole-word plain-text prefix and no dangling entity fragment. Table-driven tests cover headings, code, reference links, images, HTML, scripts, empty input, exact fits and long first words.

## Course validation

`buildCourseSchema` returns `WithContext<Course>` from `schema-dts`, without an assertion. Cohort dates are on `hasCourseInstance`, with `courseMode: online`. A strict JSON-LD validation test validates serialized output and the Offer/Organization/CourseInstance fields. The full application typecheck also passes.

Validation result: **12 Course tests passed**, including 200 generated list-price values. Example validated output, with synthetic commerce facts:

```json
{
  "@context": "https://schema.org",
  "@type": "Course",
  "name": "Synthetic course",
  "description": "Learn engineering.",
  "url": "https://www.aihero.dev/workshops/synthetic-course",
  "provider": {
    "@type": "Organization",
    "name": "AI Hero",
    "url": "https://www.aihero.dev"
  },
  "offers": {
    "@type": "Offer",
    "price": 247.5,
    "priceCurrency": "GBP",
    "availability": "https://schema.org/InStock",
    "url": "https://www.aihero.dev/workshops/synthetic-course"
  }
}
```

The price comes from the product adapter's selected primary list price, not a formatted visitor quote, coupon, regional price or PPP calculation. Currency must be present in that price's catalog facts. Missing, zero, invalid, inactive or unsupported price facts omit the offer. Unknown inventory also omits it. Capped inventory uses the same `getSeatsTaken` and `seatsLeft` functions as pricing; `-1` remains the existing unlimited sentinel. A failed SEO read omits the offer rather than failing the page. The anonymous commerce facts are cached for 600 seconds.

## Sitemap contract

Content URLs prefer `updatedAt` over publication time. Homepage lastmod uses the active landing-page resource, with its existing fallback. The skills index uses the maximum public, published child `updatedAt`, across the full collection rather than the first 100 entries. CMS-backed static acquisition routes use their resource timestamp. A static route without a known resource timestamp omits lastmod rather than substituting a build date, commit hash, epoch or hard-coded date. The RSS consumer skips those undated entries rather than inventing publication dates.

Published/public filters remain in SQL and are checked again before emitting content URLs. Deleted workshops, sections and lessons are excluded. Sitemap tests cover draft posts, draft workshops, draft lessons, unlisted posts, updated-versus-published timestamps, index-child timestamps and missing static timestamps.

## Checks

```text
Focused suites: 11 passed
Focused tests: 88 passed
Application typecheck: passed
Mutation checks: 7/7 killed
```

The red-first runs failed 10 description assertions, 8 Course/canonical assertions and 2 sitemap assertions before implementation. The mutation runner plants and restores these defects:

```text
KILLED: markdown not stripped
KILLED: cut mid-word
KILLED: hard-coded offer price
KILLED: unknown price emitted as zero
KILLED: sold out emitted as InStock
KILLED: homepage canonical missing
KILLED: draft enters sitemap
```

Reproduce from `apps/ai-hero`:

```sh
pnpm exec vitest run src/lib/meta-description.test.ts src/lib/course-schema.test.ts src/lib/course-seo-query.test.ts src/lib/structured-data.test.tsx src/lib/seo-head.test.tsx src/app/homepage-seo.test.tsx src/app/sitemap.test.ts src/lib/ai-coding-dictionary.test.ts src/lib/pricing-decisions.test.ts src/lib/pricing-query.test.ts src/lib/seats-taken-query.test.ts
pnpm run typecheck
node scripts/seo-mutants.mjs
pnpm exec next build
```

Run mutation checks with no concurrent writer or checker in the checkout. Each planted source change is restored in `finally`.

## Build blocker

`pnpm exec next build` exits 1 while loading `next.config.mjs`: required database and service environment variables are absent in the clean checkout. It does not reach compilation or prerendering. No production environment was pulled to bypass the failure. Keep the PR draft and rerun the build in the authorized application build environment before merge.

## Release and rollback

No flag, migration, price change, CMS write, merge or deployment is part of this change. Roll back by reverting the PR. After an approved deployment, check the four routes signed out, the homepage with a UTM query, a sold-out course and the generated XML sitemap. Verify that unknown offers/lastmod values remain absent rather than defaulting to invented values.
