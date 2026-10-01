import { createHash, randomUUID } from 'node:crypto'

import { db, type DbExecutor } from '@/db'
import {
	coupon,
	organization,
	organizationMembershipRoles,
	organizationMemberships,
	purchases,
	roles,
	users,
} from '@/db/schema'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

import { getPersonalOrganizationName } from '@coursebuilder/organizations'

export type MemberlessRepairSnapshot = {
	purchase:
		| (Record<string, unknown> & {
				id: string
				userId: string | null
				bulkCouponId: string | null
				status: string
				organizationId: string | null
				purchasedByorganizationMembershipId: string | null
		  })
		| null
	coupon:
		| (Record<string, unknown> & {
				id: string
				organizationId: string | null
				status: number
				maxUses: number | null
				usedCount: number | null
		  })
		| null
	buyer: { id: string; email: string | null } | null
	memberships: Record<string, unknown>[]
	personalOrganization: Record<string, unknown> | null
	siblingCount: number
}

const id = z.string().min(1).max(191)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const planSchema = z
	.object({
		version: z.literal(1),
		purchaseId: id,
		buyerId: id,
		couponId: id,
		organizationId: id,
		membershipId: id,
		ownerRoleId: id,
		maxUses: z.number().int().positive(),
		usedCount: z.number().int().nonnegative(),
		expectedStateHash: hash,
		approvalHash: hash,
		createdAt: z.iso.datetime(),
	})
	.strict()
export type MemberlessRepairPlan = z.infer<typeof planSchema>
export type MemberlessRepairDataSource = {
	loadSnapshot(purchaseId: string): Promise<MemberlessRepairSnapshot>
	commit(
		plan: MemberlessRepairPlan,
	): Promise<{ status: 'repaired' | 'already-repaired' }>
}

function stable(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString()
	if (Array.isArray(value)) return value.map(stable)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, stable(item)]),
		)
	}
	return value
}
function digest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(stable(value)))
		.digest('hex')
}
function approvalHash(
	plan: Omit<MemberlessRepairPlan, 'approvalHash'>,
): string {
	return digest(plan)
}

function holdReason(s: MemberlessRepairSnapshot): string | null {
	if (!s.purchase || !s.coupon || !s.buyer?.email)
		return 'purchase-coupon-or-buyer-missing'
	if (
		s.purchase.userId !== s.buyer.id ||
		s.purchase.bulkCouponId !== s.coupon.id
	)
		return 'ownership-conflict'
	// Restricted purchases retain their country restrictions. This narrow repair
	// does not create manager authority for them or change their status.
	if (s.purchase.status !== 'Valid' || s.coupon.status !== 1)
		return 'not-an-active-valid-pool'
	if (
		s.purchase.organizationId ||
		s.purchase.purchasedByorganizationMembershipId ||
		s.coupon.organizationId
	)
		return 'already-linked-or-conflicting'
	if (s.memberships.length || s.personalOrganization)
		return 'existing-organization-governance'
	// No guessing which add-seat purchase or buyer owns a shared canonical pool.
	if (s.siblingCount !== 0) return 'shared-or-add-seat-pool'
	if (
		!Number.isInteger(s.coupon.maxUses) ||
		!Number.isInteger(s.coupon.usedCount) ||
		s.coupon.maxUses! < 1 ||
		s.coupon.usedCount! < 0 ||
		s.coupon.usedCount! > s.coupon.maxUses!
	)
		return 'invalid-capacity'
	return null
}

export async function previewMemberlessTeamPurchaseRepair(
	purchaseId: string,
	source: MemberlessRepairDataSource = createMemberlessRepairDataSource(db),
): Promise<
	| {
			status: 'ready'
			plan: MemberlessRepairPlan
			expected: MemberlessRepairSnapshot
	  }
	| { status: 'held'; reason: string }
> {
	id.parse(purchaseId)
	const snapshot = await source.loadSnapshot(purchaseId)
	const reason = holdReason(snapshot)
	if (reason) return { status: 'held', reason }
	const unsigned = {
		version: 1 as const,
		purchaseId,
		buyerId: snapshot.buyer!.id,
		couponId: snapshot.coupon!.id,
		organizationId: `org_${randomUUID()}`,
		membershipId: `membership_${randomUUID()}`,
		ownerRoleId: `role_${randomUUID()}`,
		maxUses: snapshot.coupon!.maxUses!,
		usedCount: snapshot.coupon!.usedCount!,
		expectedStateHash: digest(snapshot),
		createdAt: new Date().toISOString(),
	}
	return {
		status: 'ready',
		plan: { ...unsigned, approvalHash: approvalHash(unsigned) },
		expected: snapshot,
	}
}

const repairedMember = z.object({
	id,
	userId: id,
	organizationId: id,
	invitedById: id,
	personalOrganizationUserId: id,
	organizationMembershipRoles: z
		.array(
			z.object({
				roleId: id,
				active: z.literal(true),
				deletedAt: z.null(),
				organizationId: id,
				role: z.object({
					id,
					name: z.literal('owner'),
					active: z.literal(true),
					deletedAt: z.null(),
					organizationId: id,
				}),
			}),
		)
		.length(1),
})

export function matchesMemberlessRepairReadback(
	s: MemberlessRepairSnapshot,
	plan: MemberlessRepairPlan,
): boolean {
	const member = repairedMember.safeParse(s.memberships[0])
	if (s.memberships.length !== 1 || !member.success || !s.purchase || !s.coupon)
		return false
	const m = member.data
	const grant = m.organizationMembershipRoles[0]!
	if (
		s.purchase.id !== plan.purchaseId ||
		s.purchase.userId !== plan.buyerId ||
		s.purchase.bulkCouponId !== plan.couponId ||
		s.purchase.organizationId !== plan.organizationId ||
		s.purchase.purchasedByorganizationMembershipId !== plan.membershipId ||
		s.coupon.id !== plan.couponId ||
		s.coupon.organizationId !== plan.organizationId ||
		s.personalOrganization?.id !== plan.organizationId ||
		s.personalOrganization.personalOrganizationUserId !== plan.buyerId ||
		m.id !== plan.membershipId ||
		m.userId !== plan.buyerId ||
		m.organizationId !== plan.organizationId ||
		m.invitedById !== plan.buyerId ||
		m.personalOrganizationUserId !== plan.buyerId ||
		grant.roleId !== plan.ownerRoleId ||
		grant.organizationId !== plan.organizationId ||
		grant.role.id !== plan.ownerRoleId ||
		grant.role.organizationId !== plan.organizationId
	)
		return false
	// Assert ALL original purchase/coupon fields, including country, charge,
	// product, status, price, capacity and usage. Only three links may change.
	return (
		digest({
			...s,
			purchase: {
				...s.purchase,
				organizationId: null,
				purchasedByorganizationMembershipId: null,
			},
			coupon: { ...s.coupon, organizationId: null },
			memberships: [],
			personalOrganization: null,
		}) === plan.expectedStateHash
	)
}

export async function applyMemberlessTeamPurchaseRepair(
	input: unknown,
	approval: {
		allowWrite: boolean
		confirmCount: number
		purchaseId: string
		approvedPlanHash: string
	},
	source: MemberlessRepairDataSource = createMemberlessRepairDataSource(db),
) {
	const plan = planSchema.parse(input)
	const { approvalHash: suppliedHash, ...unsigned } = plan
	if (
		!approval.allowWrite ||
		approval.confirmCount !== 1 ||
		approval.purchaseId !== plan.purchaseId ||
		approval.approvedPlanHash !== suppliedHash ||
		approvalHash(unsigned) !== suppliedHash
	)
		throw new Error('Exact one-purchase plan approval is required')
	const result = await source.commit(plan)
	try {
		const after = await source.loadSnapshot(plan.purchaseId)
		if (matchesMemberlessRepairReadback(after, plan))
			return {
				...result,
				verified: true as const,
				writesCommitted: result.status === 'repaired',
			}
	} catch {
		// A committed transaction is not undone by independent readback failure.
	}
	return {
		status: 'verification-failed' as const,
		verified: false as const,
		writesCommitted: result.status === 'repaired',
	}
}

// bulkCouponId has no production index. Never add another unbounded relation
// query or lock that table by coupon. Walk the primary key in bounded pages;
// any sibling holds this intentionally narrow bootstrap.
async function countSiblings(
	client: DbExecutor,
	purchaseId: string,
	couponId: string,
): Promise<number> {
	let cursor = ''
	for (let page = 0; page < 100; page++) {
		const rows = await client
			.select({ id: purchases.id, bulkCouponId: purchases.bulkCouponId })
			.from(purchases)
			.where(gt(purchases.id, cursor))
			.orderBy(asc(purchases.id))
			.limit(500)
		if (
			rows.some((row) => row.bulkCouponId === couponId && row.id !== purchaseId)
		)
			return 1
		if (rows.length < 500) return 0
		cursor = rows[rows.length - 1]!.id
	}
	throw new Error('Purchase scan exceeds the 50,000-row repair bound')
}

async function loadSnapshot(
	client: DbExecutor,
	purchaseId: string,
): Promise<MemberlessRepairSnapshot> {
	const purchase = await client.query.purchases.findFirst({
		where: eq(purchases.id, purchaseId),
	})
	if (!purchase?.userId || !purchase.bulkCouponId)
		return {
			purchase: purchase ?? null,
			coupon: null,
			buyer: null,
			memberships: [],
			personalOrganization: null,
			siblingCount: 0,
		}
	const pool = await client.query.coupon.findFirst({
		where: eq(coupon.id, purchase.bulkCouponId),
	})
	const buyer = await client.query.users.findFirst({
		where: eq(users.id, purchase.userId),
		columns: { id: true, email: true },
	})
	const memberships = await client.query.organizationMemberships.findMany({
		where: eq(organizationMemberships.userId, purchase.userId),
		limit: 2,
		with: { organizationMembershipRoles: { with: { role: true } } },
	})
	const personalOrganization = await client.query.organization.findFirst({
		where: eq(organization.personalOrganizationUserId, purchase.userId),
	})
	return {
		purchase,
		coupon: pool ?? null,
		buyer: buyer ?? null,
		memberships,
		personalOrganization: personalOrganization ?? null,
		siblingCount: await countSiblings(
			client,
			purchase.id,
			purchase.bulkCouponId,
		),
	}
}

function affected(result: unknown): number {
	if (
		result &&
		typeof result === 'object' &&
		'rowsAffected' in result &&
		typeof result.rowsAffected === 'number'
	)
		return result.rowsAffected
	if (
		Array.isArray(result) &&
		result[0] &&
		typeof result[0].affectedRows === 'number'
	)
		return result[0].affectedRows
	return 0
}

export function createMemberlessRepairDataSource(
	database: typeof db,
): MemberlessRepairDataSource {
	return {
		loadSnapshot: (purchaseId) => loadSnapshot(database, purchaseId),
		commit: (plan) =>
			database.transaction(async (transaction) => {
				// Use the existing coupon/purchase mutex order. Unique personal identity
				// indexes and indexed membership range locks fence absent governance.
				await transaction.execute(
					sql`SELECT ${coupon.id} FROM ${coupon} WHERE ${coupon.id} = ${plan.couponId} FOR UPDATE`,
				)
				await transaction.execute(
					sql`SELECT ${purchases.id} FROM ${purchases} WHERE ${purchases.id} = ${plan.purchaseId} FOR UPDATE`,
				)
				await transaction.execute(
					sql`SELECT ${users.id} FROM ${users} WHERE ${users.id} = ${plan.buyerId} FOR UPDATE`,
				)
				await transaction.execute(
					sql`SELECT ${organization.id} FROM ${organization} WHERE ${organization.personalOrganizationUserId} = ${plan.buyerId} FOR UPDATE`,
				)
				await transaction.execute(
					sql`SELECT ${organizationMemberships.id} FROM ${organizationMemberships} WHERE ${organizationMemberships.userId} = ${plan.buyerId} FOR UPDATE`,
				)
				const before = await loadSnapshot(transaction, plan.purchaseId)
				if (matchesMemberlessRepairReadback(before, plan))
					return { status: 'already-repaired' as const }
				if (holdReason(before) || digest(before) !== plan.expectedStateHash)
					throw new Error(
						'Repair expected state changed; preview and approval must be repeated',
					)
				const age = Date.now() - Date.parse(plan.createdAt)
				if (age < 0 || age > 15 * 60_000)
					throw new Error(
						'Repair preview expired; preview and approval must be repeated',
					)
				await transaction.insert(organization).values({
					id: plan.organizationId,
					name: getPersonalOrganizationName(before.buyer!.email!),
					personalOrganizationUserId: plan.buyerId,
				})
				await transaction.insert(organizationMemberships).values({
					id: plan.membershipId,
					organizationId: plan.organizationId,
					userId: plan.buyerId,
					invitedById: plan.buyerId,
					personalOrganizationUserId: plan.buyerId,
				})
				await transaction.insert(roles).values({
					id: plan.ownerRoleId,
					name: 'owner',
					organizationId: plan.organizationId,
					active: true,
					deletedAt: null,
				})
				await transaction.insert(organizationMembershipRoles).values({
					organizationMembershipId: plan.membershipId,
					roleId: plan.ownerRoleId,
					organizationId: plan.organizationId,
					active: true,
					deletedAt: null,
				})
				const purchaseUpdate = await transaction
					.update(purchases)
					.set({
						organizationId: plan.organizationId,
						purchasedByorganizationMembershipId: plan.membershipId,
					})
					.where(
						and(
							eq(purchases.id, plan.purchaseId),
							eq(purchases.userId, plan.buyerId),
							eq(purchases.bulkCouponId, plan.couponId),
							eq(purchases.status, 'Valid'),
							isNull(purchases.organizationId),
							isNull(purchases.purchasedByorganizationMembershipId),
						),
					)
				const couponUpdate = await transaction
					.update(coupon)
					.set({ organizationId: plan.organizationId })
					.where(
						and(
							eq(coupon.id, plan.couponId),
							isNull(coupon.organizationId),
							eq(coupon.status, 1),
							eq(coupon.maxUses, plan.maxUses),
							eq(coupon.usedCount, plan.usedCount),
						),
					)
				if (affected(purchaseUpdate) !== 1 || affected(couponUpdate) !== 1)
					throw new Error('Repair compare-and-set failed')
				if (
					!matchesMemberlessRepairReadback(
						await loadSnapshot(transaction, plan.purchaseId),
						plan,
					)
				)
					throw new Error('Repair transaction readback failed')
				return { status: 'repaired' as const }
			}),
	}
}
