import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { CourseRef, OutlineWorkshop } from '../domain.js'
import {
	NotEntitled,
	NotFound,
	SignInRequired,
	Unavailable,
} from '../errors.js'
import {
	NextActions,
	nextHref,
	nextTool,
	type NextAction,
} from '../next-actions.js'
import {
	Entitlements,
	LearnerAudit,
	LearnerContent,
	LearnerProgress,
} from '../services.js'
import { instructionsAction, requireLearner } from './shared.js'

export const courseOutlineContract = defineContract('course_outline', {
	title: 'Course outline',
	description:
		'The workshops, sections and lessons of one course the learner owns, with their completion state. A workshop that has not opened shows its title and open date only.',
	input: Schema.Struct({
		course: Schema.String.annotate({
			description: 'Course or workshop slug or id, as returned by my_courses.',
		}),
	}),
	output: Schema.Struct({
		course: CourseRef,
		workshops: Schema.Array(OutlineWorkshop),
		progress: Schema.Struct({ completed: Schema.Finite, total: Schema.Finite }),
		next_actions: NextActions,
	}),
	failure: Schema.Union([SignInRequired, NotFound, NotEntitled, Unavailable]),
	annotations: { readOnly: true, idempotent: true },
})

export const courseOutline = implement(courseOutlineContract, ({ course }) =>
	Effect.gen(function* () {
		const learner = yield* requireLearner
		const entitlements = yield* Entitlements
		const content = yield* LearnerContent
		const progress = yield* LearnerProgress
		const audit = yield* LearnerAudit

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

		const openLessonIds = structure.workshops.flatMap((workshop, index) =>
			access[index]?._tag === 'Open'
				? workshop.sections.flatMap((section) =>
						section.lessons.map((lesson) => lesson.id),
					)
				: [],
		)
		const completed = yield* progress.completed(learner, openLessonIds)

		const workshops = structure.workshops.map(
			(workshop, index): OutlineWorkshop => {
				const workshopAccess = access[index] ?? { _tag: 'NotEntitled' as const }
				const summary = {
					id: workshop.id,
					slug: workshop.slug,
					title: workshop.title,
					url: workshop.url,
					opensAt:
						workshopAccess._tag === 'NotYetOpen'
							? workshopAccess.opensAt
							: workshop.opensAt,
					isOpen: workshopAccess._tag === 'Open',
				}
				switch (workshopAccess._tag) {
					// Embargoed or unowned: title and date only, never lessons.
					case 'NotYetOpen':
						return { ...summary, access: 'not_yet_open', sections: [] }
					case 'NotEntitled':
						return { ...summary, access: 'not_entitled', sections: [] }
					case 'Open':
						return {
							...summary,
							access: 'open',
							sections: workshop.sections.map((section) => ({
								title: section.title,
								lessons: section.lessons.map((lesson) => ({
									...lesson,
									completed: completed.has(lesson.id),
								})),
							})),
						}
				}
			},
		)

		yield* audit.read({
			userId: learner.userId,
			capability: 'course_outline',
			resourceId: structure.course.id,
		})

		return {
			course: structure.course,
			workshops,
			progress: {
				completed: openLessonIds.filter((id) => completed.has(id)).length,
				total: openLessonIds.length,
			},
			next_actions: [
				...nextLessonActions(workshops),
				yield* instructionsAction(structure.course.url),
				nextTool('my_courses', 'Back to the learner’s courses.'),
			],
		}
	}),
)

function nextLessonActions(
	workshops: ReadonlyArray<OutlineWorkshop>,
): NextAction[] {
	for (const workshop of workshops) {
		for (const section of workshop.sections) {
			const lesson = section.lessons.find((entry) => !entry.completed)
			if (lesson) {
				return [
					nextTool('read_lesson', `Read the next lesson: ${lesson.title}.`, {
						lesson: lesson.slug,
						workshop: workshop.slug,
					}),
				]
			}
		}
	}
	const upcoming = workshops.find(
		(workshop) => workshop.access === 'not_yet_open' && workshop.opensAt,
	)
	return upcoming
		? [
				nextTool(
					'office_hours',
					`Every open lesson is complete. ${upcoming.title} opens ${upcoming.opensAt}; office hours are the next live session.`,
				),
			]
		: []
}
