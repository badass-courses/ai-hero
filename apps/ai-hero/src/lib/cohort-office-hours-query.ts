import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { getAbilityForResource } from '@/utils/get-current-ability-rules'
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
 * Reads only the office-hours session field after two independent checks:
 * the current request can read the protected workshop, and the active cohort
 * relation directly contains that workshop. A free lesson is not enough.
 */
export async function getCohortOfficeHoursSessionsForWorkshop({
	cohortId,
	workshopId,
}: {
	cohortId: string
	workshopId: string
}): Promise<CohortOfficeHoursSession[]> {
	const { canViewWorkshop } = await getAbilityForResource(undefined, workshopId)
	if (!canViewWorkshop) return []

	const rows = await db
		.select({
			sessions: sql<unknown>`JSON_EXTRACT(${contentResource.fields}, '$.officeHoursSessions')`,
		})
		.from(contentResource)
		.innerJoin(
			contentResourceResource,
			and(
				eq(contentResourceResource.resourceOfId, contentResource.id),
				eq(contentResourceResource.resourceId, workshopId),
				isNull(contentResourceResource.deletedAt),
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
