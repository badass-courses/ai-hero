# @ai-hero/course-sync-schema

Effect v4 schema contract for moving a Course Video Manager course export into AI Hero/Course Builder import tooling.

This package is intentionally a small bridge surface. It does not mirror CVM tables and it does not write Course Builder records. It validates the shared `course.json` shape that a producer can write at the root of a course folder and a consumer can turn into Course Builder resources and relations.

## Contract

The root document is `CourseSyncDocument` with schema marker `aihero.course-sync.v1`.

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
