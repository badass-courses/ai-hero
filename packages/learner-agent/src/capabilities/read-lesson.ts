import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { LessonLinks, LessonRef, SolutionText, WorkshopRef } from '../domain.js'
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
		'One lesson the learner owns: its text (the exercise), the video transcript, the session extract (the coding-agent session Matt shows on screen, timed to the video), and links to the lesson page. The solution stays hidden unless includeSolution is true; set it only when the learner asks for the solution.',
	input: Schema.Struct({
		...lessonInputFields,
		includeSolution: Schema.Boolean.annotate({
			description:
				'Include the solution text. Only when the learner asks for it.',
		}).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
	}),
	output: Schema.Struct({
		lesson: LessonRef,
		workshop: WorkshopRef,
		body: Schema.NullOr(Schema.String),
		transcript: Schema.NullOr(Schema.String),
		solutionAvailable: Schema.Boolean,
		solution: Schema.NullOr(SolutionText),
		sessionExtract: Schema.NullOr(SessionExtract),
		links: LessonLinks,
		next_actions: NextActions,
	}),
	failure: lessonFailure,
	annotations: { readOnly: true, idempotent: true },
})

export const readLesson = implement(
	readLessonContract,
	({ lesson, workshop, includeSolution }) =>
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
				solution: includeSolution ? content.solution : null,
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
					...(content.solution && !includeSolution
						? [
								nextTool(
									'read_lesson',
									'Only if the learner asks for it: read the solution.',
									{ ...locator, includeSolution: true },
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
