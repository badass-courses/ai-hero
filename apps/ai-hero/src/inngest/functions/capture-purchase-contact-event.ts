import { db } from '@/db'
import {
	coupon as couponTable,
	purchases as purchasesTable,
	users as usersTable,
} from '@/db/schema'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	evergreenCouponIdOf,
	evergreenCouponLogId,
	readEvergreenOfferCoupon,
} from '@/lib/subscriber-marketing/evergreen-offer-purchase'
import {
	writePurchaseRecordedContactEvents,
	type PurchaseRecordedSource,
} from '@/lib/subscriber-marketing/lifecycle-contact-events'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'

import { FULL_PRICE_COUPON_REDEEMED_EVENT } from '@coursebuilder/core/events/commerce'
import { NEW_PURCHASE_CREATED_EVENT } from '@coursebuilder/core/events/commerce'

/**
 * Mirrors every new purchase into the ContactEvent log as purchase.recorded so
 * marketing history replays can see that the contact bought. Runs beside the
 * post-purchase workflow, never inside it: a failure here cannot touch
 * checkout, entitlements, or welcome emails.
 *
 * An evergreen coupon purchase is recorded on the contact the coupon was
 * issued to, not only the buyer's (row 194): that contact's offer is the one
 * still pitching.
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
		// Both loads return hand-picked plain shapes: letting a full Drizzle
		// row type escape step.run makes Inngest's Jsonify walk the entire
		// relational schema type, which pushed the CI typecheck past the
		// default heap limit.
		const purchase = await step.run('load purchase', async () => {
			const row = await db.query.purchases.findFirst({
				where: eq(purchasesTable.id, event.data.purchaseId),
			})
			if (!row) {
				return null
			}
			return {
				id: row.id,
				userId: row.userId ?? null,
				productId: row.productId,
				status: row.status,
				totalAmount: String(row.totalAmount),
				purchasedAt: new Date(row.createdAt).toISOString(),
				evergreenCouponId: evergreenCouponIdOf(row) ?? null,
			}
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
					const row = await db.query.users.findFirst({
						where: eq(usersTable.id, purchase.userId!),
					})
					if (!row) {
						return null
					}
					return { email: row.email ?? null, name: row.name ?? null }
				})
			: null

		const evergreenCouponId = purchase.evergreenCouponId
		const evergreenOffer = evergreenCouponId
			? await step.run('load evergreen coupon', async () => {
					const [row] = await db
						.select()
						.from(couponTable)
						.where(eq(couponTable.id, evergreenCouponId))
						.limit(1)
					return readEvergreenOfferCoupon(evergreenCouponId, row ?? null)
				})
			: null
		if (evergreenOffer?.status === 'refused') {
			// Falls back to the buyer's contact, which is what ran before row 194.
			await log.warn('contact_event.purchase_recorded.evergreen_coupon_refused', {
				purchaseId: purchase.id,
				couponId: evergreenCouponLogId(evergreenOffer.couponId),
				reason: evergreenOffer.reason,
			})
		}

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
			purchasedAt: purchase.purchasedAt,
			...(evergreenOffer?.status === 'redeemed'
				? { evergreenOffer: evergreenOffer.redemption }
				: {}),
		}

		// Only counts and the log string leave the step: the full summary's
		// decisions/written arrays drag Drizzle record types through Jsonify.
		const summary = await step.run(
			'write purchase-recorded contact event',
			async () => {
				const result = await writePurchaseRecordedContactEvents({
					repository: new DrizzleCaptureMarketingRepository(db),
					rows: [source],
				})
				return {
					counts: result.counts,
					identityResolutionPath: result.decisions
						.map((decision) =>
							decision.status === 'eligible'
								? decision.identityResolutionPath
								: decision.reason,
						)
						.join(','),
				}
			},
		)

		await log.info('contact_event.purchase_recorded.captured', {
			purchaseId: purchase.id,
			eventName: event.name,
			written: summary.counts.written,
			skippedByReason: summary.counts.skippedByReason,
			identityResolutionPath: summary.identityResolutionPath,
			evergreenCouponId: evergreenCouponId
				? evergreenCouponLogId(evergreenCouponId)
				: null,
		})

		return {
			status: summary.counts.written > 0 ? 'written' : 'skipped',
			counts: summary.counts,
		}
	},
)
