import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter, db } from '@/db'
import { merchantCoupon as merchantCouponTable } from '@/db/schema'
import { log } from '@/server/logger'
import { and, eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'

// Not a 'use server' module: an export here must never become a client-callable
// server action, because it creates Stripe coupons without checking a session.
// Callers authorize first (admin coupon form, /api/support/coupons).

/**
 * Creates a merchant coupon in Stripe and the database if it doesn't exist (percentage-based)
 * @param percentageDiscount - The percentage discount as a decimal (e.g., 0.25 for 25%)
 * @param isSpecialCredit - Whether this is a special credit coupon (true) or regular special coupon (false)
 * @returns The merchant coupon ID
 */
export async function createOrFindMerchantCoupon(
	percentageDiscount: number,
	isSpecialCredit: boolean = false,
): Promise<string | null> {
	if (percentageDiscount >= 1) {
		return null
	}

	const percentageForStripe = Math.floor(percentageDiscount * 100)
	const couponType = isSpecialCredit ? 'special credit' : 'special'

	const existingMerchantCoupon = await db.query.merchantCoupon.findFirst({
		where: and(
			eq(merchantCouponTable.percentageDiscount, percentageDiscount.toString()),
			eq(merchantCouponTable.type, couponType),
		),
	})

	if (existingMerchantCoupon) {
		await log.info('coupon.merchant_coupon.found', {
			merchantCouponId: existingMerchantCoupon.id,
			percentageDiscount: percentageDiscount.toString(),
		})
		return existingMerchantCoupon.id
	}

	const merchantAccountRecord = await courseBuilderAdapter.getMerchantAccount({
		provider: 'stripe',
	})
	if (!merchantAccountRecord) {
		await log.error('coupon.merchant_coupon.no_account', {
			percentageDiscount: percentageDiscount.toString(),
		})
		throw new Error('No merchant account found')
	}

	try {
		// Create the coupon in Stripe
		const couponName = isSpecialCredit
			? `special credit ${percentageForStripe}%`
			: `special ${percentageForStripe}%`
		const stripeCouponId =
			await stripeProvider.options.paymentsAdapter.createCoupon({
				duration: 'forever',
				name: couponName,
				percent_off: percentageForStripe,
				metadata: {
					type: 'special',
				},
			})

		// Create the merchant coupon in the database
		const merchantCouponId = `ai_${uuidv4()}`
		await db.insert(merchantCouponTable).values({
			id: merchantCouponId,
			merchantAccountId: merchantAccountRecord.id,
			status: 1,
			identifier: stripeCouponId,
			percentageDiscount: percentageDiscount.toString(),
			type: couponType,
		})

		await log.info('coupon.merchant_coupon.created', {
			merchantCouponId,
			stripeCouponId,
			percentageDiscount: percentageDiscount.toString(),
		})

		return merchantCouponId
	} catch (error) {
		await log.error('coupon.merchant_coupon.creation_failed', {
			percentageDiscount: percentageDiscount.toString(),
			error: error instanceof Error ? error.message : 'Unknown error',
		})
		throw error
	}
}
