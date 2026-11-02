import { db } from '@/db'
import { purchases, purchaseUserTransfer, users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { log } from '@/server/logger'
import { recordBuyerEntitlement } from './subscriber-marketing/buyer-entitlement'
import { DrizzleCaptureMarketingRepository } from './subscriber-marketing/drizzle-capture-repository'

async function recordHolder(args: {
	purchaseId: string
	userId: string
	grantId: string
	occurredAt: string
	policy: string
}) {
	const purchase = await db.query.purchases.findFirst({
		where: eq(purchases.id, args.purchaseId),
	})
	const user = await db.query.users.findFirst({
		where: eq(users.id, args.userId),
	})
	if (!purchase || !user) throw new Error('Buyer entitlement source not found')
	const result = await recordBuyerEntitlement({
		repository: new DrizzleCaptureMarketingRepository(db),
		warn: log.warn,
		source: {
			change: 'granted',
			entitlementId: args.grantId,
			userId: user.id,
			email: user.email,
			name: user.name,
			productId: purchase.productId,
			viaProductId: purchase.productId,
			bundlePolicy: args.policy,
			occurredAt: args.occurredAt,
		},
	})
	return { counts: result.counts }
}

/** Read the completed transfer, not event-supplied identity or product data. */
export async function captureTransferBuyerEntitlement(transferId: string) {
	const transfer = await db.query.purchaseUserTransfer.findFirst({
		where: eq(purchaseUserTransfer.id, transferId),
	})
	if (!transfer || transfer.transferState !== 'COMPLETED') {
		throw new Error('Buyer entitlement requires a completed transfer')
	}
	if (!transfer.targetUserId || !transfer.completedAt) {
		await log.warn('buyer_entitlement.legacy_transfer_skipped', {
			transferId: transfer.id,
			missingTargetUser: !transfer.targetUserId,
			missingCompletedAt: !transfer.completedAt,
		})
		return { status: 'skipped', reason: 'legacy-transfer-incomplete-evidence' }
	}
	return recordHolder({
		purchaseId: transfer.purchaseId,
		userId: transfer.targetUserId,
		grantId: `purchase-transfer:${transfer.id}`,
		occurredAt: new Date(transfer.completedAt).toISOString(),
		policy: 'purchase-transfer',
	})
}

export async function captureTeamSeatBuyerEntitlement(purchaseId: string) {
	const purchase = await db.query.purchases.findFirst({
		where: eq(purchases.id, purchaseId),
	})
	if (!purchase?.userId || !purchase.redeemedBulkCouponId) {
		throw new Error('Buyer entitlement requires a redeemed team seat')
	}
	return recordHolder({
		purchaseId: purchase.id,
		userId: purchase.userId,
		grantId: `team-seat:${purchase.id}`,
		occurredAt: new Date(purchase.createdAt).toISOString(),
		policy: 'team-seat',
	})
}
