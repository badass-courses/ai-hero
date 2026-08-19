import {
	OfficeHoursSchedule,
	type OfficeHoursScheduleProps,
} from '@/components/office-hours-schedule'
import { getCohortOfficeHoursSessionsForWorkshop } from '@/lib/cohort-office-hours-query'
import { log } from '@/server/logger'

type AuthorizedOfficeHoursScheduleProps = OfficeHoursScheduleProps & {
	cohortId?: string
	authorizedWorkshopId?: string
}

/**
 * The lesson route injects `authorizedWorkshopId` only after its purchaser
 * ability check. Authored inline sessions still render as authored; a cohortId
 * lookup without that server-only proof renders nothing.
 */
export async function AuthorizedOfficeHoursSchedule({
	sessions: authoredSessions,
	cohortId,
	authorizedWorkshopId,
	...displayProps
}: AuthorizedOfficeHoursScheduleProps) {
	if (authoredSessions) {
		return (
			<OfficeHoursSchedule sessions={authoredSessions} {...displayProps} />
		)
	}

	if (!cohortId || !authorizedWorkshopId) return null

	let sessions
	try {
		sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId,
			authorizedWorkshopId,
		})
	} catch (error) {
		await log.warn('cohort.office-hours.resolve.failed', {
			cohortId,
			authorizedWorkshopId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}

	if (sessions.length === 0) return null

	return <OfficeHoursSchedule sessions={sessions} {...displayProps} />
}
