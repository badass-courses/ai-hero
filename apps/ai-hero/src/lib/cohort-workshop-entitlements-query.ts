import 'server-only'

import { db } from '@/db'
import {
	entitlements,
	entitlementTypes,
	organizationMemberships,
	users,
} from '@/db/schema'
import { requestsAnyWorkshop } from '@/lib/cohort-workshop-emails-sql'
import { log } from '@/server/logger'
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

// Define a simple user type for our email purposes
export type EmailUser = {
	id: string
	email: string
	name?: string | null
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

	// Find active entitlements of that type that grant a requested workshop.
	// Filtering contentIds in SQL keeps this under PlanetScale's 100k-row read
	// limit: every cohort's entitlements together exceeded it on the C5 release
	// day (2026-11-09), and the whole group's emails failed.
	const activeEntitlements = await db.query.entitlements.findMany({
		where: and(
			eq(entitlements.entitlementType, cohortEntitlementType.id),
			or(
				isNull(entitlements.expiresAt),
				gt(entitlements.expiresAt, sql`CURRENT_TIMESTAMP`),
			),
			isNull(entitlements.deletedAt),
			requestsAnyWorkshop(workshopIds),
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
