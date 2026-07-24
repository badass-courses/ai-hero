import { createHash } from "node:crypto"

export function makeCourseJsonV3Fixture() {
	let videoNumber = 0
	return {
		$schema: "course.schema.json",
		schemaVersion: 3,
		courseId: "50385098-a712-486f-b777-1f76ef31e9e5",
		courseVersionId: "course-version-fixture-v3",
		archiveTTL: "90d",
		courseName: "Fixture Course",
		sections: Array.from({ length: 3 }, (_, sectionIndex) => ({
			id: `section-${sectionIndex + 1}`,
			title: `Section ${sectionIndex + 1}`,
			lessons: Array.from({ length: 8 }, (_, lessonIndex) => {
				videoNumber += 1
				const bytes = Buffer.from(`video-${videoNumber}`)
				return {
					type: "explainer" as const,
					id: `lesson-${videoNumber}`,
					title: `Lesson ${videoNumber}`,
					explainer: {
						id: `video-${videoNumber}`,
						relativePath: `course-version-fixture/section-${sectionIndex + 1}/lesson-${lessonIndex + 1}/video-${videoNumber}.mp4`,
						body: `Body ${videoNumber}`,
						description: `Description ${videoNumber}`,
						hash: `render-input-${videoNumber}`,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						bytes: bytes.byteLength,
						chapters: [],
					},
				}
			}),
		})),
	}
}
