import 'server-only'

import { pricingFactsSourceLayer } from '@/app/api/front-desk/pricing-facts-source'
import {
	existingSeatsFact,
	PricingFactsSource,
} from '@/app/api/front-desk/pricing-facts'
import { hooks as frontDeskHooks } from '@/app/api/front-desk/hooks'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter, db } from '@/db'
import { purchases } from '@/db/schema'
import BasicEmail from '@/emails/basic-email'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'
import { sendAnEmail } from '@coursebuilder/utils/send-an-email'
import { Ratelimit } from '@upstash/ratelimit'
import { count, eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { formatPricesForProduct } from '@coursebuilder/commerce'
import type { StripePaymentAdapter } from '@coursebuilder/commerce/stripe-provider'

import type { TeamInvoiceDeps, TeamInvoiceProduct } from './create-team-invoice'
import type { TeamInvoiceResult } from './schema'
import { createAndSendTeamInvoice } from './stripe-team-invoice'
import {
	appBulkPriceSource,
	frontDeskPriceSource,
	teamInvoicingEnabled,
	teamPriceSourceFor,
	type TeamPriceSource,
} from './team-price-source'

const stripe = () =>
	(stripeProvider.options.paymentsAdapter as StripePaymentAdapter).stripe

/** front-desk prices C5 only when both its URL and its pricing token are set. */
export const frontDeskPricingConfigured = () =>
	Boolean(env.FRONT_DESK_URL && env.FRONT_DESK_PRICING_TOKEN)

/** Whether the page should offer "Pay by invoice" for this product. */
export const isTeamInvoicingEnabled = (productId: string) =>
	teamInvoicingEnabled(productId, frontDeskPricingConfigured())

const appBulk: TeamPriceSource = appBulkPriceSource({
	formatPrice: (request) =>
		formatPricesForProduct({
			productId: request.productId,
			quantity: request.quantity,
			// The buyer's own bulk purchase counts toward the ladder, exactly as
			// checkout counts it. No site coupon, no PPP: a team rule only.
			userId: request.userId,
			autoApplyPPP: false,
			ctx: courseBuilderAdapter,
		}),
	stripeCouponIdFor: async (merchantCouponId) =>
		(await courseBuilderAdapter.getMerchantCoupon(merchantCouponId))
			?.identifier ?? null,
})

const frontDesk = (): TeamPriceSource | null =>
	frontDeskPricingConfigured()
		? frontDeskPriceSource({
				url: env.FRONT_DESK_URL!,
				token: env.FRONT_DESK_PRICING_TOKEN!,
			})
		: null

async function loadProduct(
	productId: string,
): Promise<TeamInvoiceProduct | null> {
	const [product, merchantPrice, merchantProduct, purchaseCount] =
		await Promise.all([
			courseBuilderAdapter.getProduct(productId),
			courseBuilderAdapter.getMerchantPriceForProductId(productId),
			courseBuilderAdapter.getMerchantProductForProductId(productId),
			db
				.select({ count: count() })
				.from(purchases)
				.where(eq(purchases.productId, productId))
				.then((rows) => rows[0]?.count ?? 0),
		])
	if (!product || !merchantPrice?.identifier || !merchantProduct?.identifier) {
		return null
	}
	// The invoice line is the Stripe price, so its amount is the list price
	// the discount works from, not the app's copy of it.
	const stripePrice = await stripe().prices.retrieve(merchantPrice.identifier)
	if (
		!stripePrice.active ||
		stripePrice.currency !== 'usd' ||
		stripePrice.type !== 'one_time' ||
		typeof stripePrice.unit_amount !== 'number'
	) {
		return null
	}
	return {
		product: {
			...product,
			quantityAvailable: product.quantityAvailable,
		},
		purchaseCount,
		stripePriceId: merchantPrice.identifier,
		stripeProductId: merchantProduct.identifier,
		listUnitAmount: stripePrice.unit_amount,
	}
}

/** The same existing-seats count front-desk's pricing facts report. */
async function buyer(email: string, productId: string) {
	const program = Effect.gen(function* () {
		const source = yield* PricingFactsSource
		const user = yield* source.userByEmail(email)
		if (!user) return { existingSeats: 0 }
		const rows = yield* source.purchases(user.id, [productId])
		const fact = existingSeatsFact(rows, productId, `ai-hero:user:${user.id}`)
		return 'value' in fact
			? { existingSeats: fact.value, userId: user.id }
			: null
	})
	return Effect.runPromise(
		program.pipe(
			Effect.provide(
				pricingFactsSourceLayer({
					chargeState: (id) => frontDeskHooks.chargeState(id),
					stripe: stripe(),
				}),
			),
			Effect.catchAll(() => Effect.succeed(null)),
		),
	)
}

const ipLimit = () =>
	new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(5, '24 h'),
		prefix: 'team_invoice_ip',
	})
const emailLimit = () =>
	new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(3, '24 h'),
		prefix: 'team_invoice_email',
	})

const RESULT_TTL_SECONDS = 2 * 24 * 60 * 60
const LOCK_TTL_SECONDS = 120

export function teamInvoiceServerDeps(): TeamInvoiceDeps {
	return {
		now: () => new Date(),
		rateLimit: async ({ ip, email }) => {
			const [byIp, byEmail] = await Promise.all([
				ipLimit().limit(ip),
				emailLimit().limit(email),
			])
			return byIp.success && byEmail.success
		},
		idempotency: {
			get: (orderKey) => redis.get<TeamInvoiceResult>(`${orderKey}:result`),
			lock: async (orderKey) =>
				(await redis.set(`${orderKey}:lock`, '1', {
					nx: true,
					ex: LOCK_TTL_SECONDS,
				})) === 'OK',
			unlock: async (orderKey) => {
				await redis.del(`${orderKey}:lock`)
			},
			set: async (orderKey, result) => {
				await redis.set(`${orderKey}:result`, result, {
					ex: RESULT_TTL_SECONDS,
				})
			},
		},
		loadProduct,
		buyer,
		priceSource: (productId) =>
			teamPriceSourceFor(productId, { appBulk, frontDesk: frontDesk() }),
		invoicingEnabled: isTeamInvoicingEnabled,
		createInvoice: (input) => createAndSendTeamInvoice(stripe(), input),
		forwardRequest: async (request, context) => {
			const body = `
      Invoice request (not sent automatically: ${context.reason})
      Product: ${context.productName ?? request.productId} (${request.productId})
      Seats: ${request.seats}
      Company: ${request.companyName}
      Billing email: ${request.billingEmail}
      Terms: ${request.terms}
      PO: ${request.poNumber ?? 'none'}
      Tax ID: ${request.taxId ?? 'none'}
      Address: ${
				request.address?.line1
					? [
							request.address.line1,
							request.address.line2,
							request.address.city,
							request.address.state,
							request.address.postalCode,
							request.address.country,
						]
							.filter(Boolean)
							.join(', ')
					: 'none'
			}
      Page: ${context.location ?? 'N/A'}
    `
			await sendAnEmail({
				Component: BasicEmail,
				componentProps: { body, messageType: 'transactional' },
				Subject: `Team invoice request: ${request.companyName} (${request.seats} seats)`,
				To: env.NEXT_PUBLIC_SUPPORT_EMAIL,
				ReplyTo: request.billingEmail,
				type: 'transactional',
			})
		},
		log: (event, data) => log.info(event, data),
	}
}
