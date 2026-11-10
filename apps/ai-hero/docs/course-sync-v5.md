# course.json v5: text and optional lessons

The consumer accepts schema versions 3, 4 and 5. Version 5 adds `type: "text"` and `optional: true` on any lesson. Text lessons require non-empty `id`, `title`, `body` and `description`. They have no video children. Unknown keys/types still fail decoding, and versions 3/4 reject both additions.

Text/explainer/problem/placeholder share the lesson lineage id. Filming a text lesson adds media under the existing resource. Replacing a filmed lesson with text detaches its media and enters the existing filmed-content regression review path.

## Optional-field ownership and legacy compatibility

- Version 5 writes `fields.optional` as true or false and records `fields.courseSync.optionalOwnedBySync: true`.
- Versions 3/4 leave never-owned CMS flags alone. Their plan and writes stay unchanged, including existing hand-set `optional: true` values.
- After v5 has owned a lesson's flag, a later v3/v4 manifest clears it to false and retains ownership metadata. This is intentional: CVM returns to v4 when a course no longer uses either new feature. The clearing write appears in the preview.
- Whole-run rollback restores the preceding flag and ownership. Rolling back the first v5 ownership claim restores a legacy CMS value, or removes the flag if the prior version did not have one.

This is an explicit exception to the gist's blanket absent-means-required wording. It preserves legacy CMS content while allowing Matt to remove the last optional flag.

## Learner behavior

Module progress counts only required lessons, preserving the shared adapter's existing `lesson`/`post` resource types and live direct/section ordering. Certificates retain their existing `lesson`/`exercise` resource types. CVM sync creates `lesson` resources, so both projections agree on synced content. Optional completion records remain available for their own checkboxes, but do not increase the count or percentage. The existing Get Certificate tile consumes that corrected progress. Up Next skips optional lessons and their solutions; sidebar navigation still exposes them. Optional lessons remain openable and completable.

An optional-only workshop has 100% required progress. For cohort certificate eligibility, a workshop with zero required lessons is complete. Standalone empty-workshop certificate eligibility retains its existing requirement for at least one required lesson. Empty cohorts and unsigned learners remain ineligible.

Heading anchors de-duplicate within the rendered lesson body in document order, matching the TOC's slug/suffix convention. The body scrolls to an initial hash after streamed MDX resolves, and handles later hash changes. Malformed hashes do not throw.

## Deployment effects before any v5 source is published

Required-only progress also applies to existing CMS optional lessons. Read-only analysis on 2026-11-09 found 12 affected workshops and no affected C5 workshop. Among learner-workshop pairs with a recorded progress row, 4,026 percentages change: 3,525 increase and 501 decrease. The decreases are partial learners whose optional work previously contributed to the denominator and numerator. 721 pairs newly reach 100%; none leaves 100%. There are no optional-only workshops in that readback. A separate certificate-graph reader check found no live cohort workshop with zero required lessons, so the zero-required cohort policy has no immediate deploy effect.

These are learner-workshop pairs, not distinct people or all enrolled learners. Certificate eligibility already excludes optional lessons, so the change aligns module progress and its tile with eligibility. Deploying this code changes those progress displays immediately; no v5 sync is needed for that effect. Deployment does not write progress or issue certificates by itself.

## Verification

From the repository root:

```sh
pnpm --filter @ai-hero/course-sync-schema build
pnpm --filter @ai-hero/course-sync-schema test
apps/ai-hero/node_modules/.bin/tsc --noEmit -p apps/ai-hero
```

From `apps/ai-hero`, run Vitest with:

```sh
pnpm exec vitest run src/course-sync \
  src/lib/required-module-progress.test.ts \
  src/lib/required-module-progress-query.test.ts \
  src/lib/certificates.test.ts \
  'src/app/(content)/_components/module-progress-optional.test.tsx' \
  'src/app/(content)/workshops/_components/lesson-body.test.tsx' \
  'src/app/(content)/workshops/_components/up-next.test.tsx' \
  'src/app/(content)/workshops/[module]/(learn)/[lesson]/shared-page.test.tsx' \
  --exclude '**/*.mysql.test.ts' \
  --poolOptions.threads.maxThreads=4 --poolOptions.threads.minThreads=1
```

The v4 compatibility test pins SHA-256 hashes of the complete plan and in-memory writes, captured from the original main control plane at `ee7b3c33`. It also tests a v4 re-sync with a hand-set optional flag, and a v5-to-v4 downgrade that clears a sync-owned flag.

## Staged first-FAQ apply plan

This is a recipe, not permission to execute it. No production sync, apply or database write was performed for this change. There is no migration or new feature flag. Merge is an operator decision.

### 1. Receive and validate the first manifest offline

Ask Matt for the first FAQ manifest as a file **before he publishes it to the live source**. Publishing the source can trigger the existing detection/auto-apply workflow. No first-manifest counts or live plan hash can be claimed until that file exists.

Run the decoder without a database or credentials, with `MANIFEST` set to its absolute file path:

```sh
pnpm --filter @ai-hero/course-sync-schema exec tsx -e '
import { readFileSync } from "node:fs";
import { decodeCourseJsonDocument, courseJsonVideos } from "./src/course-json-v3.ts";
const manifest = decodeCourseJsonDocument(JSON.parse(readFileSync(process.argv[1], "utf8")));
console.log({ schemaVersion: manifest.schemaVersion, sections: manifest.sections.length,
  lessons: manifest.sections.flatMap(s => s.lessons).length, videos: courseJsonVideos(manifest).length });
' "$MANIFEST"
```

Do not print bodies or put the real manifest in a public fixture. Run the same manifest through an isolated in-memory control-plane harness, as in `control-plane.test.ts`, with synthetic target snapshots and stubbed media resolution. This is the no-database dry-run; it proves decoding and plan shape, not live target preconditions.

### 2. Review the expected write set

A first v5 sync updates every existing lesson to claim optional-field ownership, including `optional: false` on required lessons. It also creates each new FAQ lesson with body/description, `optional: true`, text metadata and an empty video list. Sections retain their identity/order unless Matt changed them. An optional FAQ adds no Mux asset. Existing video resources/media should retain unless the manifest changes their content or export metadata.

If an existing filmed lesson becomes text, expect its existing lesson resource to update, its media/solution edges to detach, and a regression requiring review. Inline quiz resources continue to follow the primary lesson body. Investigate any unrelated detach, new video, workshop state change, scheduling change or entitlement change.

### 3. Stage and preview only after separate authorization

Before touching production, have the binding owner verify that the normal poller cannot auto-apply this unreviewed source. Do not toggle a gate or publish a source as a shortcut. Obtain specific stage authorization; staging persists records and freezes media, so **stage/preview is not a zero-write dry-run**.

After deployment and that authorization, use the existing client/API:

1. Read `GET /v1/course-sync/bindings/{bindingId}` and the latest applied run. Record the rollback point and target/version/field hashes.
2. Stage exactly Matt's reviewed file with `POST /v1/course-sync/bindings/{bindingId}/runs:stage`, `{ manifest }`, and a new recorded idempotency key.
3. Call `POST /v1/course-sync/runs/{runId}:preview`. Read the stored complete plan, not just its summarized HTTP counts.
4. Record the source version, plan hash, creates/updates/retains, owned optional changes, all media and detaches, and the current live target preconditions. Compare against step 2.
5. Obtain **separate apply approval for that exact run and hash**. Do not merge, publish Matt's source, release a workshop, or apply based on this document alone.

### 4. Apply and verify, only after approval

Use the existing `:apply` endpoint once with the approved idempotency key. Follow [apply verification](course-sync-apply-verification.md). Read back the text lesson's body/description/metadata, optional fields, absence of live video children, live order and unchanged workshop state/scheduling. Check an entitled text lesson has no player, duplicate-heading TOC links land correctly, and a completed learner remains at 100% with their cohort certificate. Record the applied run as the rollback point.

### 5. Rollback

Before any v5 source is published/applied, an ordinary code revert restores the old progress display; it does not erase completions. Once v5 is live, first coordinate with Matt to stop further v5 publication and the binding owner to avoid a competing auto-apply. Keep v5 decoding available until that source is handled.

For an applied run, get separate approval for `POST /v1/course-sync/runs/{runId}:rollback` and a new recorded idempotency key. The compensating rollback requires that run to remain the applied head and its pointers/relations/source fields to be unchanged. It restores prior versions, optional ownership/values and media relations; newly created resources become inactive/detached. Verify the resulting pointers, edges, flags and learner surfaces. Do not edit JSON fields manually, replay an old manifest to bypass concurrency checks, or deploy an old v4-only decoder while the live source is still v5.
