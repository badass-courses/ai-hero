export type ValuePathDripScheduleEvidence = {
	timezone?: string
}

/**
 * One cadence decision shared by the classifier and the intent create path.
 * The fixture-only cadence is carried on the canary intent; production
 * learners keep the established 18-hour floor plus local-day 09:00 rule.
 */
export function isLocalDayDripDue(args: {
	completedAt?: string
	now: string
	scheduleEvidence?: ValuePathDripScheduleEvidence
	cadenceHours?: number
}) {
	const completedAt = args.completedAt ? new Date(args.completedAt) : undefined
	const now = new Date(args.now)
	if (!completedAt || Number.isNaN(completedAt.getTime())) {
		return { due: false, reason: 'completed-at-missing' }
	}
	if (Number.isFinite(args.cadenceHours) && (args.cadenceHours ?? 0) > 0) {
		const fixtureDueAt = new Date(
			completedAt.getTime() + (args.cadenceHours ?? 0) * 60 * 60 * 1000,
		)
		return now >= fixtureDueAt
			? { due: true, reason: 'fixture-cadence-due' }
			: { due: false, reason: 'fixture-cadence-not-reached' }
	}

	const minimumDueAt = new Date(completedAt.getTime() + 18 * 60 * 60 * 1000)
	if (now < minimumDueAt) {
		return { due: false, reason: 'drip-min-age-not-reached' }
	}

	const timezone = args.scheduleEvidence?.timezone
	if (!timezone) {
		const fallbackDueAt = new Date(completedAt.getTime() + 24 * 60 * 60 * 1000)
		return now >= fallbackDueAt
			? { due: true, reason: 'fallback-24h-due' }
			: { due: false, reason: 'fallback-24h-not-reached' }
	}
	const localNow = localParts(now, timezone)
	const localCompleted = localParts(completedAt, timezone)
	if (!localNow || !localCompleted) {
		const fallbackDueAt = new Date(completedAt.getTime() + 24 * 60 * 60 * 1000)
		return now >= fallbackDueAt
			? { due: true, reason: 'fallback-24h-due' }
			: { due: false, reason: 'fallback-24h-not-reached' }
	}
	const afterCompletedLocalDay =
		localDateKey(localNow) > localDateKey(localCompleted)
	return afterCompletedLocalDay && localNow.hour >= 9
		? { due: true, reason: 'local-day-9am-due' }
		: { due: false, reason: 'local-day-9am-not-reached' }
}

function localParts(date: Date, timezone: string) {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(date)
		const part = (type: string) =>
			parts.find((item) => item.type === type)?.value
		return {
			year: Number(part('year')),
			month: Number(part('month')),
			day: Number(part('day')),
			hour: Number(part('hour')),
		}
	} catch {
		return undefined
	}
}

function localDateKey(parts: { year: number; month: number; day: number }) {
	return parts.year * 10000 + parts.month * 100 + parts.day
}
