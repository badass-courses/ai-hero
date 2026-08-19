import {
	OfficeHoursSchedule,
	type OfficeHoursScheduleProps,
} from '@/components/office-hours-schedule'
import { getCohortOfficeHoursSessionsForWorkshop } from '@/lib/cohort-office-hours-query'
import { log } from '@/server/logger'

type AuthorizedOfficeHoursScheduleProps = OfficeHoursScheduleProps & {
	cohortId?: string
	officeHoursWorkshopId?: string
}

/**
 * The lesson route includes `officeHoursWorkshopId` only when its request can
 * read the workshop. The data resolver repeats that request-bound check before
 * reading the cohort. Authored inline sessions still render as authored.
 */
export async function AuthorizedOfficeHoursSchedule({
	sessions: authoredSessions,
	cohortId,
	officeHoursWorkshopId,
	...displayProps
}: AuthorizedOfficeHoursScheduleProps) {
	if (authoredSessions) {
		return (
			<OfficeHoursSchedule sessions={authoredSessions} {...displayProps} />
		)
	}

	if (!cohortId || !officeHoursWorkshopId) return null

	let sessions
	try {
		sessions = await getCohortOfficeHoursSessionsForWorkshop({
			cohortId,
			workshopId: officeHoursWorkshopId,
		})
	} catch (error) {
		await log.warn('cohort.office-hours.resolve.failed', {
			cohortId,
			workshopId: officeHoursWorkshopId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}

	if (sessions.length === 0) return null

	return <OfficeHoursSchedule sessions={sessions} {...displayProps} />
}
