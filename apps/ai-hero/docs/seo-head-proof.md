# SEO head proof

Base: `77c57d6b`. Renderer, commerce and feed tests use synthetic fixtures, with no application service credentials. Separate query-plan verification is noted below. This document includes the final review corrections.

## Head before and after

The complete fragments are in [`seo-head.test.tsx.snap`](../src/lib/__snapshots__/seo-head.test.tsx.snap), for `/`, both crash-course workshop pages, and `/ai-coding-dictionary/agent`.

The test executes the actual route metadata declarations and workshop JSON-LD component with fixture read adapters. Next resolves inherited metadata; React renders the fragment. Baseline declarations were extracted verbatim from `77c57d6b` into `src/lib/__fixtures__/seo-head-base.json`, so shallow checkouts do not need Git history. Site and dictionary JSON-LD are included. Scripts are collected alongside head tags for proof, without changing their application-body placement.

This is a metadata test render, not a full-app or production capture. Fixture descriptions and prices are not customer copy or advertised prices. Homepage title, description and H1 remain unchanged; inner-page canonicals are unchanged.

The UTM test now passes an actual `Request` through Next's loader-tree metadata resolver, with its pathname and search parameters in request context, then renders the resolved canonical. Both `/` and `/?utm_source=x` emit `https://www.aihero.dev/`. It no longer repeats the same assertion against an unused query parameter. Homepage-only `metadataBase: null` preserves the requested trailing slash, which Next otherwise strips from the root canonical.

## Descriptions and dictionary data

One shared pipeline parses Markdown, flattens HTML, decodes entities and collapses whitespace. Metadata is limited to 155 characters including the ellipsis. It cuts at a word boundary, except that a single overlong word is hard-cut rather than replaced with a lone ellipsis. Trailing punctuation is removed before the ellipsis. Empty metadata is `undefined`; JSON-LD omits the key.

HTML images, scripts and styles are skipped. HTML headings retain their case. The property generator includes both Markdown and HTML, entities, varied word lengths and limits. It runs 2,000 seeded cases, checking the bound, plain-text prefix, word boundaries or the explicit overlong-word exception, and no dangling HTML entity fragment.

`entry.description` preserves main exactly: raw frontmatter descriptions, or the original plain README teaser with its 180-character `...` cut. UI, RSS and search keep using that field. A separate `entry.plainDescription` stores full normalized text for metadata/JSON-LD only. Those consumers truncate already-plain text without parsing twice. No dictionary UI component is changed. Tests verify both the original teaser and full SEO text, including literal characters obtained from code spans. `stripMarkdown` remains because the original teaser and Typesense body index use it; their normalization is unchanged.

## Course and Product JSON-LD

`buildCourseSchema` returns `WithContext<Course>` without an assertion. Strict serialized JSON-LD tests cover Course, Organization, Offer and online CourseInstance fields. Empty descriptions are omitted. Cohort dates belong on `hasCourseInstance`, not directly on Course.

The exact `getProduct`-shaped fixture has `price.fields = {}`. It emits both Product and Course offers from the already-loaded positive single-seat list price. Legacy price fields are not treated as a currency or activation authority.

No exported app/commerce currency constant exists. `JSON_LD_CURRENCY = 'USD'` is used only by Product and Course JSON-LD and cites the existing USD-only checkout:

- `@coursebuilder/commerce@0.3.1/src/resolve-checkout-price.ts:62` requires `usd`.
- `@coursebuilder/commerce@0.3.1/src/stripe-checkout.ts:665,1084,1151,1212` uses `currency: 'USD'`.

There is no price constant, visitor discount, regional quote or PPP calculation. Missing, zero or invalid price, or unknown inventory, omits **only the offer**. Product JSON-LD is still rendered whenever the page supplies its sellable product. The provider URL derives from `config.siteUrl`. Config also has non-Next Inngest and entitlement consumers, so it reads `process.env.NEXT_PUBLIC_URL` directly, with clear errors for a missing or invalid absolute HTTP(S) URL. A test forbids loading the full Next env module.

Enrollment windows keep `availabilityStarts` and `availabilityEnds`. The policy is omission, not PreOrder: pre-open and closed enrollment omit offers, matching `offerInJsonLd` in `cohort-coming-soon.ts`. A neutral synthetic enrollment fixture verifies that the pre-open state cannot emit InStock. The open state retains both window dates; exhausted seats emit SoldOut.

### No second commerce fetch

`course-seo-query.ts` and its separate cache were removed. The workshop schema is a slot on the existing public-pricing render, receiving the exact product and quantity object passed to the buy widget. Its test proves one product lookup and one pricing resolution, not a metadata-specific fetch. Cohort metadata consumes the existing product and the already-started pricing promise, whose inventory uses pricing's seat-holding rule. It sits inside Suspense with a null fallback. A rejected loader is caught and renders both Course and Product without offers; a rejection regression test verifies this. Workshop loading/no-product fallbacks retain WorkshopMetadata without offers. A slot test supplies a synthetic discount price and verifies JSON-LD still uses the loaded list price. Unknown inventory does not hide the Product script.

### Validated synthetic example

Fourteen Course tests pass, including 200 generated positive list prices and the legacy empty-fields fixture. Example serialized output:

```json
{
  "@context": "https://schema.org",
  "@type": "Course",
  "name": "Synthetic course",
  "description": "Learn engineering.",
  "url": "https://www.aihero.dev/workshops/synthetic-course",
  "provider": { "@type": "Organization", "name": "AI Hero", "url": "https://www.aihero.dev" },
  "offers": {
    "@type": "Offer", "price": 247.5, "priceCurrency": "USD",
    "availability": "https://schema.org/InStock",
    "url": "https://www.aihero.dev/workshops/synthetic-course"
  }
}
```

## Sitemap and RSS compatibility

A shared index keeps the modes separate. Sitemap dates prefer content `updatedAt`. Feed dates retain main's `publishedAt`-first order and existing fallback, including its legacy static-date fallback. The RSS renderer keeps every fixture entry in the same order. A golden test executes main's captured RSS renderer and teaser helper against a non-empty fixture index and compares the new route's XML byte-for-byte, including dates, order and fallback. The new route uses the actual dictionary loader with fixture HTTP responses: a long README teaser and a frontmatter description containing Markdown are both included. No undated-entry filter remains in RSS.

The sitemap never uses that legacy feed date. Homepage lastmod follows the `landing-page-v2` resource with the existing `landing-page` fallback. These are the slugs actually loaded by `app/page.tsx:46–47`. The skills index uses the maximum eligible child update across the full collection. Guessed CMS slugs for static newsletter/subscribe pages were removed; those routes omit unknown lastmod rather than inventing one.

Cache tags match existing invalidations: `lib/pages-query.ts:72,109` invalidates `pages`; `lib/workshops-query.ts:510,536` invalidates `workshop`; `lib/posts-query.ts:854–855` invalidates `posts`/`tags`; `lib/lists-query.ts:66` invalidates `lists`; and `lib/skill-changelog-mutations.ts:105` invalidates `skill-changelog`. `inngest/functions/ai-coding-dictionary-index.ts:16` invalidates `ai-coding-dictionary`. Dictionary updates retain their existing cache tag and TTL.

Verified the query plan uses existing indexes. No environment details, index names, row counts, timings, table sizes, credentials or private connection details are included here. Skill changelog inclusion remains main's: the query is authoritative, with no added state/visibility requirement on its returned fields. A ContentResource-shaped fixture without those fields retains its `/skills/*` URLs.

## Checks

```text
Focused suites: 15 passed
Focused tests: 124 passed
Application typecheck: passed
Mutation checks: 10/10 killed
```

An optional full local sweep also ran: 689 files passed and 37 skipped. Three unrelated fixture areas failed: the OpenAPI operation-count expectation, a flag adapter mock, and missing Cloudinary test environment. No claim of a fully green broad local suite is made; the focused SEO suite and fresh GitHub checks gate this PR.

The mutation runner covers retained Markdown, mid-word cuts, hard-coded price, unknown price emitted as zero, sold-out emitted InStock, missing canonical, loss of legacy-price offers, pre-open InStock, hiding Product schema on unknown inventory, and a draft entering the sitemap. It restores each source plant in `finally`; run it without another writer or checker in the checkout.

`unified` is already a direct dependency and `fast-check` is already a direct devDependency. Changed helpers and changed hunks were formatted with the repository's Prettier options.

The first-round GitHub `next build`, CI and MySQL contract checks passed. The clean local checkout still has no application build credentials; no production environment was pulled. Fresh CI must validate the final review commit before any merge.

Reproduce from `apps/ai-hero`:

```sh
pnpm exec vitest run src/config.test.ts src/lib/meta-description.test.ts src/lib/course-schema.test.ts src/lib/structured-data.test.tsx src/lib/seo-head.test.tsx src/app/homepage-seo.test.tsx src/app/sitemap.test.ts src/app/rss.xml/route.test.ts 'src/app/(content)/workshops/_components/workshop-pricing-seo.test.tsx' src/lib/ai-coding-dictionary.test.ts src/lib/ai-coding-dictionary-typesense.test.ts src/lib/pricing-decisions.test.ts src/lib/pricing-query.test.ts src/lib/seats-taken-query.test.ts 'src/app/(content)/cohorts/[slug]/_components/cohort-coming-soon.test.ts'
pnpm run typecheck
node scripts/seo-mutants.mjs
```

## Release and rollback

Draft PR only. No flag, migration, price change, CMS write, merge or deployment. Roll back by reverting the PR. After an approved deployment, inspect the four routes signed out, the homepage with a UTM query, pre-open/open/sold-out Course states, Product schema with unknown offer facts, sitemap XML and RSS publication dates.
