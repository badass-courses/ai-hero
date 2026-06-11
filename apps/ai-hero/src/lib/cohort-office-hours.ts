import { formatInTimeZone } from 'date-fns-tz'
import { z } from 'zod'

export const CohortOfficeHoursSessionSchema = z.object({
	title: z.string().min(1),
	startsAt: z.string().datetime(),
	endsAt: z.string().datetime(),
	youtubeBroadcastId: z.string().min(1),
	youtubeWatchUrl: z.string().url(),
})

export const CohortOfficeHoursSessionsSchema = z
	.array(CohortOfficeHoursSessionSchema)
	.optional()

export type CohortOfficeHoursSession = z.infer<
	typeof CohortOfficeHoursSessionSchema
>

export type CohortOfficeHoursDayGroup = {
	dateKey: string
	label: string
	sessions: CohortOfficeHoursSession[]
}

const OFFICE_HOURS_DAY_LABELS = [
	'Opening Monday',
	'Second Monday',
	'Final Friday',
] as const

export function createYouTubeWatchUrl(broadcastId: string) {
	return `https://www.youtube.com/watch?v=${broadcastId}`
}

export function sortOfficeHoursSessions(
	sessions: CohortOfficeHoursSession[],
): CohortOfficeHoursSession[] {
	return [...sessions].sort(
		(a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
	)
}

export function groupOfficeHoursSessionsByUtcDate(
	sessions: CohortOfficeHoursSession[],
): CohortOfficeHoursDayGroup[] {
	const groupedSessions = new Map<string, CohortOfficeHoursSession[]>()

	for (const session of sortOfficeHoursSessions(sessions)) {
		const dateKey = session.startsAt.slice(0, 10)
		const existingSessions = groupedSessions.get(dateKey) || []
		existingSessions.push(session)
		groupedSessions.set(dateKey, existingSessions)
	}

	return Array.from(groupedSessions.entries()).map(
		([dateKey, sessionsForDate], index) => ({
			dateKey,
			label: OFFICE_HOURS_DAY_LABELS[index] || 'Office Hours',
			sessions: sortOfficeHoursSessions(sessionsForDate),
		}),
	)
}

export function formatOfficeHoursUtcDate(date: string) {
	return formatInTimeZone(new Date(date), 'UTC', 'EEEE, MMMM d, yyyy')
}

export function formatOfficeHoursUtcTimeRange(startAt: string, endsAt: string) {
	const start = formatInTimeZone(new Date(startAt), 'UTC', 'HH:mm')
	const end = formatInTimeZone(new Date(endsAt), 'UTC', 'HH:mm')

	return `${start} to ${end} UTC`
}

function formatGoogleCalendarDate(date: string) {
	return new Date(date)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '')
}

export function getOfficeHoursCalendarTitle(title: string) {
	return title.replace(
		/,\s+[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{2}:\d{2}\s+UTC$/,
		'',
	)
}

export function buildOfficeHoursGoogleCalendarDescription(
	session: CohortOfficeHoursSession,
) {
	const cohortName = getOfficeHoursCalendarTitle(session.title).replace(
		/ Office Hours$/,
		'',
	)

	return [
		`Live office hours for ${cohortName}.`,
		'Join live on YouTube to ask questions, get unstuck, and see the material in action.',
		'If you miss it, the replay and transcript will be available afterwards.',
		'',
		`Watch live: ${session.youtubeWatchUrl}`,
	].join('\n')
}

export function isOfficeHoursSessionPast(
	session: Pick<CohortOfficeHoursSession, 'endsAt'>,
	now: Date = new Date(),
) {
	return new Date(session.endsAt).getTime() <= now.getTime()
}

export function isOfficeHoursSessionLive(
	session: Pick<CohortOfficeHoursSession, 'startsAt' | 'endsAt'>,
	now: Date = new Date(),
) {
	const startsAt = new Date(session.startsAt).getTime()
	const endsAt = new Date(session.endsAt).getTime()
	const nowTime = now.getTime()

	return startsAt <= nowTime && nowTime < endsAt
}

export function buildOfficeHoursGoogleCalendarUrl(
	session: CohortOfficeHoursSession,
) {
	const params = new URLSearchParams({
		action: 'TEMPLATE',
		text: getOfficeHoursCalendarTitle(session.title),
		details: buildOfficeHoursGoogleCalendarDescription(session),
		dates: `${formatGoogleCalendarDate(session.startsAt)}/${formatGoogleCalendarDate(session.endsAt)}`,
		location: 'Online (YouTube Live)',
	})

	return `https://calendar.google.com/calendar/render?${params.toString()}`
}
