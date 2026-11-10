# @ai-hero/course-sync-schema

Effect v4 schema contract for moving a Course Video Manager course export into AI Hero/Course Builder import tooling.

This package is intentionally a small bridge surface. It does not mirror CVM tables and it does not write Course Builder records. `CourseJsonDocument` (also exported as `CourseJsonDocumentV3` for compatibility) is the consumer copy of Course Video Manager's versioned package-entry contract. The older `CourseSyncDocument` v1 remains exported only for compatibility; it is not accepted by the draft sync control plane because it contains caller-supplied Course Builder target hints.

## Contract

The draft sync root document is `CourseJsonDocument` with `schemaVersion: 3`, `4` or `5`, an immutable `courseVersionId`, `archiveTTL: "90d"`, and full MP4 byte `sha256` plus `bytes` receipts for video lessons. Version 5 adds body-only `text` lessons and `optional: true` on any lesson type. Both are rejected in versions 3/4. Unknown keys and types remain invalid. Control-plane request and redacted response schemas live beside it. Stage requests carry only `{ manifest }`; all target IDs stay server-owned.

It contains:

- producer metadata for Course Video Manager
- course and course-version identity
- ordered sections
- ordered lessons inside each section
- videos, chapters, transcript references, media references, and segments
- source assets and change/warning metadata
- optional Course Builder target hints for cohort/resource mapping

## CVM terms kept intact

The schema keeps Course Video Manager language where it matters:

- `Course`
- `CourseVersion`
- `draft` and `published`
- `Section`
- `Lesson`
- `Video`
- `Chapter`
- `Segment`
- `Ghost Lesson`
- `TODO` lesson

Real TODO lessons are represented as `fsStatus: "real"` and `authoringStatus: "todo"`. Ghost lessons are represented as `fsStatus: "ghost"` and must not carry `authoringStatus`.

## Course Builder target

Consumers should map the document to Course Builder content rows instead of copying CVM tables directly:

- sections become `workshop` resources
- lessons become `lesson` resources
- ordering becomes `ContentResourceResource.position`
- resource hints live under `courseBuilder`
- stable import matching should prefer `clientKey`

The first AI Hero consumer can still produce the familiar import actions from Cohort 004 work, for example `createResource`, `upsertRelation`, `uploadVideo`, `updateVideoChapters`, and `updateLessonBodyFromSource`.

## Effect version

This package targets Effect v4 beta APIs from `Effect-TS/effect-smol`, currently `effect@4.0.0-beta.84`. The main AI Hero app and CVM currently use Effect v3, so consumers should treat this package as a schema boundary until the import/export CLI boundary is settled.

## Development

```bash
pnpm --filter @ai-hero/course-sync-schema typecheck
pnpm --filter @ai-hero/course-sync-schema test
pnpm --filter @ai-hero/course-sync-schema build
```
