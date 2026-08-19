import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { and, eq, isNull, or, sql } from 'drizzle-orm'

import {
	CohortOfficeHoursSessionsSchema,
	type CohortOfficeHoursSession,
} from './cohort-office-hours'

function parseOfficeHoursSessions(value: unknown): CohortOfficeHoursSession[] {
	let candidate = value

	if (typeof value === 'string') {
		try {
			candidate = JSON.parse(value)
		} catch {
			return []
		}
	}

	const parsed = CohortOfficeHoursSessionsSchema.safeParse(candidate)
	return parsed.success ? (parsed.data ?? []) : []
}

/**
 * Reads only the office-hours session field after proving the requested cohort
 * directly contains the workshop that the lesson route already authorized.
 */
export async function getCohortOfficeHoursSessionsForWorkshop({
	cohortId,
	authorizedWorkshopId,
}: {
	cohortId: string
	authorizedWorkshopId: string
}): Promise<CohortOfficeHoursSession[]> {
	const rows = await db
		.select({
			sessions: sql<unknown>`JSON_EXTRACT(${contentResource.fields}, '$.officeHoursSessions')`,
		})
		.from(contentResource)
		.innerJoin(
			contentResourceResource,
			and(
				eq(contentResourceResource.resourceOfId, contentResource.id),
				eq(contentResourceResource.resourceId, authorizedWorkshopId),
			),
		)
		.where(
			and(
				eq(contentResource.type, 'cohort'),
				isNull(contentResource.deletedAt),
				or(eq(contentResource.id, cohortId), eq(contentResource.slug, cohortId)),
			),
		)
		.limit(1)

	return parseOfficeHoursSessions(rows[0]?.sessions)
}
