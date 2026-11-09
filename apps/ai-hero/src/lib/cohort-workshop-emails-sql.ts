import { entitlements } from '@/db/schema'
import { sql } from 'drizzle-orm'

/**
 * SQL condition: the entitlement's `metadata.contentIds` includes any of
 * `workshopIds`. Filtering in SQL keeps the workshop access email query under
 * PlanetScale's 100k-row read limit, which every cohort's entitlements together
 * passed on the C5 release day (2026-11-09).
 */
export function requestsAnyWorkshop(workshopIds: string[]) {
	return sql`JSON_OVERLAPS(JSON_EXTRACT(${entitlements.metadata}, '$.contentIds'), CAST(${JSON.stringify(workshopIds)} AS JSON))`
}
