import * as React from 'react'
import { getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { log } from '@/server/logger'

import { Resource } from './resource'

export async function UpcomingCohort() {
	const cohort = await getUpcomingCohort()
	if (!cohort) {
		await log.info('landing.upcomingCohort.noMatch', {})
		return null
	}
	return <Resource slugOrId={cohort.slug} />
}
