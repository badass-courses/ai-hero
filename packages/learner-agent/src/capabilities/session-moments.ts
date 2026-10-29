import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { CourseRef } from '../domain.js'
import {
	NotEntitled,
	NotFound,
	SignInRequired,
	Unavailable,
} from '../errors.js'
import { NextActions, nextTool, type NextAction } from '../next-actions.js'
import { LearnerAudit, LearnerContent } from '../services.js'
import {
	MomentKind,
	SessionMoment,
	extractMoments,
	type SkillLinks,
} from '../session-views.js'
import {
	LessonPlace,
	lessonPlace,
	openLessons,
	uniqueLessons,
	type OpenLesson,
} from './open-lessons.js'
import { skillLinks } from './session-extract.js'
import { requireLearner } from './shared.js'

const ALL_KINDS: ReadonlyArray<MomentKind> = [
	'prompt',
	'correction',
	'skill',
	'error',
]

export const CourseMoment = Schema.Struct({
	...LessonPlace.fields,
	moment: SessionMoment,
})
export type CourseMoment = typeof CourseMoment.Type

export const sessionMomentsContract = defineContract('session_moments', {
	title: 'Session moments',
	description:
		'Moments from Matt’s on-screen sessions across every lesson of one course the learner can read now: prompts he typed, course corrections (an interrupt and the prompt after it), skill calls, and failed tool calls with what came next. Each moment names its lesson and video second. Embargoed workshops contribute nothing.',
	input: Schema.Struct({
		course: Schema.String.annotate({
			description: 'Course or workshop slug or id, as returned by my_courses.',
		}),
		kind: Schema.optionalKey(
			MomentKind.annotate({
				description: 'prompt, correction, skill or error. Default: all four.',
			}),
		),
		limit: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
			.annotate({ description: 'Maximum moments. Default 100.' })
			.pipe(Schema.withDecodingDefaultKey(Effect.succeed(100))),
	}),
	output: Schema.Struct({
		course: CourseRef,
		kinds: Schema.Array(MomentKind),
		lessonsSearched: Schema.Finite,
		total: Schema.Finite,
		truncated: Schema.Boolean,
		moments: Schema.Array(CourseMoment),
		next_actions: NextActions,
	}),
	failure: Schema.Union([SignInRequired, NotFound, NotEntitled, Unavailable]),
	annotations: { readOnly: true, idempotent: true },
})

/** Every moment of `kinds` in these lessons, in course order. */
export const momentsAcross = (
	lessons: ReadonlyArray<OpenLesson>,
	kinds: ReadonlyArray<MomentKind>,
	links: SkillLinks,
) =>
	Effect.gen(function* () {
		const content = yield* LearnerContent
		const extracts = yield* content.sessionExtracts(
			lessons.map((open) => open.lesson.id),
		)
		const byLesson = new Map(
			extracts.map((entry) => [entry.lessonId, entry.extract]),
		)
		return lessons.flatMap((open) => {
			const extract = byLesson.get(open.lesson.id)
			if (!extract) return []
			const place = lessonPlace(open)
			return extractMoments(extract, kinds, links).map(
				(moment): CourseMoment => ({ ...place, moment }),
			)
		})
	})

/** Open the first result at its second in the video. */
export function atMomentAction(moment: CourseMoment | undefined): NextAction[] {
	if (!moment) return []
	return [
		nextTool(
			'session_extract',
			`See what was on screen around this moment in ${moment.lesson.title}.`,
			{
				lesson: moment.lesson.slug,
				workshop: moment.workshop.slug,
				atSeconds: moment.moment.visibleFrom,
			},
		),
	]
}

export const sessionMoments = implement(
	sessionMomentsContract,
	({ course, kind, limit }) =>
		Effect.gen(function* () {
			const learner = yield* requireLearner
			const audit = yield* LearnerAudit
			const open = yield* openLessons(learner, course)
			const lessons = uniqueLessons(open.lessons)
			const kinds = kind ? [kind] : ALL_KINDS
			const links = kinds.includes('skill')
				? yield* skillLinks
				: (new Map() as SkillLinks)

			const moments = yield* momentsAcross(lessons, kinds, links)

			yield* audit.read({
				userId: learner.userId,
				capability: 'session_moments',
				resourceId: open.course.id,
			})

			const shown = moments.slice(0, limit)
			return {
				course: open.course,
				kinds,
				lessonsSearched: lessons.length,
				total: moments.length,
				truncated: moments.length > shown.length,
				moments: shown,
				next_actions: [
					...atMomentAction(shown[0]),
					nextTool(
						'course_outline',
						`Back to the ${open.course.title} outline.`,
						{
							course: open.course.slug,
						},
					),
				],
			}
		}),
)
