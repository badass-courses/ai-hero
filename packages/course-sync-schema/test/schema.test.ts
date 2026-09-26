import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

import {
	CourseSyncDocument,
	decodeCourseSyncDocument,
	makeCourseBuilderClientKey,
} from "../src/schema.js"
import {
	courseJsonVideos,
	decodeCourseJsonDocument,
	decodeCourseJsonDocumentV3,
} from "../src/course-json-v3.js"
import {
	decodeCourseSyncBindingSummary,
	decodeCourseSyncRunSummary,
	decodeStageSourceRevisionRequest,
} from "../src/control-plane.js"
import { makeCourseJsonV3Fixture } from "./fixtures/course-json.v3.js"
import { makeCourseJsonV4SyllabusFixture } from "./fixtures/course-json.v4.js"

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, "fixtures/course-sync.v1.json")
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"))

const decoded = decodeCourseSyncDocument(fixture)

assert.equal(decoded.schema, "aihero.course-sync.v1")
assert.equal(decoded.producer.name, "course-video-manager")
assert.equal(decoded.course.courseBuilder?.cohortId, "cohort-m0k0w")
assert.equal(decoded.sections[0]?.lessons.length, 2)

const realLesson = decoded.sections[0]?.lessons[0]
assert.equal(realLesson?.fsStatus, "real")
if (realLesson?.fsStatus === "real") {
	assert.equal(realLesson.authoringStatus, "done")
}

const ghostLesson = decoded.sections[0]?.lessons[1]
assert.equal(ghostLesson?.fsStatus, "ghost")
assert.equal("authoringStatus" in (ghostLesson ?? {}), false)

assert.equal(
	makeCourseBuilderClientKey("lesson", "database-migrations"),
	"lesson:database-migrations",
)

assert.throws(() => {
	decodeCourseSyncDocument({
		...fixture,
		sections: [
			{
				...fixture.sections[0],
				lessons: [
					{
						...fixture.sections[0].lessons[1],
						authoringStatus: "todo",
					},
				],
			},
		],
	})
})

assert.throws(() => {
	decodeCourseSyncDocument({
		...fixture,
		sections: [
			{
				...fixture.sections[0],
				path: "../outside-course",
			},
		],
	})
})

assert.doesNotThrow(() => {
	Schema.encodeUnknownSync(CourseSyncDocument)(decoded)
})

const v3 = decodeCourseJsonDocumentV3(makeCourseJsonV3Fixture())
assert.equal(v3.schemaVersion, 3)
assert.equal(v3.archiveTTL, "90d")
assert.equal(v3.sections.length, 3)
assert.equal(courseJsonVideos(v3).length, 24)

const syllabus = decodeCourseJsonDocument(makeCourseJsonV4SyllabusFixture())
assert.equal(syllabus.schemaVersion, 4)
assert.equal(syllabus.sections.length, 3)
assert.equal(syllabus.sections[0]?.lessons.length, 8)
assert.equal(courseJsonVideos(syllabus).length, 0)
assert.doesNotThrow(() => decodeStageSourceRevisionRequest({ manifest: syllabus }))
assert.throws(() =>
	decodeCourseJsonDocument({
		...makeCourseJsonV4SyllabusFixture(),
		sections: [{
			...makeCourseJsonV4SyllabusFixture().sections[0],
			lessons: [{ type: "placeholder", id: "lesson-1", title: "Lesson 1", description: "extra" }],
		}],
	}),
)
assert.throws(() =>
	decodeCourseJsonDocument({ ...makeCourseJsonV4SyllabusFixture(), schemaVersion: 5 }),
)

assert.throws(() =>
	decodeCourseJsonDocumentV3({
		...makeCourseJsonV3Fixture(),
		schemaVersion: 2,
	}),
)
assert.throws(() =>
	decodeCourseJsonDocumentV3({
		...makeCourseJsonV3Fixture(),
		sections: [
			{
				...makeCourseJsonV3Fixture().sections[0],
				lessons: [
					{
						...makeCourseJsonV3Fixture().sections[0]?.lessons[0],
						explainer: {
							...makeCourseJsonV3Fixture().sections[0]?.lessons[0]?.explainer,
							relativePath: "../outside.mp4",
						},
					},
				],
			},
		],
	}),
)
assert.doesNotThrow(() =>
	decodeStageSourceRevisionRequest({ manifest: makeCourseJsonV3Fixture() }),
)
assert.doesNotThrow(() =>
	decodeCourseSyncBindingSummary({
		bindingId: "csb_ai_coding_crash_course",
		contractVersion: 4,
		status: "active",
		sourceCourseId: "50385098-a712-486f-b777-1f76ef31e9e5",
		applyPolicy: "bounded-auto",
		target: {
			product: {
				type: "self-paced",
				state: "published",
				visibility: "public",
			},
			workshop: {
				type: "workshop",
				state: "published",
				visibility: "public",
			},
			managedChildren: { state: "draft", visibility: "unlisted" },
			sectionMappingPolicy: "sections-in-anchor-workshop",
		},
	}),
)
assert.doesNotThrow(() =>
	decodeCourseSyncBindingSummary({
		bindingId: "csb_test_cohort",
		contractVersion: 5,
		status: "active",
		sourceCourseId: "test-course",
		applyPolicy: "operator",
		target: {
			product: { type: "cohort", state: "draft", visibility: "unlisted" },
			cohort: { type: "cohort", state: "draft", visibility: "unlisted" },
			managedChildren: {
				workshop: { state: "draft", visibility: "unlisted" },
				lesson: { state: "draft", visibility: "unlisted" },
			},
			sectionMappingPolicy: "sections-as-cohort-workshops",
		},
	}),
)
assert.throws(() =>
	decodeCourseSyncBindingSummary({
		bindingId: "csb_ai_coding_crash_course",
		contractVersion: 4,
		status: "active",
		sourceCourseId: "50385098-a712-486f-b777-1f76ef31e9e5",
		applyPolicy: "bounded-auto",
		target: {
			product: {
				type: "self-paced",
				state: "published",
				visibility: "public",
			},
			workshop: {
				type: "workshop",
				state: "published",
				visibility: "public",
			},
			managedChildren: { state: "draft", visibility: "unlisted" },
			sectionMappingPolicy: "two-sections-in-anchor-workshop",
		},
	}),
)
assert.doesNotThrow(() =>
	decodeCourseSyncRunSummary({
		runId: "run-superseded",
		bindingId: "csb_ai_coding_crash_course",
		courseVersionId: "version-a",
		state: "superseded",
		planSha256: "a".repeat(64),
		noOp: false,
		failureCode: null,
		plan: null,
		resourceCounts: { create: 0, update: 0, retain: 0 },
	}),
)
assert.throws(() =>
	decodeStageSourceRevisionRequest({
		manifest: { ...makeCourseJsonV3Fixture(), productId: "caller-target" },
	}),
)

console.log("course-sync-schema tests passed")
