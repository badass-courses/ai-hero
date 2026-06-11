import { inngest } from '@/inngest/inngest.server'
import {
	applyPurchaseBenefitEntitlements,
	getBuyerPurchaseBenefits,
	getTeamSeatPurchaseBenefits,
	sendBuyerPurchaseBenefitWelcomeEmail,
	sendTeamSeatRedemptionWelcomeEmail,
} from '@/lib/purchase-benefit-entitlements'
import { log } from '@/server/logger'

import {
	PURCHASE_BENEFITS_ATTACHED_EVENT,
	TEAM_SEAT_REDEMPTION_CREATED_EVENT,
} from '@coursebuilder/core/inngest'

export const buyerPurchaseBenefitFollowup = inngest.createFunction(
	{
		id: 'buyer-purchase-benefit-followup',
		name: 'Buyer Purchase Benefit Followup',
		idempotency: 'event.data.purchaseId',
	},
	{ event: PURCHASE_BENEFITS_ATTACHED_EVENT },
	async ({ event, step }) => {
		const { purchase, benefits } = await step.run(
			'load buyer purchase benefits',
			async () => getBuyerPurchaseBenefits(event.data.purchaseId),
		)

		if (!purchase) throw new Error('purchase not found')
		if (!purchase.userId) throw new Error('purchase missing user')

		if (benefits.length === 0) {
			await step.run('log no buyer benefits', async () => {
				await log.info('purchase_benefit.buyer_followup_noop', {
					purchaseId: event.data.purchaseId,
					userId: event.data.userId,
				})
			})
			return { applied: [], skipped: true }
		}

		const applied = await step.run(
			'apply buyer benefit entitlements',
			async () =>
				applyPurchaseBenefitEntitlements({
					operationalPurchaseId: purchase.id,
					userId: purchase.userId as string,
					benefits,
					source: 'buyer_purchase',
				}),
		)

		const welcomeEmail = await step.run(
			'send buyer benefit welcome email',
			async () =>
				sendBuyerPurchaseBenefitWelcomeEmail({
					purchaseId: purchase.id,
					benefits,
					applicationResults: applied,
				}),
		)

		return { applied, welcomeEmail }
	},
)

export const teamSeatRedemptionBenefitFollowup = inngest.createFunction(
	{
		id: 'team-seat-redemption-benefit-followup',
		name: 'Team Seat Redemption Benefit Followup',
		idempotency: 'event.data.redeemedPurchaseId',
	},
	{ event: TEAM_SEAT_REDEMPTION_CREATED_EVENT },
	async ({ event, step }) => {
		const { redeemedPurchase, bulkCoupon, benefits } = await step.run(
			'load team seat purchase benefits',
			async () =>
				getTeamSeatPurchaseBenefits({
					redeemedPurchaseId: event.data.redeemedPurchaseId,
					bulkCouponId: event.data.bulkCouponId,
				}),
		)

		if (!redeemedPurchase) throw new Error('redeemed purchase not found')
		if (!bulkCoupon) throw new Error('bulk coupon not found')
		if (!redeemedPurchase.userId)
			throw new Error('redeemed purchase missing user')

		const applied =
			benefits.length === 0
				? []
				: await step.run('apply team seat benefit entitlements', async () =>
						applyPurchaseBenefitEntitlements({
							operationalPurchaseId: redeemedPurchase.id,
							userId: redeemedPurchase.userId as string,
							benefits,
							source: 'team_seat_redemption',
						}),
					)

		if (benefits.length === 0) {
			await step.run('log no team seat benefits', async () => {
				await log.info('purchase_benefit.team_seat_followup_noop', {
					redeemedPurchaseId: event.data.redeemedPurchaseId,
					bulkCouponId: event.data.bulkCouponId,
					userId: event.data.userId,
				})
			})
		}

		const welcomeEmail = await step.run(
			'send team seat redemption welcome email',
			async () =>
				sendTeamSeatRedemptionWelcomeEmail({
					redeemedPurchaseId: redeemedPurchase.id,
					bulkCouponId: bulkCoupon.id,
					benefits,
					applicationResults: applied,
				}),
		)

		return { applied, welcomeEmail }
	},
)
