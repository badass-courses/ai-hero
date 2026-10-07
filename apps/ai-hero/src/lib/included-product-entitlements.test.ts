import { createHash } from 'node:crypto'
import { getTableName, type SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory adapter evaluates the actual Drizzle predicates and records locks.
// Transactions serialize and roll back; this is not a real MySQL isolation test.
const fake = vi.hoisted(() => ({
	tables: new Map<string, Record<string, unknown>[]>(),
	locks: [] as string[],
	queue: Promise.resolve(),
	beforeTransaction: undefined as (() => void) | undefined,
	insertFailure: undefined as unknown,
	duplicateRow: undefined as Record<string, unknown> | undefined,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const dialect = new MySqlDialect()
function matches(row: Record<string, unknown>, predicate?: SQL) {
	if (!predicate) return true
	const { sql, params } = dialect.sqlToQuery(predicate)
	let parameter = 0
	return [...sql.matchAll(/`[^`]+`\.`([^`]+)` (= \?|is null)/g)].every(
		(match) => {
			const key = match[1]!
			return match[2] === 'is null'
				? row[key] == null
				: row[key] === params[parameter++]
		},
	)
}
function rows(table: Parameters<typeof getTableName>[0]) {
	const name = getTableName(table)
	if (!fake.tables.has(name)) fake.tables.set(name, [])
	return fake.tables.get(name)!
}
function executor() {
	return {
		select: () => ({
			from: (table: Parameters<typeof getTableName>[0]) => ({
				where: (predicate: SQL) => ({
					for: async (mode: string) => {
						expect(['update', 'share']).toContain(mode)
						fake.locks.push(dialect.sqlToQuery(predicate).sql)
						return rows(table)
							.filter((row) => matches(row, predicate))
							.map((row) => ({ ...row }))
					},
				}),
			}),
		}),
		insert: (table: Parameters<typeof getTableName>[0]) => ({
			values: async (value: Record<string, unknown>) => {
				if (fake.insertFailure) throw fake.insertFailure
				if (fake.duplicateRow) {
					rows(table).push(fake.duplicateRow)
					fake.duplicateRow = undefined
					throw { cause: { code: 'ER_DUP_ENTRY' } }
				}
				if (rows(table).some((row) => row.id === value.id))
					throw { code: 'ER_DUP_ENTRY' }
				rows(table).push({
					...value,
					expiresAt: value.expiresAt ?? null,
					deletedAt: value.deletedAt ?? null,
				})
			},
		}),
		update: (table: Parameters<typeof getTableName>[0]) => ({
			set: (values: Record<string, unknown>) => ({
				where: async (predicate: SQL) => {
					let rowsAffected = 0
					for (const row of rows(table))
						if (matches(row, predicate)) {
							Object.assign(row, values)
							rowsAffected++
						}
					return { rowsAffected }
				},
			}),
		}),
	}
}
vi.mock('@/db', () => ({
	db: {
		get select() {
			return executor().select
		},
		get insert() {
			return executor().insert
		},
		get update() {
			return executor().update
		},
		query: {
			purchases: {
				findFirst: async ({ where }: { where: SQL }) =>
					rows(purchases).find((row) => matches(row, where)),
				findMany: async ({ where }: { where: SQL }) =>
					rows(purchases).filter((row) => matches(row, where)),
			},
			organizationMemberships: { findFirst: async () => undefined },
			entitlements: {
				findMany: async ({ where }: { where: SQL }) =>
					rows(entitlements).filter((row) => matches(row, where)),
			},
			coupon: {
				findFirst: async ({ where }: { where: SQL }) =>
					rows(coupon).find((row) => matches(row, where)),
			},
		},
		transaction: async (
			work: (tx: ReturnType<typeof executor>) => Promise<unknown>,
		) => {
			const previous = fake.queue
			let release = () => {}
			fake.queue = new Promise<void>((resolve) => {
				release = resolve
			})
			await previous
			fake.beforeTransaction?.()
			fake.beforeTransaction = undefined
			const snapshot = structuredClone(fake.tables)
			try {
				return await work(executor())
			} catch (error) {
				fake.tables = snapshot
				throw error
			} finally {
				release()
			}
		},
	},
}))
vi.mock('@/server/logger', () => ({ log: fake.log }))

import {
	contentResource,
	contentResourceProduct,
	coupon,
	entitlements,
	entitlementTypes,
	organization,
	organizationMemberships,
	products,
	purchases,
	purchaseUserTransfer,
	users,
} from '@/db/schema'
import { refundBulkPurchaseEntitlements } from '@/lib/bulk-purchase-refund'
import { softDeleteEntitlementsForPurchase } from '@/lib/entitlements'
import {
	grantIncludedProductEntitlements,
	transferIncludedProductEntitlements,
} from './included-product-entitlements'

const context = {
	purchaseId: 'learner-purchase',
	productId: 'product-s00zs',
	userId: 'learner',
	organizationId: 'learner-org',
	organizationMembershipId: 'learner-member',
}
const bundleId = (userId = context.userId) =>
	'c5_cc_' +
	createHash('sha256')
		.update(JSON.stringify([context.purchaseId, userId, 'workshop-2ozd9']))
		.digest('hex')
function seed(
	table: Parameters<typeof getTableName>[0],
	...values: Record<string, unknown>[]
) {
	rows(table).push(...values)
}
function purchase() {
	return rows(purchases)[0]!
}
function active() {
	return rows(entitlements).filter((row) => !row.deletedAt)
}
function seat() {
	purchase().redeemedBulkCouponId = 'seat-coupon'
	seed(coupon, {
		id: 'seat-coupon',
		organizationId: context.organizationId,
		restrictedToProductId: context.productId,
	})
	seed(purchases, {
		id: 'parent',
		userId: 'billing-owner',
		productId: context.productId,
		organizationId: context.organizationId,
		bulkCouponId: 'seat-coupon',
		status: 'Valid',
		redeemedBulkCouponId: null,
	})
}
function target() {
	purchase().userId = 'target'
	purchase().organizationId = 'target-org'
	seed(users, { id: 'target' })
	seed(organization, {
		id: 'target-org',
		personalOrganizationUserId: 'target',
	})
	seed(organizationMemberships, {
		id: 'target-member',
		userId: 'target',
		organizationId: 'target-org',
	})
	seed(purchaseUserTransfer, {
		id: 'transfer',
		purchaseId: context.purchaseId,
		transferState: 'VERIFIED',
		sourceUserId: 'learner',
		targetUserId: 'target',
	})
	return {
		...context,
		userId: 'target',
		organizationId: 'target-org',
		organizationMembershipId: 'target-member',
		transferId: 'transfer',
		sourceUserId: 'learner',
	}
}
beforeEach(() => {
	fake.tables = new Map()
	fake.locks = []
	fake.queue = Promise.resolve()
	fake.beforeTransaction = undefined
	fake.insertFailure = undefined
	fake.duplicateRow = undefined
	vi.clearAllMocks()
	seed(purchases, {
		id: context.purchaseId,
		productId: context.productId,
		userId: context.userId,
		organizationId: context.organizationId,
		status: 'Valid',
		bulkCouponId: null,
		redeemedBulkCouponId: null,
	})
	seed(users, { id: context.userId })
	seed(organization, {
		id: context.organizationId,
		personalOrganizationUserId: context.userId,
	})
	seed(organizationMemberships, {
		id: context.organizationMembershipId,
		userId: context.userId,
		organizationId: context.organizationId,
	})
	seed(entitlementTypes, {
		id: 'workshop-access-type',
		name: 'workshop_content_access',
	})
	seed(products, { id: 'product-ma254', type: 'self-paced' })
	seed(contentResource, {
		id: 'workshop-2ozd9',
		type: 'workshop',
		deletedAt: null,
		fields: { startsAt: null },
	})
	seed(contentResourceProduct, {
		productId: 'product-ma254',
		resourceId: 'workshop-2ozd9',
		deletedAt: null,
	})
})

describe('included product fulfillment policy', () => {
	it.each(['Valid', 'Restricted'])(
		'grants direct %s purchases the exact purchase-scoped workshop row',
		async (status) => {
			purchase().status = status
			await grantIncludedProductEntitlements(context)
			expect(active()).toEqual([
				expect.objectContaining({
					id: bundleId(),
					userId: context.userId,
					sourceType: 'PURCHASE',
					sourceId: context.purchaseId,
					organizationId: context.organizationId,
					organizationMembershipId: context.organizationMembershipId,
					entitlementType: 'workshop-access-type',
					expiresAt: null,
					deletedAt: null,
					metadata: {
						contentIds: ['workshop-2ozd9'],
						bundlePolicy: 'c5-includes-crash-course-v1',
						includedByProductId: context.productId,
					},
				}),
			])
		},
	)
	it('accepts a newly ensured personal organization for a direct purchase without an organization', async () => {
		purchase().organizationId = null
		await grantIncludedProductEntitlements(context)
		expect(active()).toHaveLength(1)
	})
	it('grants first and later redeemed seats using learner purchase IDs and team memberships', async () => {
		seat()
		rows(organization)[0]!.personalOrganizationUserId = null
		await grantIncludedProductEntitlements(context)
		const later = {
			...context,
			purchaseId: 'later-seat',
			userId: 'later-learner',
			organizationMembershipId: 'later-member',
		}
		seed(purchases, {
			...purchase(),
			id: later.purchaseId,
			userId: later.userId,
		})
		seed(users, { id: later.userId })
		seed(organizationMemberships, {
			id: later.organizationMembershipId,
			userId: later.userId,
			organizationId: later.organizationId,
		})
		await grantIncludedProductEntitlements(later)
		expect(active().map((row) => row.sourceId)).toEqual([
			context.purchaseId,
			later.purchaseId,
		])
		expect(fake.locks[1]).toContain('`AI_Purchase`.`id`')
		expect(fake.locks.every((sql) => !sql.includes('bulkCouponId'))).toBe(true)
	})
	it.each([
		'invoice-no-org',
		'multi-parent',
		'one-parent-refunded',
		'all-parents-refunded',
		'changed-parent-coupon',
	])('checks the coupon chain for %s', async (variant) => {
		seat()
		const parent = rows(purchases)[1]!
		parent.organizationId = null
		rows(coupon)[0]!.organizationId = null
		if (variant !== 'invoice-no-org')
			seed(purchases, { ...parent, id: 'added-seats' })
		if (variant === 'one-parent-refunded') parent.status = 'Refunded'
		if (variant === 'all-parents-refunded')
			for (const row of rows(purchases).slice(1)) row.status = 'Refunded'
		if (variant === 'changed-parent-coupon')
			fake.beforeTransaction = () => {
				for (const row of rows(purchases).slice(1))
					row.bulkCouponId = 'different-coupon'
			}
		if (
			variant === 'all-parents-refunded' ||
			variant === 'changed-parent-coupon'
		) {
			await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
				'seat origin',
			)
			expect(active()).toHaveLength(0)
		} else {
			await grantIncludedProductEntitlements(context)
			expect(active()).toHaveLength(1)
		}
		expect(fake.locks.every((sql) => !sql.includes('bulkCouponId'))).toBe(true)
	})
	it('does not grant a billing buyer without a redeemed seat', async () => {
		purchase().bulkCouponId = 'bulk-coupon'
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'learner purchase',
		)
		expect(active()).toEqual([])
	})
	it('leaves unrelated products alone', async () => {
		await expect(
			grantIncludedProductEntitlements({
				...context,
				productId: 'product-other',
			}),
		).resolves.toEqual([])
		expect(fake.locks).toEqual([])
		expect(active()).toEqual([])
	})
	it('dedupes retries, concurrent deliveries and a lost checkpoint', async () => {
		await Promise.all([
			grantIncludedProductEntitlements(context),
			grantIncludedProductEntitlements(context),
		])
		await grantIncludedProductEntitlements(context)
		expect(active()).toHaveLength(1)
		expect(active()[0]!.id).toBe(bundleId())
	})
	it('rolls back failed writes and retries cleanly', async () => {
		fake.insertFailure = new Error('temporary failure')
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'temporary failure',
		)
		expect(active()).toEqual([])
		fake.insertFailure = undefined
		await grantIncludedProductEntitlements(context)
		expect(active()).toHaveLength(1)
	})
	it('verifies the contract on a duplicate-key readback and propagates other failures', async () => {
		await grantIncludedProductEntitlements(context)
		fake.duplicateRow = active()[0]
		rows(entitlements).length = 0
		await grantIncludedProductEntitlements(context)
		expect(active()).toHaveLength(1)
		rows(entitlements).length = 0
		fake.duplicateRow = { id: bundleId(), userId: 'wrong-owner' }
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'contract mismatch',
		)
	})
	it.each(['Refunded', 'Disputed', 'Banned'])(
		'rejects fresh terminal purchase status %s',
		async (status) => {
			fake.beforeTransaction = () => {
				purchase().status = status
			}
			await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
				'learner purchase',
			)
			expect(active()).toEqual([])
		},
	)
	it.each(['owner', 'organization', 'membership', 'user', 'personal-org'])(
		'rejects mismatched %s context',
		async (variant) => {
			if (variant === 'owner') purchase().userId = 'other'
			if (variant === 'organization') purchase().organizationId = 'other'
			if (variant === 'membership')
				rows(organizationMemberships)[0]!.userId = 'other'
			if (variant === 'user') rows(users).length = 0
			if (variant === 'personal-org') {
				purchase().organizationId = null
				rows(organization)[0]!.personalOrganizationUserId = 'other'
			}
			await expect(grantIncludedProductEntitlements(context)).rejects.toThrow()
			expect(active()).toEqual([])
		},
	)
	it.each([
		'parent-status',
		'parent-product',
		'coupon-product',
		'parent-missing',
	])('fails closed on invalid seat %s', async (variant) => {
		seat()
		const parent = rows(purchases)[1]!
		if (variant === 'parent-status') parent.status = 'Refunded'
		if (variant === 'parent-product') parent.productId = 'other'
		if (variant === 'coupon-product')
			rows(coupon)[0]!.restrictedToProductId = 'other'
		if (variant === 'parent-missing') rows(purchases).pop()
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'seat origin',
		)
		expect(active()).toEqual([])
	})
	it.each(['type', 'resource', 'relation', 'product'])(
		'fails closed on missing included %s',
		async (variant) => {
			rows(
				{
					type: entitlementTypes,
					resource: contentResource,
					relation: contentResourceProduct,
					product: products,
				}[variant]!,
			).length = 0
			await expect(grantIncludedProductEntitlements(context)).rejects.toThrow()
			expect(active()).toEqual([])
		},
	)
	it.each([
		'userId',
		'sourceId',
		'organizationId',
		'organizationMembershipId',
		'expiresAt',
		'metadata',
	])('rejects existing row drift in %s', async (key) => {
		await grantIncludedProductEntitlements(context)
		active()[0]![key] = key === 'expiresAt' ? new Date() : 'drift'
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'contract mismatch',
		)
	})
	it('never revives a tombstone from an old fulfillment event', async () => {
		await grantIncludedProductEntitlements(context)
		await softDeleteEntitlementsForPurchase(context.purchaseId)
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'revoked',
		)
		expect(active()).toEqual([])
	})
	it.each(['standalone', 'cohort'])(
		'refunds %s without removing the other purchase grant',
		async (which) => {
			seed(entitlements, {
				id: 'standalone-crash',
				userId: context.userId,
				sourceId: 'standalone',
				sourceType: 'PURCHASE',
				deletedAt: null,
				metadata: { contentIds: ['workshop-2ozd9'] },
			})
			await grantIncludedProductEntitlements(context)
			await softDeleteEntitlementsForPurchase(
				which === 'standalone' ? 'standalone' : context.purchaseId,
			)
			expect(active().map((row) => row.id)).toEqual([
				which === 'standalone' ? bundleId() : 'standalone-crash',
			])
		},
	)
	it('bulk refund removes derived rows using the existing refund helper, not unrelated Crash purchases', async () => {
		seat()
		await grantIncludedProductEntitlements(context)
		seed(entitlements, {
			id: 'standalone-crash',
			userId: context.userId,
			sourceId: 'standalone',
			sourceType: 'PURCHASE',
			deletedAt: null,
		})
		const parent = rows(purchases)[1]!
		parent.status = 'Refunded' // commerce changes status before the refund event
		expect(await refundBulkPurchaseEntitlements(parent)).toMatchObject({
			success: true,
			totalPurchasesRefunded: 2,
		})
		expect(active().map((row) => row.id)).toEqual(['standalone-crash'])
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'seat origin',
		)
	})
})

describe('included product individual transfer', () => {
	it('retires only the old purchase bundle, grants the target and dedupes retry', async () => {
		await grantIncludedProductEntitlements(context)
		seed(entitlements, {
			id: 'unrelated-crash',
			userId: context.userId,
			sourceId: 'standalone',
			sourceType: 'PURCHASE',
			deletedAt: null,
		})
		const transfer = target()
		await transferIncludedProductEntitlements(transfer)
		await transferIncludedProductEntitlements(transfer)
		expect(
			rows(entitlements).find((row) => row.id === bundleId())!.deletedAt,
		).toBeInstanceOf(Date)
		expect(active().map((row) => row.id)).toEqual([
			'unrelated-crash',
			bundleId('target'),
		])
		await expect(grantIncludedProductEntitlements(context)).rejects.toThrow(
			'learner purchase',
		)
	})
	it('permits a new verified transfer back to a prior owner, never an old event', async () => {
		await grantIncludedProductEntitlements(context)
		const first = target()
		await transferIncludedProductEntitlements(first)
		rows(purchaseUserTransfer)[0]!.transferState = 'COMPLETED'
		purchase().userId = context.userId
		purchase().organizationId = context.organizationId
		seed(purchaseUserTransfer, {
			id: 'transfer-back',
			purchaseId: context.purchaseId,
			transferState: 'VERIFIED',
			sourceUserId: 'target',
			targetUserId: context.userId,
		})
		await expect(transferIncludedProductEntitlements(first)).rejects.toThrow(
			'learner purchase',
		)
		await transferIncludedProductEntitlements({
			...context,
			transferId: 'transfer-back',
			sourceUserId: 'target',
		})
		expect(active().map((row) => row.id)).toEqual([bundleId()])
	})

	it('does not restore an operator-revoked row on transfer back', async () => {
		await grantIncludedProductEntitlements(context)
		await softDeleteEntitlementsForPurchase(context.purchaseId)
		const first = target()
		await transferIncludedProductEntitlements(first)
		rows(purchaseUserTransfer)[0]!.transferState = 'COMPLETED'
		purchase().userId = context.userId
		purchase().organizationId = context.organizationId
		seed(purchaseUserTransfer, {
			id: 'back',
			purchaseId: context.purchaseId,
			sourceUserId: 'target',
			targetUserId: context.userId,
			transferState: 'VERIFIED',
		})
		await expect(
			transferIncludedProductEntitlements({
				...context,
				transferId: 'back',
				sourceUserId: 'target',
			}),
		).rejects.toThrow('revoked')
		expect(active().map((row) => row.id)).toEqual([bundleId('target')])
	})
	it.each(['INITIATED', 'wrong-owner', 'wrong-purchase'])(
		'rejects a retirement marker pointing to %s',
		async (variant) => {
			await grantIncludedProductEntitlements(context)
			await transferIncludedProductEntitlements(target())
			const retirement = rows(purchaseUserTransfer)[0]!
			retirement.transferState =
				variant === 'INITIATED' ? 'INITIATED' : 'COMPLETED'
			if (variant === 'wrong-owner') retirement.sourceUserId = 'other'
			if (variant === 'wrong-purchase') retirement.purchaseId = 'other'
			purchase().userId = context.userId
			purchase().organizationId = context.organizationId
			seed(purchaseUserTransfer, {
				id: 'back',
				purchaseId: context.purchaseId,
				sourceUserId: 'target',
				targetUserId: context.userId,
				transferState: 'VERIFIED',
			})
			await expect(
				transferIncludedProductEntitlements({
					...context,
					transferId: 'back',
					sourceUserId: 'target',
				}),
			).rejects.toThrow('revoked')
		},
	)
	it('documents the pre-existing individual soft-delete-before-status window with no tombstone', async () => {
		await softDeleteEntitlementsForPurchase(context.purchaseId)
		await grantIncludedProductEntitlements(context)
		// No durable refund marker exists yet; fixing the global refund order is
		// separate work. This is a limitation, not a no-resurrection proof.
		expect(active()).toHaveLength(1)
	})
	it('rolls back source revocation if target insertion fails', async () => {
		await grantIncludedProductEntitlements(context)
		fake.insertFailure = new Error('insertion failed')
		await expect(transferIncludedProductEntitlements(target())).rejects.toThrow(
			'insertion failed',
		)
		expect(active().map((row) => row.id)).toEqual([bundleId()])
	})
	it.each([
		'unverified',
		'wrong-target',
		'wrong-source',
		'wrong-purchase',
		'redeemed-seat',
	])('rejects %s transfer', async (variant) => {
		await grantIncludedProductEntitlements(context)
		const transfer = target()
		const row = rows(purchaseUserTransfer)[0]!
		if (variant === 'unverified') row.transferState = 'INITIATED'
		if (variant === 'wrong-target') row.targetUserId = 'other'
		if (variant === 'wrong-source') row.sourceUserId = 'other'
		if (variant === 'wrong-purchase') row.purchaseId = 'other'
		if (variant === 'redeemed-seat') {
			seat()
			rows(coupon)[0]!.organizationId = 'target-org'
			rows(purchases)[1]!.organizationId = 'target-org'
		}
		await expect(transferIncludedProductEntitlements(transfer)).rejects.toThrow(
			'individual transfer',
		)
		expect(active().map((entry) => entry.id)).toEqual([bundleId()])
	})
	it('refund after transfer revokes the target bundle and an old transfer cannot restore it', async () => {
		await grantIncludedProductEntitlements(context)
		const transfer = target()
		await transferIncludedProductEntitlements(transfer)
		purchase().status = 'Refunded'
		await softDeleteEntitlementsForPurchase(context.purchaseId)
		await expect(transferIncludedProductEntitlements(transfer)).rejects.toThrow(
			'learner purchase',
		)
		expect(active()).toEqual([])
	})
})
