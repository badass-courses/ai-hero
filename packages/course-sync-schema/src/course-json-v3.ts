import { Schema } from "effect"

export const COURSE_JSON_SCHEMA_VERSIONS = [3, 4, 5] as const
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

const VisibleFrom = Schema.Number.pipe(
	Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)
const ResultIsError = Schema.NullOr(Schema.Boolean)

/**
 * A coding-agent session shown on screen in the video, as entries stamped
 * with the video time they first appear (`visibleFrom`, seconds). AI Hero
 * shows it beside the player and follows playback through it.
 *
 * The producer omits an empty key instead of writing `null`, and leaves skill
 * bodies out to keep the manifest small, so those keys are optional.
 */
export const CourseJsonSessionExtract = Schema.Struct({
	sessions: Schema.Array(
		Schema.Struct({
			sessionId: NonEmptyString,
			entries: Schema.Array(
				Schema.Union([
					Schema.Struct({
						kind: Schema.Literal("userPrompt"),
						visibleFrom: VisibleFrom,
						text: NonEmptyString,
					}),
					Schema.Struct({
						kind: Schema.Literal("assistantText"),
						visibleFrom: VisibleFrom,
						text: NonEmptyString,
					}),
					Schema.Struct({
						kind: Schema.Literal("skillCall"),
						via: Schema.Literal("toolCall"),
						visibleFrom: VisibleFrom,
						skill: NonEmptyString,
						args: Schema.optionalKey(Schema.NullOr(Schema.String)),
						result: Schema.optionalKey(Schema.NullOr(Schema.String)),
						resultIsError: Schema.optionalKey(ResultIsError),
						skillBody: Schema.optionalKey(Schema.NullOr(NonEmptyString)),
					}),
					Schema.Struct({
						kind: Schema.Literal("skillCall"),
						via: Schema.Literal("slashCommand"),
						visibleFrom: VisibleFrom,
						skill: NonEmptyString,
						args: Schema.optionalKey(Schema.NullOr(NonEmptyString)),
						skillBody: Schema.optionalKey(NonEmptyString),
					}),
					Schema.Struct({
						kind: Schema.Literal("toolCall"),
						visibleFrom: VisibleFrom,
						tool: NonEmptyString,
						summary: Schema.optionalKey(
							Schema.NullOr(
								Schema.String.pipe(Schema.check(Schema.isMaxLength(160))),
							),
						),
						resultIsError: Schema.optionalKey(ResultIsError),
					}),
					Schema.Struct({
						kind: Schema.Literal("interrupt"),
						visibleFrom: VisibleFrom,
						text: Schema.String,
					}),
				]),
			).pipe(Schema.check(Schema.isMinLength(1))),
		}),
	).pipe(Schema.check(Schema.isMinLength(1))),
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
	sessionExtract: Schema.optionalKey(CourseJsonSessionExtract),
})

const ExplainerLessonFields = {
	type: Schema.Literal("explainer"),
	id: NonEmptyString,
	title: NonEmptyString,
	explainer: CourseJsonVideoV3,
}
const ProblemLessonFields = {
	type: Schema.Literal("problem"),
	id: NonEmptyString,
	title: NonEmptyString,
	problem: CourseJsonVideoV3,
	solution: Schema.optionalKey(CourseJsonVideoV3),
}
const PlaceholderLessonFields = {
	type: Schema.Literal("placeholder"),
	id: NonEmptyString,
	title: NonEmptyString,
}
const V5OptionalLessonField = {
	optional: Schema.optionalKey(Schema.Literal(true)),
}

export const CourseJsonExplainerLessonV3 = Schema.Struct(ExplainerLessonFields)
export const CourseJsonProblemLessonV3 = Schema.Struct(ProblemLessonFields)
export const CourseJsonPlaceholderLesson = Schema.Struct(PlaceholderLessonFields)

const CourseJsonLegacyLesson = Schema.Union([
	CourseJsonExplainerLessonV3,
	CourseJsonProblemLessonV3,
	CourseJsonPlaceholderLesson,
])

export const CourseJsonExplainerLessonV5 = Schema.Struct({
	...ExplainerLessonFields,
	...V5OptionalLessonField,
})
export const CourseJsonProblemLessonV5 = Schema.Struct({
	...ProblemLessonFields,
	...V5OptionalLessonField,
})
export const CourseJsonPlaceholderLessonV5 = Schema.Struct({
	...PlaceholderLessonFields,
	...V5OptionalLessonField,
})
export const CourseJsonTextLessonV5 = Schema.Struct({
	type: Schema.Literal("text"),
	id: NonEmptyString,
	title: NonEmptyString,
	body: NonEmptyString,
	description: NonEmptyString,
	...V5OptionalLessonField,
})

export const CourseJsonLessonV3 = Schema.Union([
	CourseJsonExplainerLessonV5,
	CourseJsonProblemLessonV5,
	CourseJsonPlaceholderLessonV5,
	CourseJsonTextLessonV5,
])

const CourseJsonLegacySection = Schema.Struct({
	id: NonEmptyString,
	title: NonEmptyString,
	lessons: Schema.Array(CourseJsonLegacyLesson),
})

export const CourseJsonSectionV3 = Schema.Struct({
	id: NonEmptyString,
	title: NonEmptyString,
	lessons: Schema.Array(CourseJsonLessonV3),
})

const CourseJsonDocumentFields = {
	$schema: NonEmptyString,
	courseId: NonEmptyString,
	courseVersionId: NonEmptyString,
	archiveTTL: Schema.Literal(COURSE_JSON_ARCHIVE_TTL),
	courseName: NonEmptyString,
}

/**
 * Consumer copy of the public Course Video Manager course.json contract.
 * Keep this deliberately exact: producer target hints and Dropbox revisions do
 * not belong in the manifest. The consumer freezes provider revisions itself.
 */
export const CourseJsonDocument = Schema.Union([
	Schema.Struct({
		...CourseJsonDocumentFields,
		schemaVersion: Schema.Literals([3, 4]),
		sections: Schema.Array(CourseJsonLegacySection),
	}),
	Schema.Struct({
		...CourseJsonDocumentFields,
		schemaVersion: Schema.Literal(5),
		sections: Schema.Array(CourseJsonSectionV3),
	}),
])

export type CourseJsonChapterV3 = typeof CourseJsonChapterV3.Type
export type CourseJsonSessionExtract = typeof CourseJsonSessionExtract.Type
export type CourseJsonVideoV3 = typeof CourseJsonVideoV3.Type
export type CourseJsonLessonV3 = typeof CourseJsonLessonV3.Type
export type CourseJsonSectionV3 = typeof CourseJsonSectionV3.Type
export type CourseJsonDocument = {
	readonly $schema: string
	readonly schemaVersion: (typeof COURSE_JSON_SCHEMA_VERSIONS)[number]
	readonly courseId: string
	readonly courseVersionId: string
	readonly archiveTTL: typeof COURSE_JSON_ARCHIVE_TTL
	readonly courseName: string
	readonly sections: ReadonlyArray<CourseJsonSectionV3>
}

const decodeCourseJsonDocumentUnknown = Schema.decodeUnknownSync(
	CourseJsonDocument,
	{ onExcessProperty: "error" },
)
export const decodeCourseJsonDocument = (input: unknown): CourseJsonDocument =>
	decodeCourseJsonDocumentUnknown(input)

// Compatibility aliases for existing consumers; these accept course.json schemaVersion 3, 4 and 5.
export const CourseJsonDocumentV3 = CourseJsonDocument
export type CourseJsonDocumentV3 = CourseJsonDocument
export const decodeCourseJsonDocumentV3 = decodeCourseJsonDocument

export function courseJsonVideos(
	document: CourseJsonDocument,
): ReadonlyArray<CourseJsonVideoV3> {
	return document.sections.flatMap((section) =>
		section.lessons.flatMap((lesson) => {
			if (lesson.type === "placeholder" || lesson.type === "text") return []
			return lesson.type === "explainer"
				? [lesson.explainer]
				: [lesson.problem, ...(lesson.solution ? [lesson.solution] : [])]
		}),
	)
}
