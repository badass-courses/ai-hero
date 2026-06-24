import { Schema } from "effect"

export const COURSE_SYNC_SCHEMA_VERSION = "aihero.course-sync.v1" as const
export const COURSE_SYNC_PRODUCER = "course-video-manager" as const

const NonEmptyString = Schema.NonEmptyString
const NonNegativeNumber = Schema.Number.pipe(
	Schema.check(Schema.isGreaterThanOrEqualTo(0))
)
const NonNegativeInt = Schema.Int.pipe(
	Schema.check(Schema.isGreaterThanOrEqualTo(0))
)

export const IsoDateTimeString = Schema.String.pipe(
	Schema.check(
		Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
	)
)

export const RelativePath = NonEmptyString.pipe(
	Schema.check(
		Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/).+$/)
	)
)

export const SourceId = NonEmptyString
export const ClientKey = NonEmptyString
export const SlugBase = NonEmptyString
export const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)))

export const Metadata = Schema.Record(Schema.String, Schema.Unknown)

export const Producer = Schema.Struct({
	name: Schema.Literal(COURSE_SYNC_PRODUCER),
	version: Schema.optionalKey(NonEmptyString),
	revision: Schema.optionalKey(NonEmptyString),
	exportedAt: IsoDateTimeString,
})

export const CourseBuilderVisibility = Schema.Literals([
	"public",
	"unlisted",
	"private",
])

export const CourseBuilderState = Schema.Literals([
	"draft",
	"published",
	"archived",
])

export const CourseBuilderResourceType = Schema.Literals([
	"cohort",
	"workshop",
	"lesson",
	"video",
	"solution",
])

export const CourseBuilderResourceRef = Schema.Struct({
	resourceType: CourseBuilderResourceType,
	clientKey: Schema.optionalKey(ClientKey),
	resourceId: Schema.optionalKey(NonEmptyString),
	slugBase: Schema.optionalKey(SlugBase),
	state: Schema.optionalKey(CourseBuilderState),
	visibility: Schema.optionalKey(CourseBuilderVisibility),
	position: Schema.optionalKey(Schema.Number),
	metadata: Schema.optionalKey(Metadata),
})

export const CourseBuilderTarget = Schema.Struct({
	cohortId: NonEmptyString,
	cohortSlug: Schema.optionalKey(NonEmptyString),
	resource: Schema.optionalKey(CourseBuilderResourceRef),
})

export const CourseVersionKind = Schema.Literals(["draft", "published"])

export const CourseVersion = Schema.Struct({
	sourceId: SourceId,
	kind: CourseVersionKind,
	name: Schema.optionalKey(NonEmptyString),
	description: Schema.optionalKey(Schema.String),
	createdAt: Schema.optionalKey(IsoDateTimeString),
	publishedAt: Schema.optionalKey(IsoDateTimeString),
})

export const Course = Schema.Struct({
	sourceId: SourceId,
	title: NonEmptyString,
	sourcePath: Schema.optionalKey(RelativePath),
	memory: Schema.optionalKey(Schema.String),
	version: CourseVersion,
	courseBuilder: Schema.optionalKey(CourseBuilderTarget),
})

export const AuthoringStatus = Schema.Literals(["todo", "done"])
export const FileSystemStatus = Schema.Literals(["real", "ghost"])
export const LessonIcon = Schema.Literals(["watch", "code", "discussion"])
export const LessonPriority = Schema.Literals([1, 2, 3])

export const SegmentKind = Schema.Literals([
	"definition",
	"walkthrough",
	"playthrough",
	"quest",
	"reaction",
])

export const Segment = Schema.Struct({
	sourceId: SourceId,
	kind: SegmentKind,
	title: Schema.String,
	description: Schema.optionalKey(Schema.String),
	order: Schema.Number,
})

export const Chapter = Schema.Struct({
	title: NonEmptyString,
	startTimeSeconds: NonNegativeNumber,
})

export const Transcript = Schema.Struct({
	format: Schema.Literals(["markdown", "plain"]),
	sourcePath: Schema.optionalKey(RelativePath),
	value: Schema.optionalKey(Schema.String),
})

export const VideoKind = Schema.Literals([
	"explainer",
	"problem",
	"solution",
	"other",
])

export const VideoTarget = Schema.Literals(["lesson", "solutionResource"])

export const MediaAsset = Schema.Struct({
	sourcePath: RelativePath,
	fileName: NonEmptyString,
	mimeType: Schema.optionalKey(NonEmptyString),
	bytes: Schema.optionalKey(NonNegativeInt),
	sha256: Schema.optionalKey(Sha256),
	modifiedAt: Schema.optionalKey(IsoDateTimeString),
})

export const Video = Schema.Struct({
	sourceId: SourceId,
	stableKey: NonEmptyString,
	title: NonEmptyString,
	path: RelativePath,
	kind: VideoKind,
	target: VideoTarget,
	position: Schema.Number,
	media: Schema.optionalKey(MediaAsset),
	chapters: Schema.optionalKey(Schema.Array(Chapter)),
	transcript: Schema.optionalKey(Transcript),
	segments: Schema.optionalKey(Schema.Array(Segment)),
	courseBuilder: Schema.optionalKey(CourseBuilderResourceRef),
	metadata: Schema.optionalKey(Metadata),
})

export const BodySourceKind = Schema.Literals([
	"article",
	"explainer",
	"problem",
	"todo-marker",
	"transcript",
	"inline",
])

export const LessonBody = Schema.Struct({
	format: Schema.Literals(["markdown", "mdx", "plain"]),
	kind: BodySourceKind,
	sourcePath: Schema.optionalKey(RelativePath),
	value: Schema.optionalKey(Schema.String),
	markdownSourceCount: Schema.optionalKey(NonNegativeInt),
	transcriptSourceCount: Schema.optionalKey(NonNegativeInt),
})

const LessonBaseFields = {
	sourceId: SourceId,
	stableKey: NonEmptyString,
	clientKey: ClientKey,
	title: NonEmptyString,
	path: RelativePath,
	order: Schema.Number,
	description: Schema.optionalKey(Schema.String),
	icon: Schema.optionalKey(LessonIcon),
	priority: Schema.optionalKey(LessonPriority),
	dependencies: Schema.optionalKey(Schema.Array(ClientKey)),
	body: Schema.optionalKey(LessonBody),
	videos: Schema.Array(Video),
	courseBuilder: Schema.optionalKey(CourseBuilderResourceRef),
	metadata: Schema.optionalKey(Metadata),
} as const

export const RealLesson = Schema.Struct({
	...LessonBaseFields,
	fsStatus: Schema.Literal("real"),
	authoringStatus: AuthoringStatus,
})

export const GhostLesson = Schema.Struct({
	...LessonBaseFields,
	fsStatus: Schema.Literal("ghost"),
	authoringStatus: Schema.optionalKey(Schema.Never),
})

export const Lesson = Schema.Union([RealLesson, GhostLesson])

export const Section = Schema.Struct({
	sourceId: SourceId,
	stableKey: NonEmptyString,
	clientKey: ClientKey,
	title: NonEmptyString,
	path: RelativePath,
	order: Schema.Number,
	description: Schema.optionalKey(Schema.String),
	lessons: Schema.Array(Lesson),
	courseBuilder: Schema.optionalKey(CourseBuilderResourceRef),
	metadata: Schema.optionalKey(Metadata),
})

export const SourceAssetKind = Schema.Literals([
	"video",
	"video-meta",
	"transcript",
	"markdown",
	"source-file",
	"todo-marker",
])

export const SourceAsset = Schema.Struct({
	kind: SourceAssetKind,
	sourcePath: RelativePath,
	bytes: Schema.optionalKey(NonNegativeInt),
	sha256: Schema.optionalKey(Sha256),
	modifiedAt: Schema.optionalKey(IsoDateTimeString),
	metadata: Schema.optionalKey(Metadata),
})

export const ChangeKind = Schema.Literals([
	"new-section",
	"renamed-section",
	"deleted-section",
	"new-lesson",
	"renamed-lesson",
	"deleted-lesson",
	"updated-lesson",
	"marked-ready",
	"marked-todo",
	"new-video",
	"updated-video",
	"deleted-video",
])

export const CourseChange = Schema.Struct({
	kind: ChangeKind,
	path: RelativePath,
	previousPath: Schema.optionalKey(RelativePath),
	message: Schema.optionalKey(Schema.String),
	metadata: Schema.optionalKey(Metadata),
})

export const CourseSyncWarning = Schema.Struct({
	code: NonEmptyString,
	message: NonEmptyString,
	path: Schema.optionalKey(RelativePath),
	metadata: Schema.optionalKey(Metadata),
})

export const CourseSyncDocument = Schema.Struct({
	schema: Schema.Literal(COURSE_SYNC_SCHEMA_VERSION),
	producer: Producer,
	course: Course,
	sections: Schema.Array(Section),
	assets: Schema.optionalKey(Schema.Array(SourceAsset)),
	changes: Schema.optionalKey(Schema.Array(CourseChange)),
	warnings: Schema.optionalKey(Schema.Array(CourseSyncWarning)),
	metadata: Schema.optionalKey(Metadata),
})

export type Producer = typeof Producer.Type
export type CourseBuilderResourceRef = typeof CourseBuilderResourceRef.Type
export type CourseBuilderTarget = typeof CourseBuilderTarget.Type
export type CourseVersion = typeof CourseVersion.Type
export type Course = typeof Course.Type
export type Segment = typeof Segment.Type
export type Chapter = typeof Chapter.Type
export type Transcript = typeof Transcript.Type
export type MediaAsset = typeof MediaAsset.Type
export type Video = typeof Video.Type
export type LessonBody = typeof LessonBody.Type
export type RealLesson = typeof RealLesson.Type
export type GhostLesson = typeof GhostLesson.Type
export type Lesson = typeof Lesson.Type
export type Section = typeof Section.Type
export type SourceAsset = typeof SourceAsset.Type
export type CourseChange = typeof CourseChange.Type
export type CourseSyncWarning = typeof CourseSyncWarning.Type
export type CourseSyncDocument = typeof CourseSyncDocument.Type

export const decodeCourseSyncDocument = Schema.decodeUnknownSync(CourseSyncDocument)
export const encodeCourseSyncDocument = Schema.encodeUnknownSync(CourseSyncDocument)

export const makeCourseBuilderClientKey = (
	resourceType: "workshop" | "lesson",
	stableKey: string
): `${typeof resourceType}:${string}` => `${resourceType}:${stableKey}`
