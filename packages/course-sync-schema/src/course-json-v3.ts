import { Schema } from "effect"

export const COURSE_JSON_SCHEMA_VERSIONS = [3, 4] as const
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

export const CourseJsonPlaceholderLesson = Schema.Struct({
	type: Schema.Literal("placeholder"),
	id: NonEmptyString,
	title: NonEmptyString,
})

export const CourseJsonLessonV3 = Schema.Union([
	CourseJsonExplainerLessonV3,
	CourseJsonProblemLessonV3,
	CourseJsonPlaceholderLesson,
])

export const CourseJsonSectionV3 = Schema.Struct({
	id: NonEmptyString,
	title: NonEmptyString,
	lessons: Schema.Array(CourseJsonLessonV3),
})

/**
 * Consumer copy of the public Course Video Manager course.json contract.
 * Keep this deliberately exact: producer target hints and Dropbox revisions do
 * not belong in the manifest. The consumer freezes provider revisions itself.
 */
export const CourseJsonDocument = Schema.Struct({
	$schema: NonEmptyString,
	schemaVersion: Schema.Literals(COURSE_JSON_SCHEMA_VERSIONS),
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
export type CourseJsonDocument = typeof CourseJsonDocument.Type

export const decodeCourseJsonDocument = Schema.decodeUnknownSync(
	CourseJsonDocument,
	{ onExcessProperty: "error" },
)

// Compatibility aliases for existing consumers; these accept course.json schemaVersion 3 and 4.
export const CourseJsonDocumentV3 = CourseJsonDocument
export type CourseJsonDocumentV3 = CourseJsonDocument
export const decodeCourseJsonDocumentV3 = decodeCourseJsonDocument

export function courseJsonVideos(
	document: CourseJsonDocument,
): ReadonlyArray<CourseJsonVideoV3> {
	return document.sections.flatMap((section) =>
		section.lessons.flatMap((lesson) => {
			if (lesson.type === "placeholder") return []
			return lesson.type === "explainer"
				? [lesson.explainer]
				: [lesson.problem, ...(lesson.solution ? [lesson.solution] : [])]
		}),
	)
}
