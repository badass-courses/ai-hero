import { Effect, Schema } from 'effect'

import type { CourseLesson, CourseRef } from '../domain.js'
import { NotEntitled, NotFound } from '../errors.js'
import { nextHref, nextTool, type NextAction } from '../next-actions.js'
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

/**
 * Lessons whose extracts one cross-course call may load. A cohort can hold
 * many more; past this the result says it was cut and names the workshop to
 * narrow to, so one call never fans out over every extract in a cohort.
 */
export const MAX_LESSONS_PER_CALL = 30

/** The lessons one call searches, and the first workshop it left out. */
export function capLessons(lessons: ReadonlyArray<OpenLesson>) {
	const searched = lessons.slice(0, MAX_LESSONS_PER_CALL)
	return {
		searched,
		inScope: lessons.length,
		cut: lessons.length > searched.length,
		nextWorkshop: lessons[MAX_LESSONS_PER_CALL]?.workshop ?? null,
	}
}

/** When the cap cut in: search the first workshop left out on its own. */
export function narrowAction(
	tool: 'session_moments' | 'skill_usage',
	capped: ReturnType<typeof capLessons>,
	args: Record<string, unknown>,
): NextAction[] {
	if (!capped.cut || !capped.nextWorkshop) return []
	return [
		nextTool(
			tool,
			`Searched the first ${capped.searched.length} of ${capped.inScope} lessons. Search ${capped.nextWorkshop.title} on its own for the rest.`,
			{ ...args, course: capped.nextWorkshop.slug },
		),
	]
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
