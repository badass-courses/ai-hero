import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { OwnedCourse } from '../domain.js'
import { SignInRequired, Unavailable } from '../errors.js'
import { NextActions, nextHref, nextTool } from '../next-actions.js'
import { Entitlements, LearnerSite } from '../services.js'
import { instructionsAction, requireLearner } from './shared.js'

export const myCoursesContract = defineContract('my_courses', {
	title: 'My courses',
	description:
		'List the AI Hero courses the signed-in learner owns: each cohort or workshop, its workshops with open dates, whether each is open, and the next open date. Start here.',
	input: Schema.Struct({}),
	output: Schema.Struct({
		courses: Schema.Array(OwnedCourse),
		next_actions: NextActions,
	}),
	failure: Schema.Union([SignInRequired, Unavailable]),
	annotations: { readOnly: true, idempotent: true },
})

export const myCourses = implement(myCoursesContract, () =>
	Effect.gen(function* () {
		const learner = yield* requireLearner
		const entitlements = yield* Entitlements
		const site = yield* LearnerSite
		const courses = yield* entitlements.ownedCourses(learner)

		if (courses.length === 0) {
			return {
				courses,
				next_actions: [
					nextHref(
						site.baseUrl,
						'This learner owns no courses yet. See what AI Hero offers.',
					),
					nextTool('search_course', 'Search public AI Hero content.', {
						query: '<what to find>',
					}),
				],
			}
		}

		return {
			courses,
			next_actions: [
				...courses.map((course) =>
					nextTool('course_outline', `Open the outline of ${course.title}.`, {
						course: course.slug,
					}),
				),
				...(courses.some((course) => course.type === 'cohort')
					? [nextTool('office_hours', 'See upcoming live office hours.')]
					: []),
				yield* instructionsAction(),
			],
		}
	}),
)
