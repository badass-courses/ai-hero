import { createHash } from 'node:crypto'
import { db } from '@/db'
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
import {
	createWorkshopEntitlement,
	EntitlementSourceType,
} from '@/lib/entitlements'
import { log } from '@/server/logger'
import { and, eq, isNull } from 'drizzle-orm'

// Inclusion is fulfillment policy, not a course-sync resource relation.
const INCLUDED_PRODUCTS: Readonly<
	Record<
		string,
		readonly {
			productId: string
			workshopId: string
			bundlePolicy: string
			idPrefix: string
		}[]
	>
> = {
	'product-s00zs': [
		{
			productId: 'product-ma254',
			workshopId: 'workshop-2ozd9',
			bundlePolicy: 'c5-includes-crash-course-v1',
			idPrefix: 'c5_cc_',
		},
	],
}

type LearnerContext = {
	purchaseId: string
	productId: string
	userId: string
	organizationId: string
	organizationMembershipId: string
}
type Operation =
	| { kind: 'fulfill' }
	| { kind: 'transfer'; transferId: string; sourceUserId: string }
type Grant = {
	entitlementId: string
	entitlementTypeId: string
	resourceId: string
}
type Entitlement = typeof entitlements.$inferSelect

function entitlementId(
	prefix: string,
	purchaseId: string,
	userId: string,
	resourceId: string,
) {
	return (
		prefix +
		createHash('sha256')
			.update(JSON.stringify([purchaseId, userId, resourceId]))
			.digest('hex')
	)
}

function isDuplicateEntry(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false
	if ('code' in error && error.code === 'ER_DUP_ENTRY') return true
	return (
		'cause' in error && error.cause !== error && isDuplicateEntry(error.cause)
	)
}

function verifyRow(
	row: Entitlement,
	expected: {
		userId: string
		purchaseId: string
		entitlementTypeId: string
		resourceId: string
		bundlePolicy: string
		productId: string
		context?: LearnerContext
	},
) {
	const contentIds: unknown = row.metadata?.contentIds
	if (
		row.userId !== expected.userId ||
		row.sourceType !== EntitlementSourceType.PURCHASE ||
		row.sourceId !== expected.purchaseId ||
		row.entitlementType !== expected.entitlementTypeId ||
		row.expiresAt !== null ||
		row.metadata?.bundlePolicy !== expected.bundlePolicy ||
		row.metadata?.includedByProductId !== expected.productId ||
		!Array.isArray(contentIds) ||
		contentIds.length !== 1 ||
		contentIds[0] !== expected.resourceId ||
		(expected.context &&
			(row.organizationId !== expected.context.organizationId ||
				row.organizationMembershipId !==
					expected.context.organizationMembershipId))
	)
		throw new Error('Included-product entitlement contract mismatch')
}

/**
 * State path: unconfigured -> no-op; locked -> validated -> existing | created.
 * Fulfillment never restores revoked rows. Only a verified individual transfer
 * can restore a prior owner's row when that owner explicitly receives it back.
 * Inngest owns retry/checkpoint state; MySQL owns serialization and rollback.
 * Parent-before-learner locks serialize against refund status updates. Current
 * locking reads (not repeatable-read snapshots) prevent delayed event grants.
 */
async function reconcileIncludedProducts(
	context: LearnerContext,
	operation: Operation,
): Promise<Grant[]> {
	const included = INCLUDED_PRODUCTS[context.productId]
	if (!included) return []

	// This read only chooses lock order; all decisions use the locked rows below.
	const routingPurchase = await db.query.purchases.findFirst({
		where: eq(purchases.id, context.purchaseId),
	})
	if (!routingPurchase) throw new Error('Included-product purchase not found')

	const grants = await db.transaction(async (tx) => {
		const redeemedCouponId = routingPurchase.redeemedBulkCouponId
		if (redeemedCouponId) {
			const [seatCoupon] = await tx
				.select()
				.from(coupon)
				.where(eq(coupon.id, redeemedCouponId))
				.for('update')
			const parents = await tx
				.select()
				.from(purchases)
				.where(eq(purchases.bulkCouponId, redeemedCouponId))
				.for('update')
			const parent = parents[0]
			if (
				parents.length !== 1 ||
				!parent ||
				!seatCoupon ||
				!['Valid', 'Restricted'].includes(parent.status) ||
				parent.productId !== context.productId ||
				parent.organizationId !== context.organizationId ||
				seatCoupon.organizationId !== context.organizationId ||
				seatCoupon.restrictedToProductId !== context.productId
			)
				throw new Error('Invalid included-product seat origin')
		}

		const [purchase] = await tx
			.select()
			.from(purchases)
			.where(eq(purchases.id, context.purchaseId))
			.for('update')
		if (
			!purchase ||
			purchase.productId !== context.productId ||
			purchase.userId !== context.userId ||
			purchase.bulkCouponId ||
			purchase.redeemedBulkCouponId !== redeemedCouponId ||
			!['Valid', 'Restricted'].includes(purchase.status) ||
			(purchase.organizationId &&
				purchase.organizationId !== context.organizationId)
		)
			throw new Error('Invalid included-product learner purchase')

		const [user] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, context.userId))
			.for('update')
		const [membership] = await tx
			.select()
			.from(organizationMemberships)
			.where(eq(organizationMemberships.id, context.organizationMembershipId))
			.for('update')
		const [org] = await tx
			.select()
			.from(organization)
			.where(eq(organization.id, context.organizationId))
			.for('update')
		if (
			!user ||
			!membership ||
			!org ||
			membership.userId !== context.userId ||
			membership.organizationId !== context.organizationId ||
			(!purchase.organizationId &&
				org.personalOrganizationUserId !== context.userId)
		)
			throw new Error('Invalid included-product learner membership')

		if (operation.kind === 'transfer') {
			const [transfer] = await tx
				.select()
				.from(purchaseUserTransfer)
				.where(eq(purchaseUserTransfer.id, operation.transferId))
				.for('update')
			if (
				purchase.redeemedBulkCouponId ||
				!transfer ||
				transfer.transferState !== 'VERIFIED' ||
				transfer.purchaseId !== purchase.id ||
				transfer.sourceUserId !== operation.sourceUserId ||
				transfer.targetUserId !== context.userId ||
				operation.sourceUserId === context.userId
			)
				throw new Error('Invalid included-product individual transfer')
		}

		const [type] = await tx
			.select()
			.from(entitlementTypes)
			.where(eq(entitlementTypes.name, 'workshop_content_access'))
			.for('update')
		if (!type)
			throw new Error('Missing workshop_content_access entitlement type')

		const result: Grant[] = []
		for (const policy of included) {
			const [includedProduct] = await tx
				.select()
				.from(products)
				.where(eq(products.id, policy.productId))
				.for('update')
			const [resource] = await tx
				.select()
				.from(contentResource)
				.where(
					and(
						eq(contentResource.id, policy.workshopId),
						isNull(contentResource.deletedAt),
					),
				)
				.for('update')
			const [relation] = await tx
				.select()
				.from(contentResourceProduct)
				.where(
					and(
						eq(contentResourceProduct.productId, policy.productId),
						eq(contentResourceProduct.resourceId, policy.workshopId),
						isNull(contentResourceProduct.deletedAt),
					),
				)
				.for('update')
			if (
				!includedProduct ||
				includedProduct.type !== 'self-paced' ||
				!resource ||
				resource.type !== 'workshop' ||
				!relation
			) {
				throw new Error(
					'Included workshop product/resource missing or mismatched',
				)
			}

			const contract = {
				purchaseId: purchase.id,
				productId: purchase.productId,
				entitlementTypeId: type.id,
				resourceId: policy.workshopId,
				bundlePolicy: policy.bundlePolicy,
			}
			if (operation.kind === 'transfer') {
				const sourceId = entitlementId(
					policy.idPrefix,
					purchase.id,
					operation.sourceUserId,
					policy.workshopId,
				)
				const [source] = await tx
					.select()
					.from(entitlements)
					.where(eq(entitlements.id, sourceId))
					.for('update')
				if (source) {
					verifyRow(source, { ...contract, userId: operation.sourceUserId })
					await tx
						.update(entitlements)
						.set({ deletedAt: new Date() })
						.where(
							and(
								eq(entitlements.id, sourceId),
								isNull(entitlements.deletedAt),
							),
						)
				}
			}

			const id = entitlementId(
				policy.idPrefix,
				purchase.id,
				context.userId,
				policy.workshopId,
			)
			const readRow = async () =>
				(
					await tx
						.select()
						.from(entitlements)
						.where(eq(entitlements.id, id))
						.for('update')
				)[0]
			let row = await readRow()
			if (!row) {
				try {
					await createWorkshopEntitlement(
						{
							id,
							userId: context.userId,
							resourceId: policy.workshopId,
							organizationId: context.organizationId,
							organizationMembershipId: context.organizationMembershipId,
							entitlementType: type.id,
							sourceType: EntitlementSourceType.PURCHASE,
							sourceId: purchase.id,
							metadata: {
								bundlePolicy: policy.bundlePolicy,
								includedByProductId: purchase.productId,
							},
						},
						tx,
					)
				} catch (error) {
					if (!isDuplicateEntry(error)) throw error
				}
				row = await readRow()
			}
			if (!row) throw new Error('Included-product grant readback missing')
			verifyRow(row, { ...contract, userId: context.userId, context })
			if (row.deletedAt) {
				if (operation.kind !== 'transfer') {
					throw new Error('Included-product grant is revoked')
				}
				// A new, verified transfer back to a prior owner is not an old
				// fulfillment replay. Ownership and the transfer row are locked
				// and checked above; source retirement and restoration commit together.
				await tx
					.update(entitlements)
					.set({ deletedAt: null })
					.where(eq(entitlements.id, id))
			}
			result.push({
				entitlementId: id,
				entitlementTypeId: type.id,
				resourceId: policy.workshopId,
			})
		}
		return result
	})

	for (const grant of grants) {
		await log.info('included_product.entitlement_reconciled', {
			purchaseId: context.purchaseId,
			entitlementId: grant.entitlementId,
			bundlePolicy: included.find(
				(policy) => policy.workshopId === grant.resourceId,
			)?.bundlePolicy,
			status: operation.kind,
		})
	}
	return grants
}

export function grantIncludedProductEntitlements(context: LearnerContext) {
	return reconcileIncludedProducts(context, { kind: 'fulfill' })
}

export function transferIncludedProductEntitlements(
	context: LearnerContext & {
		transferId: string
		sourceUserId: string
	},
) {
	return reconcileIncludedProducts(context, {
		kind: 'transfer',
		transferId: context.transferId,
		sourceUserId: context.sourceUserId,
	})
}
