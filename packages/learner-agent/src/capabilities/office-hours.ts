import { Clock, Effect, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { OfficeHoursSession } from '../domain.js'
import { SignInRequired, Unavailable } from '../errors.js'
import { NextActions, nextHref, nextTool } from '../next-actions.js'
import { Entitlements, LearnerContent } from '../services.js'
import { requireLearner } from './shared.js'

export const officeHoursContract = defineContract('office_hours', {
	title: 'Office hours',
	description:
		'Upcoming and live office hours for the cohorts the learner owns: weekday, time in UTC and the YouTube link.',
	input: Schema.Struct({
		course: Schema.optionalKey(
			Schema.String.annotate({
				description: 'Limit to one cohort, by slug or id.',
			}),
		),
	}),
	output: Schema.Struct({
		sessions: Schema.Array(OfficeHoursSession),
		next_actions: NextActions,
	}),
	failure: Schema.Union([SignInRequired, Unavailable]),
	annotations: { readOnly: true, idempotent: true },
})

const weekdayFormat = new Intl.DateTimeFormat('en-US', {
	weekday: 'long',
	timeZone: 'UTC',
})
const timeFormat = new Intl.DateTimeFormat('en-GB', {
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
	timeZone: 'UTC',
})

export const officeHours = implement(officeHoursContract, ({ course }) =>
	Effect.gen(function* () {
		const learner = yield* requireLearner
		const entitlements = yield* Entitlements
		const content = yield* LearnerContent
		const now = yield* Clock.currentTimeMillis

		const cohorts = (yield* entitlements.ownedCourses(learner)).filter(
			(owned) =>
				owned.type === 'cohort' &&
				(course === undefined || owned.slug === course || owned.id === course),
		)

		const schedules = yield* Effect.forEach(
			cohorts,
			(cohort) => content.officeHours(cohort.id),
			{ concurrency: 4 },
		)

		const sessions = schedules
			.flatMap((schedule) =>
				schedule
					? schedule.sessions.map((session) => ({
							...session,
							course: schedule.course,
						}))
					: [],
			)
			.filter((session) => new Date(session.endsAt).getTime() > now)
			.sort(
				(a, b) =>
					new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
			)
			.map((session) => {
				const startsAt = new Date(session.startsAt)
				const endsAt = new Date(session.endsAt)
				return {
					course: session.course,
					title: session.title,
					startsAt: session.startsAt,
					endsAt: session.endsAt,
					weekday: weekdayFormat.format(startsAt),
					time: `${timeFormat.format(startsAt)} to ${timeFormat.format(endsAt)} UTC`,
					timezone: 'UTC' as const,
					youtubeUrl: session.youtubeWatchUrl,
					status:
						startsAt.getTime() <= now
							? ('live' as const)
							: ('upcoming' as const),
				}
			})

		const first = sessions[0]

		return {
			sessions,
			next_actions: [
				...(first
					? [nextHref(first.youtubeUrl, `Join ${first.title} on YouTube.`)]
					: []),
				nextTool('my_courses', 'List the courses this learner owns.'),
			],
		}
	}),
)
