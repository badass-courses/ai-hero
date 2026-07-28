import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { courseBuilderAdapter, db } from '@/db'
import {
	coupon,
	organizationMembershipRoles,
	organizationMemberships,
	purchases,
	roles,
} from '@/db/schema'
import { getPersonalOrgName } from '@/lib/personal-organization-service'
import { BILLING_ADMIN_ROLE } from '@/lib/team-roles'
import { and, asc, eq, isNotNull } from 'drizzle-orm'

const DEFAULT_RECEIPT_DIRECTORY =
	'/Users/joel/Code/badass-courses/aihero-support/.brain/data/crm/receipts'

type Mode = 'dry-run' | 'allow-write'

type MembershipRecord = {
	id: string
	organizationId: string
	organization: {
		id: string
		name: string | null
	}
	organizationMembershipRoles: {
		active: boolean
		deletedAt: Date | null
		role: {
			active: boolean
			deletedAt: Date | null
			name: string
		}
	}[]
}

type BulkPurchaseRecord = {
	id: string
	userId: string | null
	organizationId: string | null
	purchasedByorganizationMembershipId: string | null
	bulkCouponId: string | null
	user: {
		id: string
		email: string | null
	} | null
	bulkCoupon: {
		id: string
		organizationId: string | null
	} | null
}

type AggregateReceipt = {
	version: 1
	task: 'billing-admin-role-and-organization-backfill'
	mode: Mode
	startedAt: string
	completedAt: string
	counts: {
		bulkPurchases: number
		purchasers: number
		organizationsReferenced: number
		alreadyFullyLinked: number
		organizationsCreatedOrPlanned: number
		membershipsCreatedOrPlanned: number
		ownerRolesAddedOrPlanned: number
		billingAdminRolesAddedOrPlanned: number
		purchaseOrganizationsLinkedOrPlanned: number
		purchaseMembershipsLinkedOrPlanned: number
		couponOrganizationsLinkedOrPlanned: number
		unresolvedPurchases: number
		writeErrors: number
	}
	writesPerformed: boolean
	unresolvedReasons: Record<string, number>
	notes: string[]
}

type ActionSets = {
	organizations: Set<string>
	memberships: Set<string>
	ownerRoles: Set<string>
	billingAdminRoles: Set<string>
	purchaseOrganizations: Set<string>
	purchaseMemberships: Set<string>
	couponOrganizations: Set<string>
	alreadyFullyLinked: Set<string>
	organizationsReferenced: Set<string>
	purchasers: Set<string>
}

function parseArgs(argv: string[]): { mode: Mode; receiptPath: string } {
	const allowWrite = argv.includes('--allow-write')
	const dryRun = argv.includes('--dry-run')
	if (allowWrite && dryRun) {
		throw new Error('Choose either --dry-run or --allow-write, not both')
	}

	const mode: Mode = allowWrite ? 'allow-write' : 'dry-run'
	const receiptFlagIndex = argv.indexOf('--receipt')
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
	const receiptPath =
		receiptFlagIndex >= 0
			? argv[receiptFlagIndex + 1]
			: `${DEFAULT_RECEIPT_DIRECTORY}/billing-admin-backfill-${mode}-${timestamp}.json`

	if (!receiptPath || receiptPath.startsWith('--')) {
		throw new Error('--receipt requires a path')
	}

	return { mode, receiptPath }
}

function incrementReason(reasons: Record<string, number>, reason: string) {
	reasons[reason] = (reasons[reason] ?? 0) + 1
}

function hasActiveRole(membership: MembershipRecord, roleName: string): boolean {
	return membership.organizationMembershipRoles.some(
		(membershipRole) =>
			membershipRole.active &&
			!membershipRole.deletedAt &&
			membershipRole.role.active &&
			!membershipRole.role.deletedAt &&
			membershipRole.role.name === roleName,
	)
}

async function loadMembershipsForUser(
	userId: string,
): Promise<MembershipRecord[]> {
	const rows = await db.query.organizationMemberships.findMany({
		where: eq(organizationMemberships.userId, userId),
		with: {
			organization: true,
			organizationMembershipRoles: {
				with: {
					role: true,
				},
			},
		},
	})

	return rows.flatMap((membership) =>
		membership.organizationId && membership.organization
			? [
					{
						id: membership.id,
						organizationId: membership.organizationId,
						organization: {
							id: membership.organization.id,
							name: membership.organization.name,
						},
						organizationMembershipRoles:
							membership.organizationMembershipRoles.map(
								(membershipRole) => ({
									active: membershipRole.active,
									deletedAt: membershipRole.deletedAt,
									role: {
										active: membershipRole.role.active,
										deletedAt: membershipRole.role.deletedAt,
										name: membershipRole.role.name,
									},
								}),
							),
					},
				]
			: [],
	)
}

async function ensureActiveRole(
	membership: MembershipRecord,
	roleName: string,
): Promise<void> {
	await courseBuilderAdapter.addRoleForMember({
		organizationId: membership.organizationId,
		memberId: membership.id,
		role: roleName,
	})

	const role = await db.query.roles.findFirst({
		where: and(
			eq(roles.organizationId, membership.organizationId),
			eq(roles.name, roleName),
		),
	})
	if (!role) throw new Error(`Role ${roleName} was not created`)

	await db
		.update(roles)
		.set({ active: true, deletedAt: null })
		.where(eq(roles.id, role.id))
	await db
		.update(organizationMembershipRoles)
		.set({ active: true, deletedAt: null, organizationId: membership.organizationId })
		.where(
			and(
				eq(
					organizationMembershipRoles.organizationMembershipId,
					membership.id,
				),
				eq(organizationMembershipRoles.roleId, role.id),
			),
		)

	membership.organizationMembershipRoles.push({
		active: true,
		deletedAt: null,
		role: {
			active: true,
			deletedAt: null,
			name: roleName,
		},
	})
}

async function createPersonalMembership(user: {
	id: string
	email: string
}): Promise<MembershipRecord> {
	const organization = await courseBuilderAdapter.createOrganization({
		name: getPersonalOrgName(user.email),
	})
	if (!organization) throw new Error('organization-create-failed')

	const membership = await courseBuilderAdapter.addMemberToOrganization({
		organizationId: organization.id,
		userId: user.id,
		invitedById: user.id,
	})
	if (!membership) throw new Error('membership-create-failed')

	return {
		id: membership.id,
		organizationId: organization.id,
		organization: {
			id: organization.id,
			name: organization.name ?? null,
		},
		organizationMembershipRoles: [],
	}
}

async function loadBulkPurchases(): Promise<BulkPurchaseRecord[]> {
	const rows = await db.query.purchases.findMany({
		where: isNotNull(purchases.bulkCouponId),
		with: {
			user: true,
			bulkCoupon: true,
		},
		orderBy: asc(purchases.createdAt),
	})

	return rows.map((purchase) => ({
		id: purchase.id,
		userId: purchase.userId,
		organizationId: purchase.organizationId,
		purchasedByorganizationMembershipId:
			purchase.purchasedByorganizationMembershipId,
		bulkCouponId: purchase.bulkCouponId,
		user: purchase.user
			? {
					id: purchase.user.id,
					email: purchase.user.email,
				}
			: null,
		bulkCoupon: purchase.bulkCoupon
			? {
					id: purchase.bulkCoupon.id,
					organizationId: purchase.bulkCoupon.organizationId,
				}
			: null,
	}))
}

async function run() {
	const { mode, receiptPath } = parseArgs(process.argv.slice(2))
	const allowWrite = mode === 'allow-write'
	const startedAt = new Date().toISOString()
	const bulkPurchases = await loadBulkPurchases()
	const membershipsByUser = new Map<string, MembershipRecord[]>()
	const actions: ActionSets = {
		organizations: new Set(),
		memberships: new Set(),
		ownerRoles: new Set(),
		billingAdminRoles: new Set(),
		purchaseOrganizations: new Set(),
		purchaseMemberships: new Set(),
		couponOrganizations: new Set(),
		alreadyFullyLinked: new Set(),
		organizationsReferenced: new Set(),
		purchasers: new Set(),
	}
	const unresolvedReasons: Record<string, number> = {}
	let writeErrors = 0

	for (const purchase of bulkPurchases) {
		if (!purchase.userId || !purchase.user?.email) {
			incrementReason(unresolvedReasons, 'missing-purchaser-or-email')
			continue
		}
		if (!purchase.bulkCouponId || !purchase.bulkCoupon) {
			incrementReason(unresolvedReasons, 'missing-bulk-coupon')
			continue
		}

		actions.purchasers.add(purchase.userId)
		let memberships = membershipsByUser.get(purchase.userId)
		if (!memberships) {
			memberships = await loadMembershipsForUser(purchase.userId)
			membershipsByUser.set(purchase.userId, memberships)
		}

		if (
			purchase.organizationId &&
			purchase.bulkCoupon.organizationId &&
			purchase.organizationId !== purchase.bulkCoupon.organizationId
		) {
			incrementReason(unresolvedReasons, 'purchase-coupon-organization-conflict')
			continue
		}

		const existingOrganizationId =
			purchase.organizationId ?? purchase.bulkCoupon.organizationId
		let membership = existingOrganizationId
			? memberships.find(
					(candidate) =>
						candidate.organizationId === existingOrganizationId,
				)
			: undefined
		let targetKey = existingOrganizationId ?? `new:${purchase.userId}`

		if (!existingOrganizationId) {
			const personalOrganizationName = getPersonalOrgName(purchase.user.email)
			membership =
				memberships.find(
					(candidate) =>
						candidate.organization.name === personalOrganizationName,
				) ?? (memberships.length === 1 ? memberships[0] : undefined)

			if (!membership && memberships.length > 1) {
				incrementReason(unresolvedReasons, 'ambiguous-purchaser-organizations')
				continue
			}

			if (!membership) {
				actions.organizations.add(targetKey)
				actions.memberships.add(`${targetKey}:${purchase.userId}`)
				if (allowWrite) {
					try {
						membership = await createPersonalMembership({
							id: purchase.userId,
							email: purchase.user.email,
						})
						memberships.push(membership)
						targetKey = membership.organizationId
					} catch {
						writeErrors += 1
						incrementReason(unresolvedReasons, 'organization-or-membership-write-failed')
						continue
					}
				}
			}
		}

		if (existingOrganizationId && !membership) {
			actions.memberships.add(`${existingOrganizationId}:${purchase.userId}`)
			if (allowWrite) {
				try {
					const createdMembership =
						await courseBuilderAdapter.addMemberToOrganization({
							organizationId: existingOrganizationId,
							userId: purchase.userId,
							invitedById: purchase.userId,
						})
					if (!createdMembership) throw new Error('membership-create-failed')
					membership = {
						id: createdMembership.id,
						organizationId: existingOrganizationId,
						organization: {
							id: existingOrganizationId,
							name: null,
						},
						organizationMembershipRoles: [],
					}
					memberships.push(membership)
				} catch {
					writeErrors += 1
					incrementReason(unresolvedReasons, 'membership-write-failed')
					continue
				}
			}
		}

		const targetOrganizationId = membership?.organizationId
		const membershipKey = membership
			? `${membership.organizationId}:${membership.id}`
			: `${targetKey}:${purchase.userId}`
		if (targetOrganizationId) {
			actions.organizationsReferenced.add(targetOrganizationId)
		}

		if (!membership || !hasActiveRole(membership, 'owner')) {
			actions.ownerRoles.add(membershipKey)
			if (allowWrite && membership) {
				try {
					await ensureActiveRole(membership, 'owner')
				} catch {
					writeErrors += 1
					incrementReason(unresolvedReasons, 'owner-role-write-failed')
					continue
				}
			}
		}

		if (!membership || !hasActiveRole(membership, BILLING_ADMIN_ROLE)) {
			actions.billingAdminRoles.add(membershipKey)
			if (allowWrite && membership) {
				try {
					await ensureActiveRole(membership, BILLING_ADMIN_ROLE)
				} catch {
					writeErrors += 1
					incrementReason(unresolvedReasons, 'billing-admin-role-write-failed')
					continue
				}
			}
		}

		if (!targetOrganizationId || !membership) {
			if (!allowWrite) {
				actions.purchaseOrganizations.add(purchase.id)
				actions.purchaseMemberships.add(purchase.id)
				actions.couponOrganizations.add(purchase.bulkCoupon.id)
			}
			continue
		}

		const purchaseNeedsOrganization =
			purchase.organizationId !== targetOrganizationId
		const purchaseNeedsMembership =
			purchase.purchasedByorganizationMembershipId !== membership.id
		const couponNeedsOrganization =
			purchase.bulkCoupon.organizationId !== targetOrganizationId

		if (purchaseNeedsOrganization) actions.purchaseOrganizations.add(purchase.id)
		if (purchaseNeedsMembership) actions.purchaseMemberships.add(purchase.id)
		if (couponNeedsOrganization)
			actions.couponOrganizations.add(purchase.bulkCoupon.id)

		if (allowWrite) {
			try {
				if (purchaseNeedsOrganization || purchaseNeedsMembership) {
					await db
						.update(purchases)
						.set({
							organizationId: targetOrganizationId,
							purchasedByorganizationMembershipId: membership.id,
						})
						.where(eq(purchases.id, purchase.id))
				}
				if (couponNeedsOrganization) {
					await db
						.update(coupon)
						.set({ organizationId: targetOrganizationId })
						.where(eq(coupon.id, purchase.bulkCoupon.id))
				}
			} catch {
				writeErrors += 1
				incrementReason(unresolvedReasons, 'purchase-or-coupon-link-write-failed')
				continue
			}
		}

		if (
			!purchaseNeedsOrganization &&
			!purchaseNeedsMembership &&
			!couponNeedsOrganization &&
			hasActiveRole(membership, 'owner') &&
			hasActiveRole(membership, BILLING_ADMIN_ROLE)
		) {
			actions.alreadyFullyLinked.add(purchase.id)
		}
	}

	const unresolvedPurchases = Object.values(unresolvedReasons).reduce(
		(total, count) => total + count,
		0,
	)
	const receipt: AggregateReceipt = {
		version: 1,
		task: 'billing-admin-role-and-organization-backfill',
		mode,
		startedAt,
		completedAt: new Date().toISOString(),
		counts: {
			bulkPurchases: bulkPurchases.length,
			purchasers: actions.purchasers.size,
			organizationsReferenced: actions.organizationsReferenced.size,
			alreadyFullyLinked: actions.alreadyFullyLinked.size,
			organizationsCreatedOrPlanned: actions.organizations.size,
			membershipsCreatedOrPlanned: actions.memberships.size,
			ownerRolesAddedOrPlanned: actions.ownerRoles.size,
			billingAdminRolesAddedOrPlanned: actions.billingAdminRoles.size,
			purchaseOrganizationsLinkedOrPlanned:
				actions.purchaseOrganizations.size,
			purchaseMembershipsLinkedOrPlanned: actions.purchaseMemberships.size,
			couponOrganizationsLinkedOrPlanned: actions.couponOrganizations.size,
			unresolvedPurchases,
			writeErrors,
		},
		writesPerformed: allowWrite,
		unresolvedReasons,
		notes: [
			'Aggregate receipt only; purchase, user, coupon, and organization identifiers are omitted.',
			'The owner role remains an implicit billing-admin grant; the explicit billing_admin role is also backfilled for first-admin discoverability.',
			'Bulk coupon maxUses and usedCount are not changed.',
		],
	}

	mkdirSync(dirname(receiptPath), { recursive: true })
	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
	console.log(JSON.stringify({ receiptPath, ...receipt }, null, 2))

	if (unresolvedPurchases > 0 || writeErrors > 0) process.exitCode = 1
}

run().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
