import { Effect } from 'effect'

import type { LessonLocator } from '../domain.js'
import { NotEntitled, NotFound, NotYetOpen } from '../errors.js'
import { nextHref, nextTool } from '../next-actions.js'
import type { Learner } from '../ports.js'
import { Entitlements, LearnerContent } from '../services.js'

/**
 * The lesson's content, only after the app's access rules say this learner
 * can read it. Every paid lesson read goes through here.
 */
export const readableLesson = (learner: Learner, locator: LessonLocator) =>
	Effect.gen(function* () {
		const entitlements = yield* Entitlements
		const content = yield* LearnerContent

		const access = yield* entitlements.lessonAccess(learner, locator)

		switch (access._tag) {
			case 'NotFound':
				return yield* new NotFound({
					message: `No lesson matches "${locator.lesson}".`,
					next_actions: [
						nextTool('search_course', 'Search for the lesson by title.', {
							query: locator.lesson,
						}),
						nextTool('my_courses', 'List the courses this learner owns.'),
					],
				})
			case 'NotEntitled':
				return yield* new NotEntitled({
					message: 'This learner does not own the course this lesson is in.',
					next_actions: [
						...(access.workshopUrl
							? [nextHref(access.workshopUrl, 'See the workshop on AI Hero.')]
							: []),
						nextTool('my_courses', 'List the courses this learner owns.'),
					],
				})
			case 'NotYetOpen':
				return yield* new NotYetOpen({
					message: `${access.workshopTitle} has not opened yet.`,
					title: access.workshopTitle,
					opensAt: access.opensAt,
					next_actions: [
						nextTool('my_courses', 'See open dates for every owned workshop.'),
					],
				})
			case 'Readable':
				break
		}

		const lesson = yield* content.lesson(locator)
		if (!lesson) {
			return yield* new NotFound({
				message: `No lesson matches "${locator.lesson}".`,
				next_actions: [
					nextTool('my_courses', 'List the courses this learner owns.'),
				],
			})
		}
		return lesson
	})
