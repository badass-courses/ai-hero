import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { LessonLinks, LessonRef } from '../domain.js'
import { NextActions, nextHref, nextTool } from '../next-actions.js'
import { LearnerAudit, LearnerContent } from '../services.js'
import {
	SessionExtract,
	SessionExtractEntry,
	countEntries,
	windowSessionExtract,
} from '../session-extract.js'
import {
	SessionChapter,
	SessionMoment,
	SessionView,
	chapterOverlaps,
	momentKindForView,
	extractChapters,
	extractMoments,
	skillKey,
	type SkillLinks,
} from '../session-views.js'
import { readableLesson } from './lesson-access.js'
import { lessonFailure, lessonInputFields } from './read-lesson.js'
import { requireLearner } from './shared.js'

const DEFAULT_WINDOW_SECONDS = 90

export const sessionExtractContract = defineContract('session_extract', {
	title: 'Session extract',
	description:
		'The coding-agent session Matt shows on screen in one lesson video: his prompts, Claude’s replies, skill and tool calls and interrupts, each stamped with the video second it appears. Pass atSeconds to get what was on screen at that moment and the entries around it. Pass view for one slice of it: prompts (what Matt typed), corrections (each interrupt and the prompt after it), skills (each skill call, linked to its AI Hero page), errors (each failed tool call and what came next) or chapters (the session split at each prompt).',
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
		view: SessionView.annotate({
			description:
				'full (default), prompts, corrections, skills, errors or chapters. With atSeconds, only what falls in the window.',
		}).pipe(Schema.withDecodingDefaultKey(Effect.succeed('full' as const))),
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
		view: SessionView,
		onScreen: Schema.NullOr(SessionExtractEntry),
		/** The entries, for view `full`. */
		extract: Schema.NullOr(SessionExtract),
		/** For views prompts, corrections, skills and errors. */
		moments: Schema.NullOr(Schema.Array(SessionMoment)),
		/** For view chapters. */
		chapters: Schema.NullOr(Schema.Array(SessionChapter)),
		next_actions: NextActions,
	}),
	failure: lessonFailure,
	annotations: { readOnly: true, idempotent: true },
})

export const sessionExtract = implement(
	sessionExtractContract,
	({ lesson, workshop, atSeconds, windowSeconds, view }) =>
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
			const watch = nextHref(
				content.links.lesson,
				'Watch the video on the lesson page.',
			)
			const extract = content.sessionExtract
			const empty = {
				lesson: content.lesson,
				links: content.links,
				view,
				onScreen: null,
				extract: null,
				moments: null,
				chapters: null,
			}

			if (!extract) {
				return {
					...empty,
					available: false,
					entryCount: 0,
					window: null,
					next_actions: [back],
				}
			}

			const window =
				atSeconds === undefined
					? null
					: {
							atSeconds,
							fromSeconds: Math.max(0, atSeconds - windowSeconds),
							toSeconds: atSeconds + windowSeconds,
						}
			const windowed =
				atSeconds === undefined
					? null
					: windowSessionExtract(extract, atSeconds, windowSeconds)
			const inWindow = (seconds: number) =>
				!window ||
				(seconds >= window.fromSeconds && seconds <= window.toSeconds)

			const slice = yield* viewOf(extract, view)

			return {
				...empty,
				available: true,
				entryCount: countEntries(extract),
				window,
				onScreen: windowed?.onScreen ?? null,
				extract: view === 'full' ? (windowed?.extract ?? extract) : null,
				moments:
					slice.moments?.filter((moment) => inWindow(moment.visibleFrom)) ??
					null,
				chapters:
					slice.chapters?.filter(
						(chapter) =>
							!window ||
							chapterOverlaps(chapter, window.fromSeconds, window.toSeconds),
					) ?? null,
				next_actions: [
					...(atSeconds === undefined
						? []
						: [
								// Same width, centred one window on, so successive windows meet.
								nextTool('session_extract', 'Move further along the video.', {
									...locator,
									atSeconds: atSeconds + windowSeconds * 2,
									windowSeconds,
									...(view === 'full' ? {} : { view }),
								}),
							]),
					watch,
					back,
				],
			}
		}),
)

/** The moments or chapters `view` asks for; nothing extra for `full`. */
const viewOf = (extract: SessionExtract, view: SessionView) =>
	Effect.gen(function* () {
		switch (view) {
			case 'full':
				return { moments: null, chapters: null }
			case 'chapters':
				return { moments: null, chapters: extractChapters(extract) }
			case 'skills': {
				const links = yield* skillLinks
				return {
					moments: extractMoments(extract, ['skill'], links),
					chapters: null,
				}
			}
			default:
				return {
					moments: extractMoments(extract, [momentKindForView(view)]),
					chapters: null,
				}
		}
	})

/**
 * AI Hero's skill pages by skill name. A failed lookup leaves the moments
 * unlinked rather than failing the read.
 */
export const skillLinks: Effect.Effect<SkillLinks, never, LearnerContent> =
	Effect.gen(function* () {
		const content = yield* LearnerContent
		const links = yield* content
			.skillLinks()
			.pipe(Effect.orElseSucceed(() => []))
		return new Map(links.map((link) => [skillKey(link.skill), link.url]))
	})
