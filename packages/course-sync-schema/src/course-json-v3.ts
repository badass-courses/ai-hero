import { Schema } from "effect"

export const COURSE_JSON_SCHEMA_VERSION = 3 as const
export const COURSE_JSON_ARCHIVE_TTL = "90d" as const

const NonEmptyString = Schema.NonEmptyString
const NonNegativeInt = Schema.Int.pipe(
	Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

export const CourseJsonSha256 = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
)

export const CourseJsonRelativeMp4Path = NonEmptyString.pipe(
	Schema.check(
		Schema.isPattern(
			/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)(?!.*\\).+\.mp4$/i,
		),
	),
)

export const CourseJsonChapterV3 = Schema.Struct({
	title: Schema.String,
	startTime: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
})

export const CourseJsonVideoV3 = Schema.Struct({
	id: NonEmptyString,
	relativePath: CourseJsonRelativeMp4Path,
	body: Schema.String,
	description: Schema.String,
	hash: NonEmptyString,
	sha256: CourseJsonSha256,
	bytes: NonNegativeInt,
	chapters: Schema.Array(CourseJsonChapterV3),
})

export const CourseJsonExplainerLessonV3 = Schema.Struct({
	type: Schema.Literal("explainer"),
	id: NonEmptyString,
	title: NonEmptyString,
	explainer: CourseJsonVideoV3,
})

export const CourseJsonProblemLessonV3 = Schema.Struct({
	type: Schema.Literal("problem"),
	id: NonEmptyString,
	title: NonEmptyString,
	problem: CourseJsonVideoV3,
	solution: Schema.optionalKey(CourseJsonVideoV3),
})

export const CourseJsonLessonV3 = Schema.Union([
	CourseJsonExplainerLessonV3,
	CourseJsonProblemLessonV3,
])

export const CourseJsonSectionV3 = Schema.Struct({
	id: NonEmptyString,
	title: NonEmptyString,
	lessons: Schema.Array(CourseJsonLessonV3),
})

/**
 * Consumer copy of the public Course Video Manager v3 package-entry contract.
 * Keep this deliberately exact: producer target hints and Dropbox revisions do
 * not belong in the manifest. The consumer freezes provider revisions itself.
 */
export const CourseJsonDocumentV3 = Schema.Struct({
	$schema: NonEmptyString,
	schemaVersion: Schema.Literal(COURSE_JSON_SCHEMA_VERSION),
	courseId: NonEmptyString,
	courseVersionId: NonEmptyString,
	archiveTTL: Schema.Literal(COURSE_JSON_ARCHIVE_TTL),
	courseName: NonEmptyString,
	sections: Schema.Array(CourseJsonSectionV3),
})

export type CourseJsonChapterV3 = typeof CourseJsonChapterV3.Type
export type CourseJsonVideoV3 = typeof CourseJsonVideoV3.Type
export type CourseJsonLessonV3 = typeof CourseJsonLessonV3.Type
export type CourseJsonSectionV3 = typeof CourseJsonSectionV3.Type
export type CourseJsonDocumentV3 = typeof CourseJsonDocumentV3.Type

export const decodeCourseJsonDocumentV3 = Schema.decodeUnknownSync(
	CourseJsonDocumentV3,
	{ onExcessProperty: "error" },
)

export function courseJsonVideos(
	document: CourseJsonDocumentV3,
): ReadonlyArray<CourseJsonVideoV3> {
	return document.sections.flatMap((section) =>
		section.lessons.flatMap((lesson) =>
			lesson.type === "explainer"
				? [lesson.explainer]
				: [lesson.problem, ...(lesson.solution ? [lesson.solution] : [])],
		),
	)
}
