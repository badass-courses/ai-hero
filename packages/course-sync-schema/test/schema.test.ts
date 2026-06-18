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
	"lesson:database-migrations"
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

console.log("course-sync-schema tests passed")
