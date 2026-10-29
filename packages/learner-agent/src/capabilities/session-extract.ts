import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { LessonLinks, LessonRef } from '../domain.js'
import { NextActions, nextHref, nextTool } from '../next-actions.js'
import { LearnerAudit } from '../services.js'
import {
	SessionExtract,
	SessionExtractEntry,
	countEntries,
	windowSessionExtract,
} from '../session-extract.js'
import { readableLesson } from './lesson-access.js'
import { lessonFailure, lessonInputFields } from './read-lesson.js'
import { requireLearner } from './shared.js'

const DEFAULT_WINDOW_SECONDS = 90

export const sessionExtractContract = defineContract('session_extract', {
	title: 'Session extract',
	description:
		'The coding-agent session Matt shows on screen in one lesson video: his prompts, Claude’s replies, skill and tool calls and interrupts, each stamped with the video second it appears. Pass atSeconds to get what was on screen at that moment and the entries around it.',
	input: Schema.Struct({
		...lessonInputFields,
		atSeconds: Schema.optionalKey(
			Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
				description: 'Video time in seconds to centre the window on.',
			}),
		),
		windowSeconds: Schema.Finite.check(
			Schema.isBetween({ minimum: 1, maximum: 3600 }),
		)
			.annotate({
				description: 'Seconds either side of atSeconds. Default 90.',
			})
			.pipe(
				Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_WINDOW_SECONDS)),
			),
	}),
	output: Schema.Struct({
		lesson: LessonRef,
		links: LessonLinks,
		available: Schema.Boolean,
		entryCount: Schema.Finite,
		window: Schema.NullOr(
			Schema.Struct({
				atSeconds: Schema.Finite,
				fromSeconds: Schema.Finite,
				toSeconds: Schema.Finite,
			}),
		),
		onScreen: Schema.NullOr(SessionExtractEntry),
		extract: Schema.NullOr(SessionExtract),
		next_actions: NextActions,
	}),
	failure: lessonFailure,
	annotations: { readOnly: true, idempotent: true },
})

export const sessionExtract = implement(
	sessionExtractContract,
	({ lesson, workshop, atSeconds, windowSeconds }) =>
		Effect.gen(function* () {
			const learner = yield* requireLearner
			const audit = yield* LearnerAudit
			const content = yield* readableLesson(learner, { lesson, workshop })

			yield* audit.read({
				userId: learner.userId,
				capability: 'session_extract',
				resourceId: content.lesson.id,
			})

			const locator = {
				lesson: content.lesson.slug,
				workshop: content.workshop.slug,
			}
			const back = nextTool('read_lesson', 'Read the whole lesson.', locator)
			const extract = content.sessionExtract

			if (!extract) {
				return {
					lesson: content.lesson,
					links: content.links,
					available: false,
					entryCount: 0,
					window: null,
					onScreen: null,
					extract: null,
					next_actions: [back],
				}
			}

			if (atSeconds === undefined) {
				return {
					lesson: content.lesson,
					links: content.links,
					available: true,
					entryCount: countEntries(extract),
					window: null,
					onScreen: null,
					extract,
					next_actions: [
						nextHref(
							content.links.lesson,
							'Watch the video on the lesson page.',
						),
						back,
					],
				}
			}

			const windowed = windowSessionExtract(extract, atSeconds, windowSeconds)

			return {
				lesson: content.lesson,
				links: content.links,
				available: true,
				entryCount: countEntries(extract),
				window: {
					atSeconds,
					fromSeconds: Math.max(0, atSeconds - windowSeconds),
					toSeconds: atSeconds + windowSeconds,
				},
				onScreen: windowed.onScreen,
				extract: windowed.extract,
				next_actions: [
					// Same width, centred one window on, so successive windows meet.
					nextTool('session_extract', 'Move further along the video.', {
						...locator,
						atSeconds: atSeconds + windowSeconds * 2,
						windowSeconds,
					}),
					nextHref(content.links.lesson, 'Watch the video on the lesson page.'),
					back,
				],
			}
		}),
)
