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
import { USER_ADDED_TO_WORKSHOP_EVENT } from '@/inngest/functions/discord/add-discord-role-workflow'
import { inngest } from '@/inngest/inngest.server'
import { removeDiscordRole } from '@/lib/discord-utils'
import { log } from '@/server/logger'
import { and, eq, isNull } from 'drizzle-orm'

import { INCLUDED_PRODUCTS } from './included-product-policy'
export { hasIncludedProductEntitlements } from './included-product-policy'

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
type DiscordGrant = {
	entitlementId: string
	workshopId: string
	discordRoleId: string
	retireSourceRole: boolean
	grantTarget: boolean
}
type Entitlement = typeof entitlements.$inferSelect

const DISCORD_ID_PREFIX = 'c5_cc_dr_'

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

function verifyDiscordRow(
	row: Entitlement,
	expected: {
		userId: string
		purchaseId: string
		entitlementTypeId: string
		bundlePolicy: string
		productId: string
		context?: LearnerContext
	},
) {
	if (
		row.userId !== expected.userId ||
		row.sourceType !== EntitlementSourceType.PURCHASE ||
		row.sourceId !== expected.purchaseId ||
		row.entitlementType !== expected.entitlementTypeId ||
		row.expiresAt !== null ||
		row.metadata?.bundlePolicy !== expected.bundlePolicy ||
		row.metadata?.includedByProductId !== expected.productId ||
		typeof row.metadata?.discordRoleId !== 'string' ||
		(expected.context &&
			(row.organizationId !== expected.context.organizationId ||
				row.organizationMembershipId !==
					expected.context.organizationMembershipId))
	)
		throw new Error('Included-product discord entitlement contract mismatch')
}

/**
 * State path: unconfigured -> no-op; locked -> validated -> existing | created.
 * Fulfillment never restores revoked rows. Only a verified individual transfer
 * can restore a row retired by a completed transfer from that same owner.
 * Inngest owns retry/checkpoint state; MySQL owns serialization and rollback.
 * Parent-before-learner PK locks serialize against refund status updates.
 * This does not close the existing individual-refund window where entitlement
 * removal precedes the status webhook and no bundle tombstone exists yet.
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

	// Discover IDs without locking the unindexed bulkCouponId predicate. Each
	// parent is then locked by PRIMARY KEY and its coupon/product/status rechecked.
	const parentIds = routingPurchase.redeemedBulkCouponId
		? (
				await db.query.purchases.findMany({
					where: eq(
						purchases.bulkCouponId,
						routingPurchase.redeemedBulkCouponId,
					),
					columns: { id: true },
				})
			)
				.map((parent) => parent.id)
				.sort()
		: []

	const grants = await db.transaction(async (tx) => {
		const redeemedCouponId = routingPurchase.redeemedBulkCouponId
		if (redeemedCouponId) {
			const [seatCoupon] = await tx
				.select()
				.from(coupon)
				.where(eq(coupon.id, redeemedCouponId))
				.for('share')
			let hasValidParent = false
			for (const parentId of parentIds) {
				const [parent] = await tx
					.select()
					.from(purchases)
					.where(eq(purchases.id, parentId))
					.for('update')
				if (
					parent?.bulkCouponId === redeemedCouponId &&
					parent.productId === context.productId &&
					['Valid', 'Restricted'].includes(parent.status)
				)
					hasValidParent = true
			}
			// Add-seat orders reuse the coupon. A refunded parent does not
			// invalidate every seat while another paid C5 parent remains valid.
			// Invoice coupons/parents may have no org; membership is checked below.
			if (
				!hasValidParent ||
				!seatCoupon ||
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
			.for('share')
		const [membership] = await tx
			.select()
			.from(organizationMemberships)
			.where(eq(organizationMemberships.id, context.organizationMembershipId))
			.for('update')
		const [org] = await tx
			.select()
			.from(organization)
			.where(eq(organization.id, context.organizationId))
			.for('share')
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
			.for('share')
		if (!type)
			throw new Error('Missing workshop_content_access entitlement type')

		// Optional: a missing type skips the role and never blocks content access.
		const [discordType] = await tx
			.select()
			.from(entitlementTypes)
			.where(eq(entitlementTypes.name, 'workshop_discord_role'))
			.for('share')

		const result: Grant[] = []
		const discordGrants: DiscordGrant[] = []
		for (const policy of included) {
			const [includedProduct] = await tx
				.select()
				.from(products)
				.where(eq(products.id, policy.productId))
				.for('share')
			const [resource] = await tx
				.select()
				.from(contentResource)
				.where(
					and(
						eq(contentResource.id, policy.workshopId),
						isNull(contentResource.deletedAt),
					),
				)
				.for('share')
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
				.for('share')
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
						.set({
							deletedAt: new Date(),
							metadata: {
								...source.metadata,
								retiredByTransferId: operation.transferId,
							},
						})
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
				const retiredBy = row.metadata?.retiredByTransferId
				if (typeof retiredBy !== 'string')
					throw new Error('Included-product grant is revoked')
				const [retirement] = await tx
					.select()
					.from(purchaseUserTransfer)
					.where(eq(purchaseUserTransfer.id, retiredBy))
					.for('share')
				if (
					!retirement ||
					retirement.transferState !== 'COMPLETED' ||
					retirement.purchaseId !== purchase.id ||
					retirement.sourceUserId !== context.userId
				)
					throw new Error('Included-product grant is revoked')
				// Only a completed transfer retirement may be undone. Clear the
				// marker so a later refund/operator revocation cannot reuse its proof.
				await tx
					.update(entitlements)
					.set({
						deletedAt: null,
						metadata: { ...row.metadata, retiredByTransferId: null },
					})
					.where(eq(entitlements.id, id))
			}
			result.push({
				entitlementId: id,
				entitlementTypeId: type.id,
				resourceId: policy.workshopId,
			})

			const discordRoleId = includedProduct.fields?.discordRoleId
			if (typeof discordRoleId === 'string' && discordRoleId) {
				if (!discordType) {
					await log.warn('included_product.discord_type_missing', {
						purchaseId: purchase.id,
						productId: policy.productId,
					})
					continue
				}
				const discordContract = {
					purchaseId: purchase.id,
					productId: purchase.productId,
					entitlementTypeId: discordType.id,
					bundlePolicy: policy.bundlePolicy,
				}
				const discordIdFor = (userId: string) =>
					entitlementId(
						DISCORD_ID_PREFIX,
						purchase.id,
						userId,
						'discord:' + discordRoleId,
					)
				let retireSourceRole = false
				if (operation.kind === 'transfer') {
					const sourceDiscordId = discordIdFor(operation.sourceUserId)
					const [source] = await tx
						.select()
						.from(entitlements)
						.where(eq(entitlements.id, sourceDiscordId))
						.for('update')
					if (source) {
						verifyDiscordRow(source, {
							...discordContract,
							userId: operation.sourceUserId,
						})
						// A retry after the retiring commit but before the Discord
						// removal succeeded must still remove the source role.
						if (
							source.deletedAt &&
							source.metadata?.retiredByTransferId === operation.transferId
						)
							retireSourceRole = true
						if (!source.deletedAt) {
							retireSourceRole = true
							await tx
								.update(entitlements)
								.set({
									deletedAt: new Date(),
									metadata: {
										...source.metadata,
										retiredByTransferId: operation.transferId,
									},
								})
								.where(
									and(
										eq(entitlements.id, sourceDiscordId),
										isNull(entitlements.deletedAt),
									),
								)
						}
					}
				}

				const discordId = discordIdFor(context.userId)
				const readDiscordRow = async () =>
					(
						await tx
							.select()
							.from(entitlements)
							.where(eq(entitlements.id, discordId))
							.for('update')
					)[0]
				let discordRow = await readDiscordRow()
				if (!discordRow) {
					try {
						await createWorkshopEntitlement(
							{
								id: discordId,
								userId: context.userId,
								organizationId: context.organizationId,
								organizationMembershipId: context.organizationMembershipId,
								entitlementType: discordType.id,
								sourceType: EntitlementSourceType.PURCHASE,
								sourceId: purchase.id,
								metadata: {
									discordRoleId,
									bundlePolicy: policy.bundlePolicy,
									includedByProductId: purchase.productId,
								},
							},
							tx,
						)
					} catch (error) {
						if (!isDuplicateEntry(error)) throw error
					}
					discordRow = await readDiscordRow()
				}
				if (!discordRow)
					throw new Error('Included-product discord grant readback missing')
				verifyDiscordRow(discordRow, {
					...discordContract,
					userId: context.userId,
					context,
				})
				// A revoked target row never blocks the source-role cleanup below.
				let grantTarget = true
				if (discordRow.deletedAt) {
					// Same tombstone rule as content access: only a completed
					// transfer retirement from this same owner may be undone.
					const retiredBy =
						operation.kind === 'transfer'
							? discordRow.metadata?.retiredByTransferId
							: undefined
					const [retirement] =
						typeof retiredBy === 'string'
							? await tx
									.select()
									.from(purchaseUserTransfer)
									.where(eq(purchaseUserTransfer.id, retiredBy))
									.for('share')
							: []
					if (
						!retirement ||
						retirement.transferState !== 'COMPLETED' ||
						retirement.purchaseId !== purchase.id ||
						retirement.sourceUserId !== context.userId
					) {
						grantTarget = false
						await log.warn('included_product.discord_grant_revoked', {
							purchaseId: purchase.id,
							entitlementId: discordId,
						})
					} else {
						await tx
							.update(entitlements)
							.set({
								deletedAt: null,
								metadata: {
									...discordRow.metadata,
									retiredByTransferId: null,
								},
							})
							.where(eq(entitlements.id, discordId))
					}
				}
				discordGrants.push({
					entitlementId: discordId,
					workshopId: policy.workshopId,
					discordRoleId,
					retireSourceRole,
					grantTarget,
				})
			}
		}
		return { result, discordGrants }
	})
	const { result: contentGrants, discordGrants } = grants

	for (const grant of contentGrants) {
		await log.info('included_product.entitlement_reconciled', {
			purchaseId: context.purchaseId,
			entitlementId: grant.entitlementId,
			bundlePolicy: included.find(
				(policy) => policy.workshopId === grant.resourceId,
			)?.bundlePolicy,
			status: operation.kind,
		})
	}

	for (const grant of discordGrants) {
		if (operation.kind === 'transfer' && grant.retireSourceRole) {
			// Another live grant of the same role (e.g. a direct Crash Course
			// purchase) keeps the source user's role.
			const sourceLive = await db.query.entitlements.findMany({
				where: and(
					eq(entitlements.userId, operation.sourceUserId),
					isNull(entitlements.deletedAt),
				),
			})
			const stillEntitled = sourceLive.some(
				(row) => row.metadata?.discordRoleId === grant.discordRoleId,
			)
			if (!stillEntitled) {
				const removal = await removeDiscordRole(
					operation.sourceUserId,
					grant.discordRoleId,
				)
				// Throw so the caller's retry re-runs the removal.
				if (removal.status === 'error')
					throw new Error('Included-product source discord role removal failed')
			}
		}
		if (!grant.grantTarget) continue
		// Idempotent add-role path shared with direct purchases. A send failure
		// throws so the retry event re-runs the (already-created) grant.
		await inngest.send({
			name: USER_ADDED_TO_WORKSHOP_EVENT,
			data: {
				workshopId: grant.workshopId,
				userId: context.userId,
				discordRoleId: grant.discordRoleId,
			},
		})
		await log.info('included_product.discord_role_requested', {
			purchaseId: context.purchaseId,
			entitlementId: grant.entitlementId,
			status: operation.kind,
		})
	}
	return contentGrants
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
