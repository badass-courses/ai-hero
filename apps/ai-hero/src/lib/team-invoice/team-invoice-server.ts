import 'server-only'

import { randomBytes } from 'node:crypto'

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

import {
	CONFIRM_TTL_SECONDS,
	SELF_SERVE_TEAM_INVOICE_SOURCE,
	type PendingTeamInvoice,
	type TeamInvoiceDeps,
	type TeamInvoiceProduct,
} from './create-team-invoice'
import type { TeamInvoiceResult } from './schema'
import { createAndSendTeamInvoice } from './stripe-team-invoice'
import type { OpenTeamInvoice } from './team-invoice-expiry'
import {
	appBulkPriceSource,
	frontDeskPriceSource,
	teamInvoicingEnabled,
	teamPriceSourceFor,
	type DefaultSaleCoupon,
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

/** The site-wide sale checkout applies on its own, or null. */
async function defaultSaleCoupon(
	productId: string,
): Promise<DefaultSaleCoupon | null> {
	const result = await courseBuilderAdapter.getDefaultCoupon([productId])
	const merchantCoupon = result?.defaultMerchantCoupon
	const stripeCouponId = merchantCoupon?.identifier
	if (!result || !merchantCoupon || !stripeCouponId) return null
	return {
		merchantCouponId: merchantCoupon.id,
		couponId: result.defaultCoupon.id,
		stripeCouponId,
		percentageDiscount: merchantCoupon.percentageDiscount
			? Number(merchantCoupon.percentageDiscount)
			: null,
		amountDiscount: merchantCoupon.amountDiscount ?? null,
	}
}

const appBulk: TeamPriceSource = appBulkPriceSource({
	formatPrice: (request, sale) =>
		formatPricesForProduct({
			productId: request.productId,
			quantity: request.quantity,
			// The buyer's own bulk purchase counts toward the ladder, and the
			// default sale is in play, exactly as checkout and the team card
			// count them. No PPP: a team invoice is not a regional price.
			userId: request.userId,
			...(sale
				? { merchantCouponId: sale.merchantCouponId, usedCouponId: sale.couponId }
				: {}),
			autoApplyPPP: false,
			ctx: courseBuilderAdapter,
		}),
	stripeCouponIdFor: async (merchantCouponId) =>
		(await courseBuilderAdapter.getMerchantCoupon(merchantCouponId))
			?.identifier ?? null,
	defaultSaleCoupon,
})

const frontDesk = (): TeamPriceSource | null =>
	frontDeskPricingConfigured()
		? frontDeskPriceSource({
				url: env.FRONT_DESK_URL!,
				token: env.FRONT_DESK_PRICING_TOKEN!,
			})
		: null

const OPEN_SELF_SERVE_QUERY = `status:'open' AND metadata['source']:'${SELF_SERVE_TEAM_INVOICE_SOURCE}' AND metadata['app']:'ai-hero'`

/**
 * Open self-serve team invoices, from Stripe's search. Search lags writes by
 * about a minute, so a hold can be that late; the expiry job is the backstop.
 */
export async function openTeamInvoices(
	productId?: string,
): Promise<OpenTeamInvoice[]> {
	const query = productId
		? `${OPEN_SELF_SERVE_QUERY} AND metadata['productId']:'${productId.replace(/[^\w-]/g, '')}'`
		: OPEN_SELF_SERVE_QUERY
	const invoices = await stripe()
		.invoices.search({ query, limit: 100 })
		.autoPagingToArray({ limit: 500 })
	return invoices.flatMap((invoice) => {
		const seats = Number(invoice.metadata?.seats)
		const id = invoice.metadata?.productId
		return id && Number.isInteger(seats) && seats > 0
			? [{ id: invoice.id, productId: id, seats }]
			: []
	})
}

export async function loadProduct(
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
	// Only a limited product needs its open invoices counted.
	const limited = (product.quantityAvailable ?? -1) >= 0
	const heldSeats = limited
		? (await openTeamInvoices(productId)).reduce(
				(sum, invoice) => sum + invoice.seats,
				0,
			)
		: 0
	return {
		product: {
			...product,
			quantityAvailable: product.quantityAvailable,
		},
		purchaseCount,
		heldSeats,
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

/**
 * Site-wide ceilings per UTC day. Per-IP and per-email limits cap one sender
 * and one inbox; these cap everyone, so rotating addresses cannot run up an
 * unbounded number of confirm emails or invoices.
 */
export const TEAM_INVOICE_DAILY_CEILINGS = {
	confirmation: 60,
	invoice: 20,
} as const

async function dailyCeiling(
	kind: keyof typeof TEAM_INVOICE_DAILY_CEILINGS,
): Promise<boolean> {
	const day = new Date().toISOString().slice(0, 10)
	const key = `team_invoice_ceiling:${kind}:${day}`
	const used = await redis.incr(key)
	if (used === 1) await redis.expire(key, 2 * 24 * 60 * 60)
	if (used <= TEAM_INVOICE_DAILY_CEILINGS[kind]) return true
	// Tell support once a day, the first time it trips.
	const alerted = await redis.set(`${key}:alerted`, '1', {
		nx: true,
		ex: 2 * 24 * 60 * 60,
	})
	if (alerted === 'OK') {
		await log.warn('team_invoice.ceiling_reached', { kind, day })
		await sendAnEmail({
			Component: BasicEmail,
			componentProps: {
				body: `The self-serve team invoice ceiling for ${kind === 'invoice' ? 'invoices' : 'confirm emails'} (${TEAM_INVOICE_DAILY_CEILINGS[kind]} a day) was reached on ${day}. New requests get "too many requests" until tomorrow (UTC). Check the logs for team_invoice events.`,
				messageType: 'transactional',
			},
			Subject: `Team invoice ceiling reached: ${kind}`,
			To: env.NEXT_PUBLIC_SUPPORT_EMAIL,
			type: 'transactional',
		}).catch(() => undefined)
	}
	return false
}

const pendingKey = (token: string) => `team_invoice_pending:${token}`

/** The confirm page for a token. A path segment, so it stays out of query logs. */
export const teamInvoiceConfirmUrl = (token: string) =>
	new URL(`/team-invoice/confirm/${token}`, env.NEXT_PUBLIC_URL).toString()

export function teamInvoiceServerDeps(): TeamInvoiceDeps {
	return {
		now: () => new Date(),
		dailyCeiling,
		pending: {
			put: async (token, order) => {
				await redis.set(pendingKey(token), order, { ex: CONFIRM_TTL_SECONDS })
			},
			get: (token) =>
				/^[\w-]{32,64}$/.test(token)
					? redis.get<PendingTeamInvoice>(pendingKey(token))
					: Promise.resolve(null),
		},
		newToken: () => randomBytes(32).toString('base64url'),
		sendConfirmation: async ({ to, productName, seats, token }) => {
			// Only our own words, the product's name and a number: nothing the
			// requester typed reaches their inbox.
			const body = [
				`Someone asked us to send an invoice for **${seats} seats** of **${productName}** to this address.`,
				`[Confirm and send the invoice](${teamInvoiceConfirmUrl(token)})`,
				`The link works for 30 minutes. If you did not ask for this, ignore this email and nothing is sent.`,
			].join('\n\n')
			await sendAnEmail({
				Component: BasicEmail,
				componentProps: {
					body,
					preview: 'Confirm your team invoice',
					messageType: 'transactional',
				},
				Subject: 'Confirm your AI Hero team invoice',
				To: to,
				type: 'transactional',
			})
		},
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
