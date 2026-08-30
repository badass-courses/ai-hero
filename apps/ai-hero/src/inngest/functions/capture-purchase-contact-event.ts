import { db } from '@/db'
import { purchases as purchasesTable, users as usersTable } from '@/db/schema'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	writePurchaseRecordedContactEvents,
	type PurchaseRecordedSource,
} from '@/lib/subscriber-marketing/lifecycle-contact-events'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'

import { FULL_PRICE_COUPON_REDEEMED_EVENT } from '@coursebuilder/core/inngest/commerce/event-full-price-coupon-redeemed'
import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/inngest/commerce/event-new-purchase-created'

/**
 * Mirrors every new purchase into the ContactEvent log as purchase.recorded so
 * marketing history replays can see that the contact bought. Runs beside the
 * post-purchase workflow, never inside it: a failure here cannot touch
 * checkout, entitlements, or welcome emails.
 */
export const capturePurchaseContactEvent = inngest.createFunction(
	{
		id: 'capture-purchase-contact-event',
		name: 'Capture Purchase Contact Event',
		idempotency: 'event.data.purchaseId',
		retries: 3,
	},
	[
		{ event: NEW_PURCHASE_CREATED_EVENT },
		{ event: FULL_PRICE_COUPON_REDEEMED_EVENT },
	],
	async ({ event, step }) => {
		const purchase = await step.run('load purchase', async () => {
			return db.query.purchases.findFirst({
				where: eq(purchasesTable.id, event.data.purchaseId),
			})
		})
		if (!purchase) {
			await log.warn('contact_event.purchase_recorded.purchase_missing', {
				purchaseId: event.data.purchaseId,
				eventName: event.name,
			})
			return { status: 'skipped', reason: 'purchase-not-found' }
		}

		const user = purchase.userId
			? await step.run('load user', async () => {
					return db.query.users.findFirst({
						where: eq(usersTable.id, purchase.userId!),
					})
				})
			: null

		const source: PurchaseRecordedSource = {
			purchaseId: purchase.id,
			userId: purchase.userId,
			email:
				user?.email ??
				('customerEmail' in event.data ? event.data.customerEmail : null),
			name: user?.name,
			productId: purchase.productId,
			status: purchase.status,
			totalAmount: purchase.totalAmount,
			purchasedAt: new Date(purchase.createdAt).toISOString(),
		}

		const summary = await step.run(
			'write purchase-recorded contact event',
			async () => {
				return writePurchaseRecordedContactEvents({
					repository: new DrizzleCaptureMarketingRepository(db),
					rows: [source],
				})
			},
		)

		await log.info('contact_event.purchase_recorded.captured', {
			purchaseId: purchase.id,
			eventName: event.name,
			written: summary.counts.written,
			skippedByReason: summary.counts.skippedByReason,
			identityResolutionPath: summary.decisions
				.map((decision) =>
					decision.status === 'eligible'
						? decision.identityResolutionPath
						: decision.reason,
				)
				.join(','),
		})

		return {
			status: summary.counts.written > 0 ? 'written' : 'skipped',
			counts: summary.counts,
		}
	},
)
