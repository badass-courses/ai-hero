import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { LessonLinks, LessonRef, WorkshopRef } from '../domain.js'
import {
	NotEntitled,
	NotFound,
	NotYetOpen,
	SignInRequired,
	Unavailable,
} from '../errors.js'
import { NextActions, nextHref, nextTool } from '../next-actions.js'
import { LearnerAudit } from '../services.js'
import { SessionExtract } from '../session-extract.js'
import { readableLesson } from './lesson-access.js'
import { instructionsAction, requireLearner } from './shared.js'

export const lessonInputFields = {
	lesson: Schema.String.annotate({
		description: 'Lesson slug or id, as listed by course_outline.',
	}),
	workshop: Schema.optionalKey(
		Schema.String.annotate({
			description: 'Workshop slug or id the lesson belongs to.',
		}),
	),
}

export const lessonFailure = Schema.Union([
	SignInRequired,
	NotFound,
	NotEntitled,
	NotYetOpen,
	Unavailable,
])

export const readLessonContract = defineContract('read_lesson', {
	title: 'Read lesson',
	description:
		'One lesson the learner owns: its text (the exercise), the video transcript, the session extract (the coding-agent session Matt shows on screen, timed to the video), and links to the lesson page. Solutions are not served here: when the learner asks for one, give them the solution page link.',
	input: Schema.Struct(lessonInputFields),
	output: Schema.Struct({
		lesson: LessonRef,
		workshop: WorkshopRef,
		body: Schema.NullOr(Schema.String),
		transcript: Schema.NullOr(Schema.String),
		solutionAvailable: Schema.Boolean,
		sessionExtract: Schema.NullOr(SessionExtract),
		links: LessonLinks,
		next_actions: NextActions,
	}),
	failure: lessonFailure,
	annotations: { readOnly: true, idempotent: true },
})

export const readLesson = implement(
	readLessonContract,
	({ lesson, workshop }) =>
		Effect.gen(function* () {
			const learner = yield* requireLearner
			const audit = yield* LearnerAudit
			const content = yield* readableLesson(learner, { lesson, workshop })

			yield* audit.read({
				userId: learner.userId,
				capability: 'read_lesson',
				resourceId: content.lesson.id,
			})

			const locator = {
				lesson: content.lesson.slug,
				workshop: content.workshop.slug,
			}

			return {
				lesson: content.lesson,
				workshop: content.workshop,
				body: content.body,
				transcript: content.transcript,
				solutionAvailable: content.solution !== null,
				sessionExtract: content.sessionExtract,
				links: content.links,
				next_actions: [
					...(content.sessionExtract
						? [
								nextTool(
									'session_extract',
									'See what Matt had on screen at a moment in the video.',
									{ ...locator, atSeconds: '<video second>' },
								),
							]
						: []),
					...(content.solution && content.links.solution
						? [
								nextHref(
									content.links.solution,
									'Only if the learner asks for it: the solution page on the site.',
								),
							]
						: []),
					nextHref(content.links.lesson, 'Open the lesson page and its video.'),
					nextTool('course_outline', 'Back to the outline.', {
						course: content.workshop.slug,
					}),
					yield* instructionsAction(content.links.workshop),
				],
			}
		}),
)
