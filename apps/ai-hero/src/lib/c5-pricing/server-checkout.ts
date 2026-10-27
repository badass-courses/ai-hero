import 'server-only'

import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { db } from '@/db'
import { merchantCustomer } from '@/db/schema'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'

import type { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'

import { expireOlderOpenSiblings } from './checkout-siblings'

const stripe = () =>
	(stripeProvider.options.paymentsAdapter as StripePaymentAdapter).stripe

/**
 * After a C5 Checkout Session is created for a signed-in buyer, expire their
 * older open C5 sessions. Best effort: a failure is logged and the new
 * checkout proceeds, because the post-payment duplicate check is the backstop.
 */
export async function expireC5SiblingSessions({
	userId,
	productId,
	keepSessionId,
}: {
	userId: string
	productId: string
	keepSessionId: string
}) {
	try {
		const customers = await db
			.select({ identifier: merchantCustomer.identifier })
			.from(merchantCustomer)
			.where(eq(merchantCustomer.userId, userId))
		const result = await expireOlderOpenSiblings({
			sessions: {
				retrieve: (id) => stripe().checkout.sessions.retrieve(id),
				listOpen: async (customer) =>
					(
						await stripe().checkout.sessions.list({
							customer,
							status: 'open',
							limit: 100,
						})
					).data,
				expire: (id) => stripe().checkout.sessions.expire(id),
			},
			customerIds: customers
				.map((row) => row.identifier)
				.filter((id): id is string => Boolean(id?.startsWith('cus_'))),
			userId,
			productId,
			keepSessionId,
		})
		if (result.expired.length || result.failed.length)
			await log.info('c5.checkout.siblings_expired', {
				userId,
				keepSessionId,
				...result,
			})
		return result
	} catch (error) {
		await log.warn('c5.checkout.sibling_expiry_failed', {
			userId,
			keepSessionId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}
