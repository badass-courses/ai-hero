import { Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { CourseRef } from '../domain.js'
import {
	NotEntitled,
	NotFound,
	SignInRequired,
	Unavailable,
} from '../errors.js'
import { NextActions, nextHref, nextTool } from '../next-actions.js'
import { Entitlements, LearnerAudit } from '../services.js'
import { skillKey } from '../session-views.js'
import { openLessons, uniqueLessons, type OpenLesson } from './open-lessons.js'
import { skillLinks } from './session-extract.js'
import {
	CourseMoment,
	atMomentAction,
	momentsAcross,
} from './session-moments.js'
import { requireLearner } from './shared.js'

export const skillUsageContract = defineContract('skill_usage', {
	title: 'Skill usage',
	description:
		'Every lesson and video moment where Matt’s session runs one skill, across the courses the learner can read now (or one course), with the arguments it was given and a link to the skill’s AI Hero page when there is one.',
	input: Schema.Struct({
		skill: Schema.String.check(Schema.isMinLength(1)).annotate({
			description: 'Skill name, with or without the slash: tdd or /tdd.',
		}),
		course: Schema.optionalKey(
			Schema.String.annotate({
				description:
					'Limit to one course or workshop, by slug or id. Default: every owned course.',
			}),
		),
		limit: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
			.annotate({ description: 'Maximum moments. Default 100.' })
			.pipe(Schema.withDecodingDefaultKey(Effect.succeed(100))),
	}),
	output: Schema.Struct({
		skill: Schema.String,
		skillUrl: Schema.NullOr(Schema.String),
		courses: Schema.Array(CourseRef),
		lessonsSearched: Schema.Finite,
		lessonsUsingSkill: Schema.Finite,
		total: Schema.Finite,
		truncated: Schema.Boolean,
		uses: Schema.Array(CourseMoment),
		next_actions: NextActions,
	}),
	failure: Schema.Union([SignInRequired, NotFound, NotEntitled, Unavailable]),
	annotations: { readOnly: true, idempotent: true },
})

export const skillUsage = implement(
	skillUsageContract,
	({ skill, course, limit }) =>
		Effect.gen(function* () {
			const learner = yield* requireLearner
			const audit = yield* LearnerAudit
			const entitlements = yield* Entitlements

			// One named course must be readable; across all owned courses, one
			// that has gone missing or unowned is skipped, not fatal.
			const opened = course
				? [yield* openLessons(learner, course)]
				: (yield* Effect.forEach(
						yield* entitlements.ownedCourses(learner),
						(owned) =>
							openLessons(learner, owned.id).pipe(
								Effect.catchTags({
									NotFound: () => Effect.succeed(null),
									NotEntitled: () => Effect.succeed(null),
								}),
							),
						{ concurrency: 2 },
					)).filter((entry) => entry !== null)

			const lessons: OpenLesson[] = uniqueLessons(
				opened.flatMap((entry) => entry.lessons),
			)
			const links = yield* skillLinks
			const key = skillKey(skill)
			const uses = (yield* momentsAcross(lessons, ['skill'], links)).filter(
				(use) =>
					use.moment.kind === 'skill' && skillKey(use.moment.skill) === key,
			)

			for (const entry of opened) {
				yield* audit.read({
					userId: learner.userId,
					capability: 'skill_usage',
					resourceId: entry.course.id,
				})
			}

			const skillUrl = links.get(key) ?? null
			const shown = uses.slice(0, limit)
			return {
				skill: key,
				skillUrl,
				courses: opened.map((entry) => entry.course),
				lessonsSearched: lessons.length,
				lessonsUsingSkill: new Set(uses.map((use) => use.lesson.id)).size,
				total: uses.length,
				truncated: uses.length > shown.length,
				uses: shown,
				next_actions: [
					...atMomentAction(shown[0]),
					...(skillUrl
						? [nextHref(skillUrl, `Read about /${key} on AI Hero.`)]
						: []),
					...(opened.length === 0
						? [nextTool('my_courses', 'List the courses this learner owns.')]
						: []),
				],
			}
		}),
)
