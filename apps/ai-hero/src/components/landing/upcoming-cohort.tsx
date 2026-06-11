import * as React from 'react'
import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { log } from '@/server/logger'
import { and, eq, sql } from 'drizzle-orm'

import { Resource } from './resource'

function readString(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'string' && v.length > 0 ? v : undefined
}

export async function UpcomingCohort() {
	const now = new Date().toISOString()

	const cohorts = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'cohort'),
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, 'published'),
			eq(
				sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`,
				'public',
			),
		),
		with: {
			resourceProducts: { with: { product: true } },
		},
	})

	const purchasable = cohorts.filter((cohort) => {
		const product = cohort.resourceProducts?.[0]?.product
		if (!product) return false
		if (product.status !== 1) return false
		const productState = readString(product.fields, 'state')
		if (productState && productState !== 'published') return false
		const openEnrollment = readString(product.fields, 'openEnrollment')
		const closeEnrollment = readString(product.fields, 'closeEnrollment')
		if (openEnrollment && openEnrollment > now) return false
		if (closeEnrollment && closeEnrollment < now) return false
		return true
	})

	purchasable.sort((a, b) => {
		const aStart = readString(a.fields, 'startsAt') ?? ''
		const bStart = readString(b.fields, 'startsAt') ?? ''
		return aStart.localeCompare(bStart)
	})

	const winner = purchasable[0]
	if (!winner) {
		await log.info('landing.upcomingCohort.noMatch', {
			candidateCount: cohorts.length,
		})
		return null
	}

	const slug = readString(winner.fields, 'slug') ?? winner.id
	return <Resource slugOrId={slug} />
}
