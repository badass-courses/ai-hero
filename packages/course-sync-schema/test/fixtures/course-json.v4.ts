import { makeCourseJsonV3Fixture } from "./course-json.v3.js"

export function makeCourseJsonV4SyllabusFixture() {
	const v3 = makeCourseJsonV3Fixture()
	return {
		...v3,
		schemaVersion: 4 as const,
		courseVersionId: "course-version-syllabus-v4",
		sections: v3.sections.map((section) => ({
			id: section.id,
			title: section.title,
			lessons: section.lessons.map(({ id, title }) => ({
				type: "placeholder" as const,
				id,
				title,
			})),
		})),
	}
}
