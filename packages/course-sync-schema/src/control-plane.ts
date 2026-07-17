import { Schema } from "effect"

import { CourseJsonDocumentV3 } from "./course-json-v3.js"

export const COURSE_SYNC_API_VERSION =
	"aihero.course-sync-control-plane.v1" as const

const NonEmptyString = Schema.NonEmptyString

/** Public request schemas intentionally have no target identifier fields. */
export const StageSourceRevisionRequest = Schema.Struct({
	manifest: CourseJsonDocumentV3,
})

export const RunOperationRequest = Schema.Struct({})

export const CourseSyncRunState = Schema.Literals([
	"staged",
	"previewed",
	"applying",
	"applied",
	"failed",
	"rolled_back",
])

export const CourseSyncResourceAction = Schema.Literals([
	"create",
	"update",
	"retain",
])

export const CourseSyncBindingSummary = Schema.Struct({
	bindingId: NonEmptyString,
	status: Schema.Literals(["active", "suspended", "revoked"]),
	sourceCourseId: NonEmptyString,
	target: Schema.Struct({
		productType: Schema.Literal("self-paced"),
		anchorResourceType: Schema.Literal("workshop"),
		requiredState: Schema.Literal("draft"),
		requiredVisibility: Schema.Literal("unlisted"),
		sectionMappingPolicy: Schema.Literal("two-sections-in-anchor-workshop"),
	}),
})

export const CourseSyncRunSummary = Schema.Struct({
	runId: NonEmptyString,
	bindingId: NonEmptyString,
	courseVersionId: NonEmptyString,
	state: CourseSyncRunState,
	planSha256: Schema.NullOr(Schema.String),
	noOp: Schema.Boolean,
	failureCode: Schema.NullOr(Schema.String),
	plan: Schema.NullOr(
		Schema.Struct({
			resources: Schema.Array(
				Schema.Struct({
					sourceKind: Schema.Literals(["section", "lesson"]),
					sourceId: NonEmptyString,
					action: CourseSyncResourceAction,
					position: Schema.Number,
				})
			),
			media: Schema.Array(
				Schema.Struct({
					sourceVideoId: NonEmptyString,
					action: Schema.Literals(["update", "retain"]),
				})
			),
		})
	),
	resourceCounts: Schema.Struct({
		create: Schema.Number,
		update: Schema.Number,
		retain: Schema.Number,
	}),
})

export type StageSourceRevisionRequest = typeof StageSourceRevisionRequest.Type
export type CourseSyncRunState = typeof CourseSyncRunState.Type
export type CourseSyncResourceAction = typeof CourseSyncResourceAction.Type
export type CourseSyncBindingSummary = typeof CourseSyncBindingSummary.Type
export type CourseSyncRunSummary = typeof CourseSyncRunSummary.Type

export const decodeStageSourceRevisionRequest = Schema.decodeUnknownSync(
	StageSourceRevisionRequest,
	{ onExcessProperty: "error" },
)
export const decodeRunOperationRequest =
	Schema.decodeUnknownSync(RunOperationRequest)
export const decodeCourseSyncBindingSummary = Schema.decodeUnknownSync(
	CourseSyncBindingSummary,
)
export const decodeCourseSyncRunSummary =
	Schema.decodeUnknownSync(CourseSyncRunSummary)
