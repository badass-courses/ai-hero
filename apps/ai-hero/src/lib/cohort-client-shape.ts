import type { Cohort } from '@/lib/cohort'

/**
 * The cohort fields a `'use client'` component on the cohort page reads.
 * Anything passed to a client component is serialized into the page's RSC
 * payload, signed-out HTML included, so this is an allowlist: the nested
 * resource tree (workshops, lessons and their bodies) and every body field
 * stay on the server.
 */
const CLIENT_COHORT_FIELDS = [
	'title',
	'description',
	'slug',
	'state',
	'visibility',
	'startsAt',
	'endsAt',
	'timezone',
	'image',
] as const

export type ClientCohort = Cohort

/**
 * Shapes a cohort for client components. Keeps identity and the display
 * fields in `CLIENT_COHORT_FIELDS`; drops `resources` and all body fields.
 */
export function toClientCohort(cohort: Cohort): ClientCohort {
	const fields: Record<string, unknown> = {}
	for (const key of CLIENT_COHORT_FIELDS) {
		if (cohort.fields[key] !== undefined) fields[key] = cohort.fields[key]
	}
	return {
		id: cohort.id,
		type: cohort.type,
		fields,
		resources: [],
	} as unknown as ClientCohort
}
