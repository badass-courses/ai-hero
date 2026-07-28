import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { courseBuilderAdapter, db } from '@/db'
import {
	coupon,
	organization,
	organizationMembershipRoles,
	organizationMemberships,
	products,
	purchases,
	roles,
	users,
	verificationTokens,
} from '@/db/schema'
import {
	acceptBillingAdminInvitations,
	inviteBillingAdmin,
	removeBillingAdmin,
	type TeamManagerInvitationDataSource,
} from '@/lib/team-manager-invitations'
import { drizzleTeamManagerInvitationDataSource } from '@/lib/team-manager-invitations-drizzle'
import { getTeamManagerOrganizationsForMember } from '@/lib/team-manager-directory'
import { getTeamPurchasesForMember } from '@/lib/team-purchases'
import { eq, inArray } from 'drizzle-orm'

import { guid } from '@coursebuilder/utils/guid'

const DEFAULT_RECEIPT_DIRECTORY =
	'/Users/joel/Code/badass-courses/aihero-support/.brain/data/crm/receipts'

function receiptPath(argv: string[]): string {
	const index = argv.indexOf('--receipt')
	if (index >= 0) {
		const value = argv[index + 1]
		if (!value || value.startsWith('--')) throw new Error('--receipt requires a path')
		return value
	}
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
	return `${DEFAULT_RECEIPT_DIRECTORY}/billing-admin-invite-synthetic-proof-${timestamp}.json`
}

async function run() {
	const argv = process.argv.slice(2)
	if (!argv.includes('--allow-write')) {
		throw new Error('Synthetic proof requires explicit --allow-write')
	}
	const outputPath = receiptPath(argv)
	const startedAt = new Date().toISOString()
	const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
	const ownerUserId = guid()
	const inviteeUserId = guid()
	const organizationId = guid()
	const ownerMembershipId = guid()
	const couponId = guid()
	const purchaseId = guid()
	const ownerEmail = `billing-admin-proof-owner-${suffix}@example.invalid`
	const inviteeEmail = `billing-admin-proof-invitee-${suffix}@example.invalid`
	let invitationEmailAttempted = false
	let invitationCreated = false
	let roleAttachedAtSignIn = false
	let invitedManagerSawSyntheticPurchase = false
	let invitedManagerSawSeatState = false
	let invitedManagerListedInDirectory = false
	let accessDroppedAfterRemoval = false
	let cleanupVerified = false
	let failure: string | null = null

	const proofDataSource: TeamManagerInvitationDataSource = {
		...drizzleTeamManagerInvitationDataSource,
		async sendInvitationEmail() {
			// Exercise the durable invite path without sending to a non-routable address.
			invitationEmailAttempted = true
		},
	}

	try {
		const product = await db.query.products.findFirst()
		if (!product) throw new Error('No product is available for the synthetic purchase')

		await db.insert(users).values([
			{
				id: ownerUserId,
				name: 'Synthetic Billing Owner',
				email: ownerEmail,
				emailVerified: new Date(),
				fields: { syntheticBillingAdminProof: true },
			},
			{
				id: inviteeUserId,
				name: 'Synthetic Billing Invitee',
				email: inviteeEmail,
				emailVerified: new Date(),
				fields: { syntheticBillingAdminProof: true },
			},
		])
		await db.insert(organization).values({
			id: organizationId,
			name: `Synthetic billing-admin proof ${suffix}`,
		})
		await db.insert(organizationMemberships).values({
			id: ownerMembershipId,
			organizationId,
			userId: ownerUserId,
			invitedById: ownerUserId,
			role: 'owner',
			fields: { syntheticBillingAdminProof: true },
		})
		await courseBuilderAdapter.addRoleForMember({
			organizationId,
			memberId: ownerMembershipId,
			role: 'owner',
		})
		await drizzleTeamManagerInvitationDataSource.ensureBillingAdminRole({
			id: ownerMembershipId,
			organizationId,
			userId: ownerUserId,
			email: ownerEmail,
			name: 'Synthetic Billing Owner',
			roles: ['owner'],
		})
		await db.insert(coupon).values({
			id: couponId,
			organizationId,
			code: `synthetic-billing-admin-proof-${suffix}`,
			fields: { syntheticBillingAdminProof: true },
			maxUses: 4,
			usedCount: 1,
			status: 1,
			restrictedToProductId: product.id,
		})
		await db.insert(purchases).values({
			id: purchaseId,
			userId: ownerUserId,
			organizationId,
			purchasedByorganizationMembershipId: ownerMembershipId,
			productId: product.id,
			bulkCouponId: couponId,
			totalAmount: '0',
			status: 'Valid',
			fields: { syntheticBillingAdminProof: true },
		})

		await inviteBillingAdmin(
			{ actorUserId: ownerUserId, organizationId, email: inviteeEmail },
			proofDataSource,
		)
		invitationCreated = (
			await proofDataSource.loadPendingInvitationsForEmail(inviteeEmail)
		).some((invitation) => invitation.organizationId === organizationId)

		const accepted = await acceptBillingAdminInvitations(
			{ userId: inviteeUserId, email: inviteeEmail },
			proofDataSource,
		)
		roleAttachedAtSignIn = accepted.acceptedOrganizationIds.includes(organizationId)

		const [visiblePurchases, managerOrganizations] = await Promise.all([
			getTeamPurchasesForMember(inviteeUserId),
			getTeamManagerOrganizationsForMember(inviteeUserId),
		])
		const visiblePurchase = visiblePurchases.find(({ id }) => id === purchaseId)
		invitedManagerSawSyntheticPurchase = Boolean(visiblePurchase)
		invitedManagerSawSeatState = Boolean(
			visiblePurchase?.bulkCoupon &&
				visiblePurchase.bulkCoupon.maxUses === 4 &&
				visiblePurchase.bulkCoupon.usedCount === 1,
		)
		invitedManagerListedInDirectory = Boolean(
			managerOrganizations
				.find(({ id }) => id === organizationId)
				?.managers.some(({ userId }) => userId === inviteeUserId),
		)

		const ownerSourceMembership =
			await proofDataSource.loadMembership(ownerUserId, organizationId)
		const inviteeMembership =
			await proofDataSource.loadMembership(inviteeUserId, organizationId)
		if (!ownerSourceMembership || !inviteeMembership) {
			throw new Error('Synthetic manager memberships were not created')
		}
		await removeBillingAdmin(
			{
				actorUserId: ownerUserId,
				organizationId,
				targetMembershipId: inviteeMembership.id,
			},
			proofDataSource,
		)
		const [purchasesAfterRemoval, organizationsAfterRemoval] = await Promise.all([
			getTeamPurchasesForMember(inviteeUserId),
			getTeamManagerOrganizationsForMember(inviteeUserId),
		])
		accessDroppedAfterRemoval =
			purchasesAfterRemoval.every(({ id }) => id !== purchaseId) &&
			organizationsAfterRemoval.every(({ id }) => id !== organizationId)

		if (
			![
				invitationEmailAttempted,
				invitationCreated,
				roleAttachedAtSignIn,
				invitedManagerSawSyntheticPurchase,
				invitedManagerSawSeatState,
				invitedManagerListedInDirectory,
				accessDroppedAfterRemoval,
			].every(Boolean)
		) {
			throw new Error('One or more synthetic billing-admin assertions failed')
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error)
	} finally {
		await db
			.delete(verificationTokens)
			.where(
				inArray(verificationTokens.identifier, [ownerEmail, inviteeEmail]),
			)
		await db.delete(purchases).where(eq(purchases.id, purchaseId))
		await db.delete(coupon).where(eq(coupon.id, couponId))
		await db
			.delete(organizationMembershipRoles)
			.where(eq(organizationMembershipRoles.organizationId, organizationId))
		await db.delete(roles).where(eq(roles.organizationId, organizationId))
		await db
			.delete(organizationMemberships)
			.where(eq(organizationMemberships.organizationId, organizationId))
		await db.delete(organization).where(eq(organization.id, organizationId))
		await db.delete(users).where(inArray(users.id, [ownerUserId, inviteeUserId]))

		const [remainingUsers, remainingOrganizations, remainingPurchases, remainingInvites] =
			await Promise.all([
				db.query.users.findMany({
					where: inArray(users.id, [ownerUserId, inviteeUserId]),
				}),
				db.query.organization.findMany({
					where: eq(organization.id, organizationId),
				}),
				db.query.purchases.findMany({ where: eq(purchases.id, purchaseId) }),
				db.query.verificationTokens.findMany({
					where: inArray(verificationTokens.identifier, [
						ownerEmail,
						inviteeEmail,
					]),
				}),
			])
		cleanupVerified =
			remainingUsers.length === 0 &&
			remainingOrganizations.length === 0 &&
			remainingPurchases.length === 0 &&
			remainingInvites.length === 0
	}

	const receipt = {
		version: 1,
		task: 'billing-admin-invite-and-team-surfaces-synthetic-proof',
		startedAt,
		completedAt: new Date().toISOString(),
		writesPerformed: true,
		scope: {
			syntheticAccounts: 2,
			syntheticOrganizations: 1,
			syntheticPurchases: 1,
			realCustomerOrganizationsTouched: 0,
		},
		assertions: {
			invitationEmailPathExercised: invitationEmailAttempted,
			invitationCreated,
			roleAttachedThroughSignInAcceptancePath: roleAttachedAtSignIn,
			invitedManagerSawSyntheticPurchase,
			invitedManagerSawSeatState,
			invitedManagerListedInDirectory,
			accessDroppedAfterRemoval,
			cleanupVerified,
		},
		failure,
		notes: [
			'Aggregate-only receipt; synthetic identifiers and emails are omitted.',
			'The production email adapter path is covered by code and tests; the proof intercepted delivery because example.invalid is intentionally non-routable.',
			'The sign-in callback calls the same acceptance function exercised here.',
		],
	}
	mkdirSync(dirname(outputPath), { recursive: true })
	writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`)
	console.log(JSON.stringify({ receiptPath: outputPath, ...receipt }, null, 2))

	if (failure || !cleanupVerified) process.exitCode = 1
}

run().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
