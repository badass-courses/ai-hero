'use server'

import { Email } from '@/lib/emails'
import { getEmail } from '@/lib/emails-query'
import { getProduct, getProducts } from '@/lib/products-query'
import { Workshop } from '@/lib/workshops'
import { log } from '@/server/logger'
import { formatInTimeZone } from 'date-fns-tz'

import type { Product } from '@coursebuilder/core/schemas'

// Reuse existing queries with filters
export async function getCohortProducts(): Promise<Product[]> {
	const products = await getProducts()
	return products.filter((product) =>
		product.resources?.some((r) => r.resource?.type === 'cohort'),
	)
}

/**
 * Filters workshops starting on the same UTC calendar date as the cron run.
 *
 * This is designed for a cron running at midnight UTC that needs to find workshops
 * starting on the same UTC calendar date.
 *
 * Example: Cron runs 2025-07-23T00:00:00Z (midnight UTC July 23rd)
 * → Finds workshops starting on July 23rd UTC (regardless of timezone)
 *
 * @param mockDate - When provided, uses this date instead of current time for testing.
 */
export async function getWorkshopsStartingToday(
	workshops: Workshop[],
	mockDate?: Date | string,
): Promise<Workshop[]> {
	// Use provided mock date or current time
	const now = mockDate ? new Date(mockDate) : new Date()

	// Get the UTC date (what matters for cron scheduling)
	const utcDate = formatInTimeZone(now, 'UTC', 'yyyy-MM-dd')

	// This is the target date we want to find workshops for (same as UTC date)
	const targetDate = utcDate

	await log.info('cohort.email.workshop.search.debug', {
		targetDate,
		utcDate,
		mockDate: mockDate?.toString(),
		currentRealTime: new Date().toISOString(),
		timeUsedForCalculation: now.toISOString(),
		explanation: `Looking for workshops starting on UTC date ${targetDate}`,
	})

	// Log each workshop check
	for (const workshop of workshops) {
		if (!workshop.fields.startsAt) continue

		// Compare UTC dates consistently - workshop start date in UTC
		const workshopDateUTC = formatInTimeZone(
			new Date(workshop.fields.startsAt),
			'UTC',
			'yyyy-MM-dd',
		)

		const matches = workshopDateUTC === targetDate

		await log.info('cohort.email.workshop.date-check', {
			workshopId: workshop.id,
			workshopStartsAt: workshop.fields.startsAt,
			workshopDateUTC,
			targetDate,
			matches,
		})
	}

	// Filter workshops - compare UTC dates consistently
	const filteredWorkshops = workshops.filter((workshop) => {
		if (!workshop.fields.startsAt) return false

		// Compare UTC dates consistently - workshop start date in UTC
		const workshopDateUTC = formatInTimeZone(
			new Date(workshop.fields.startsAt),
			'UTC',
			'yyyy-MM-dd',
		)

		return workshopDateUTC === targetDate
	})

	await log.info('cohort.email.workshop.filter.complete', {
		totalWorkshops: workshops.length,
		filteredCount: filteredWorkshops.length,
	})

	return filteredWorkshops
}

export async function getWorkshopEmails(workshop: Workshop): Promise<Email[]> {
	const emailResources =
		workshop.resources?.filter((r) => r.resource.type === 'email') || []

	const emails = await Promise.all(
		emailResources.map((r) => getEmail(r.resourceId)),
	)

	return emails.filter(Boolean) as Email[]
}
