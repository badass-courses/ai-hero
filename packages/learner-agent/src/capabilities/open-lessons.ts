import { Effect, Schema } from 'effect'

import type { CourseLesson, CourseRef } from '../domain.js'
import { NotEntitled, NotFound } from '../errors.js'
import { nextHref, nextTool } from '../next-actions.js'
import type { Learner } from '../ports.js'
import { Entitlements, LearnerContent } from '../services.js'

/** A lesson as cross-course results name it. */
export const LessonPlace = Schema.Struct({
	lesson: Schema.Struct({
		id: Schema.String,
		slug: Schema.String,
		title: Schema.String,
		url: Schema.String,
	}),
	workshop: Schema.Struct({ slug: Schema.String, title: Schema.String }),
})
export type LessonPlace = typeof LessonPlace.Type

export type OpenLesson = {
	readonly lesson: CourseLesson
	readonly workshop: { readonly slug: string; readonly title: string }
}

/**
 * The lessons of one course this learner can read now: only workshops the
 * entitlements port answers `Open` for, so embargoed and unowned workshops
 * contribute nothing.
 */
export const openLessons = (learner: Learner, course: string) =>
	Effect.gen(function* () {
		const entitlements = yield* Entitlements
		const content = yield* LearnerContent

		const structure = yield* content.course(course)
		if (!structure) {
			return yield* new NotFound({
				message: `No course matches "${course}".`,
				next_actions: [
					nextTool('my_courses', 'List the courses this learner owns.'),
				],
			})
		}

		const access = yield* Effect.forEach(
			structure.workshops,
			(workshop) => entitlements.workshopAccess(learner, workshop.id),
			{ concurrency: 4 },
		)
		if (access.every((entry) => entry._tag === 'NotEntitled')) {
			return yield* new NotEntitled({
				message: `This learner does not own ${structure.course.title}.`,
				next_actions: [
					nextHref(
						structure.course.url,
						`See ${structure.course.title} on AI Hero.`,
					),
					nextTool('my_courses', 'List the courses this learner owns.'),
				],
			})
		}

		const lessons: OpenLesson[] = structure.workshops.flatMap(
			(workshop, index) =>
				access[index]?._tag === 'Open'
					? workshop.sections.flatMap((section) =>
							section.lessons.map((lesson) => ({
								lesson,
								workshop: { slug: workshop.slug, title: workshop.title },
							})),
						)
					: [],
		)
		return { course: structure.course as CourseRef, lessons }
	})

export function lessonPlace(open: OpenLesson): LessonPlace {
	return {
		lesson: {
			id: open.lesson.id,
			slug: open.lesson.slug,
			title: open.lesson.title,
			url: open.lesson.url,
		},
		workshop: open.workshop,
	}
}

/** Each lesson once, in course order, keeping the first place it appears. */
export function uniqueLessons(
	lessons: ReadonlyArray<OpenLesson>,
): OpenLesson[] {
	const seen = new Set<string>()
	return lessons.filter((open) => {
		if (seen.has(open.lesson.id)) return false
		seen.add(open.lesson.id)
		return true
	})
}
