'use server'

import { db } from '@/db'
import {
	entitlements,
	entitlementTypes,
	organizationMemberships,
	users,
} from '@/db/schema'
import { Email } from '@/lib/emails'
import { getEmail } from '@/lib/emails-query'
import { getProduct, getProducts } from '@/lib/products-query'
import { Workshop } from '@/lib/workshops'
import { log } from '@/server/logger'
import { formatInTimeZone } from 'date-fns-tz'
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

import type { Product } from '@coursebuilder/core/schemas'

// Define a simple user type for our email purposes
export type EmailUser = {
	id: string
	email: string
	name?: string | null
}

// Reuse existing queries with filters
export async function getCohortProducts(): Promise<Product[]> {
	const products = await getProducts()
	return products.filter((product) =>
		product.resources?.some((r) => r.resource?.type === 'cohort'),
	)
}

/**
 * A user paired with the subset of the requested workshops they are actually
 * entitled to. Used for batch emails so each recipient only sees their own
 * workshops.
 */
export type UserWorkshopEntitlements = {
	user: EmailUser
	workshopIds: string[]
}

/**
 * Resolves which of the given workshops each user is entitled to.
 *
 * Returns one entry per user holding an active `cohort_content_access`
 * entitlement that covers at least one of `workshopIds`. Each entry's
 * `workshopIds` is the subset of the requested workshops that user can
 * access — callers must not assume a user is entitled to every requested
 * workshop.
 */
export async function getUserWorkshopEntitlements(
	workshopIds: string[],
): Promise<UserWorkshopEntitlements[]> {
	if (workshopIds.length === 0) return []

	// Get the cohort content access entitlement type
	const cohortEntitlementType = await db.query.entitlementTypes.findFirst({
		where: eq(entitlementTypes.name, 'cohort_content_access'),
	})

	if (!cohortEntitlementType) {
		void log.warn('cohort.email.entitlement-type.not-found', {
			entitlementType: 'cohort_content_access',
			workshopCount: workshopIds.length,
		})
		return []
	}

	// Find all active entitlements of that type
	const activeEntitlements = await db.query.entitlements.findMany({
		where: and(
			eq(entitlements.entitlementType, cohortEntitlementType.id),
			or(
				isNull(entitlements.expiresAt),
				gt(entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
			),
			isNull(entitlements.deletedAt),
		),
	})

	const requestedWorkshopIds = new Set(workshopIds)

	// Map each org membership to the requested workshops its entitlements grant.
	const workshopIdsByMembership = new Map<string, Set<string>>()
	for (const entitlement of activeEntitlements) {
		const membershipId = entitlement.organizationMembershipId
		if (!membershipId) continue

		const contentIds: string[] = entitlement.metadata?.contentIds || []
		const grantedIds = contentIds.filter((id) => requestedWorkshopIds.has(id))
		if (grantedIds.length === 0) continue

		const membershipWorkshops =
			workshopIdsByMembership.get(membershipId) ?? new Set<string>()
		for (const id of grantedIds) membershipWorkshops.add(id)
		workshopIdsByMembership.set(membershipId, membershipWorkshops)
	}

	const membershipIds = [...workshopIdsByMembership.keys()]
	if (membershipIds.length === 0) return []

	// Resolve memberships to users
	const memberships = await db.query.organizationMemberships.findMany({
		where: inArray(organizationMemberships.id, membershipIds),
	})

	// A user may hold multiple memberships — union their workshop access.
	const workshopIdsByUser = new Map<string, Set<string>>()
	for (const membership of memberships) {
		const userId = membership.userId
		const membershipWorkshops = workshopIdsByMembership.get(membership.id)
		if (!userId || !membershipWorkshops) continue

		const userWorkshops = workshopIdsByUser.get(userId) ?? new Set<string>()
		for (const id of membershipWorkshops) userWorkshops.add(id)
		workshopIdsByUser.set(userId, userWorkshops)
	}

	const userIds = [...workshopIdsByUser.keys()]
	if (userIds.length === 0) return []

	// Get the actual user records
	const usersData = await db.query.users.findMany({
		where: inArray(users.id, userIds),
		columns: {
			id: true,
			email: true,
			name: true,
		},
	})

	return usersData.map((user) => ({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
		},
		workshopIds: [...(workshopIdsByUser.get(user.id) ?? [])],
	}))
}

/**
 * Returns every user entitled to at least one of the given workshops.
 *
 * This flattens away per-user entitlement detail. When sending content about
 * specific workshops, use {@link getUserWorkshopEntitlements} instead so each
 * user only receives the workshops they actually have access to.
 */
export async function getUsersEntitledToWorkshops(
	workshopIds: string[],
): Promise<EmailUser[]> {
	const userEntitlements = await getUserWorkshopEntitlements(workshopIds)
	return userEntitlements.map((entitlement) => entitlement.user)
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
