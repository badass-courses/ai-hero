# Typesense Popularity Sync

Daily job that writes GA4 30-day pageview totals into the `popularity_30d` field on every public, indexed resource in the Typesense `content_production` collection, so the InstantSearch widget can offer a "Most Popular" sort.

Sources:

- `apps/ai-hero/src/inngest/functions/typesense-popularity-sync.ts`
- `apps/ai-hero/src/lib/typesense-popularity.ts`

## What it does

1. Pulls top pages from GA4 via `getTopPages('30d', 1000)`.
2. Loads indexable resources from MySQL (`post`, `tutorial`, `workshop`, `event`, `list` where `state='published'` and `visibility='public'`).
3. Builds a path → resource index. Workshops and tutorials also register a prefix entry so lesson-page traffic rolls up to the parent module.
4. Sums pageviews per resource id.
5. Writes `{ id, popularity_30d }` to Typesense via `import(..., { action: 'emplace' })` — partial-update that preserves every other field on the document.

## What it does NOT do

- Does not write to MySQL. The DB query is `SELECT` only; `contentResource.updatedAt` is never touched.
- Does not call `upsertPostToTypeSense` or `indexAllContentToTypeSense`. The job goes directly through the Typesense client with a minimal `{id, popularity_30d}` payload.
- Does not regenerate the 1536-dim `embedding` field or any other Typesense field.
- Does not trigger Inngest cascade events (no `revalidateTag`, no content cache invalidation).

## Schedule

`TZ=UTC 0 6 * * *` — 06:00 UTC daily. Runs after the existing 04:35 / 05:15 nightly jobs.

Concurrency limit 1. Inngest function id `typesense-popularity-sync`.

## Schema

The `popularity_30d` field is live across production, staging, and dev as:

```json
{
  "name": "popularity_30d",
  "type": "int64",
  "optional": true,
  "facet": false,
  "sort": true
}
```

Schema was altered manually on 2026-05-13. If a brand-new environment is provisioned later, add the field manually on the Typesense Cloud cluster with the spec above before the first sync run. The collection's `.*` wildcard field will accept writes either way, but the field must be explicitly declared as `sort: true` for the InstantSearch "Most Popular" option to work.

## Manual trigger

Fire from the Inngest dev UI or via `inngest.send`:

```ts
import { TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT } from '@/inngest/events/typesense-popularity'

await inngest.send({
  name: TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT,
  data: { source: 'manual', requestedBy: 'oncall' },
})
```

## Observability

Filter Axiom on `typesense.popularity.sync.*`.

| Log name | When | Notable fields |
|---|---|---|
| `typesense.popularity.sync.complete` | every run | `gaRowCount`, `resourceCount`, `mappedCount`, `unmappedCount`, `unmappedSample` (first 25), `scoreCount`, `writtenCount`, `failedCount`, `durationMs` |
| `typesense.popularity.sync.config-missing` | startup | logged and the run returns `{skipped: 'config-missing'}` if `TYPESENSE_WRITE_API_KEY` or `NEXT_PUBLIC_TYPESENSE_HOST` is unset |
| `typesense.popularity.sync.write.failed` | Typesense import error | `error`, `scoreCount` |

A healthy run shows `mappedCount` close to `gaRowCount` (within the lesson-rollup variance) and `writtenCount` close to `scoreCount`. If `unmappedCount` grows over time, inspect `unmappedSample` for new path patterns the indexer doesn't understand.

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Function never runs at 06:00 UTC | Inngest cron disabled in this env | Check Inngest dashboard schedule |
| `typesense.popularity.sync.config-missing` log | Missing env vars | Set `TYPESENSE_WRITE_API_KEY` and `NEXT_PUBLIC_TYPESENSE_HOST` |
| GA4 step throws quota error | GA4 API quota exhausted | Wait for daily quota reset; rare since only one query per day |
| `typesense.popularity.sync.write.failed` | Typesense rejected the import | Inspect Inngest step output for individual document errors |
| `unmappedCount` is high and `mappedCount` is low | URL pattern drift (new route shape, redirect chain) | Update `PATH_BUILDERS` in `apps/ai-hero/src/lib/typesense-popularity.ts` |
| New resource has `popularity_30d = 0` (or absent) | Resource has no GA4 traffic yet | Expected — emplace preserves absent value; Relevance/Newest sorts continue to work normally |
