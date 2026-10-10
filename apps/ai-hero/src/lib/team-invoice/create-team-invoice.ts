import { createHash } from 'node:crypto'

import {
	REQUESTABLE_REASONS,
	teamSaleState,
	type TeamSaleProduct,
} from './sale-state'
import {
	DAYS_UNTIL_DUE,
	TEAM_INVOICE_MAX_SEATS,
	teamInvoiceSchema,
	type TeamInvoiceFormInput,
	type TeamInvoiceRequest,
	type TeamInvoiceResult,
} from './schema'
import {
	TeamInvoiceTotalMismatch,
	type CreateTeamInvoiceInput,
	type CreatedTeamInvoice,
} from './stripe-team-invoice'
import type { TeamPriceSource } from './team-price-source'

/** `source` on every self-serve invoice, read by fulfillment and support. */
export const SELF_SERVE_TEAM_INVOICE_SOURCE = 'self_serve_team_invoice'

/** Faster than this is a script, not a person filling in billing details. */
const MIN_FILL_MS = 3_000
/** Older than this, the page is stale; ask for a reload. */
const MAX_FILL_MS = 60 * 60 * 1000

export type TeamInvoiceProduct = {
	product: TeamSaleProduct & { name?: string; fields?: TeamSaleProduct['fields'] & { slug?: string | null } }
	purchaseCount: number
	stripePriceId: string
	stripeProductId: string
	/** Retail per-seat price in cents, read from the Stripe price. */
	listUnitAmount: number
}

export type TeamInvoiceDeps = {
	now: () => Date
	/** True when every key is under its limit. */
	rateLimit: (keys: { ip: string; email: string }) => Promise<boolean>
	idempotency: {
		get: (orderKey: string) => Promise<TeamInvoiceResult | null>
		/** False when another request holds the order. */
		lock: (orderKey: string) => Promise<boolean>
		unlock: (orderKey: string) => Promise<void>
		set: (orderKey: string, result: TeamInvoiceResult) => Promise<void>
	}
	loadProduct: (productId: string) => Promise<TeamInvoiceProduct | null>
	/**
	 * Bulk seats this email already bought for the product, plus the app user.
	 * Null when the count is not knowable; the order then fails closed.
	 */
	buyer: (
		email: string,
		productId: string,
	) => Promise<{ existingSeats: number; userId?: string } | null>
	priceSource: (productId: string) => TeamPriceSource
	invoicingEnabled: (productId: string) => boolean
	createInvoice: (input: CreateTeamInvoiceInput) => Promise<CreatedTeamInvoice>
	/** Hands an order the app cannot invoice yet to support, by email. */
	forwardRequest: (
		request: TeamInvoiceRequest,
		context: { productName?: string; reason: string; location?: string },
	) => Promise<void>
	log: (event: string, data: Record<string, unknown>) => Promise<void> | void
	/** Extra invoice metadata, e.g. the sandbox rig labels. */
	extraMetadata?: Record<string, string>
}

/** One order per billing email, product, seat count and UTC day. */
export function teamInvoiceOrderKey(
	request: Pick<TeamInvoiceRequest, 'billingEmail' | 'productId' | 'seats'>,
	now: Date,
): string {
	const day = now.toISOString().slice(0, 10)
	const digest = createHash('sha256')
		.update(
			[request.billingEmail.toLowerCase(), request.productId, request.seats, day].join(
				'|',
			),
		)
		.digest('hex')
		.slice(0, 32)
	return `team-invoice-${digest}`
}

export function teamInvoiceMetadata(input: {
	request: TeamInvoiceRequest
	product: TeamInvoiceProduct
	orderKey: string
	policy: string
	priceSource: string
	extra?: Record<string, string>
}): Record<string, string> {
	const { request, product } = input
	return {
		...input.extra,
		source: SELF_SERVE_TEAM_INVOICE_SOURCE,
		medium: 'team_invoice',
		campaign: 'team_sale',
		app: 'ai-hero',
		productId: product.product.id,
		...(product.product.fields?.slug
			? { productSlug: product.product.fields.slug }
			: {}),
		seats: String(request.seats),
		companyName: request.companyName,
		terms: request.terms,
		policy: input.policy,
		priceSource: input.priceSource,
		orderKey: input.orderKey,
		...(request.poNumber ? { poNumber: request.poNumber } : {}),
	}
}

const firstIssue = (error: { issues: { message: string }[] }) =>
	error.issues[0]?.message ?? 'Check the form and try again'

/**
 * The self-serve team invoice, end to end: bot checks, validation, rate
 * limit, the product's sale state, idempotency, the team price, then one
 * Stripe invoice. Every failure is closed: no price, no invoice.
 */
export async function createTeamInvoice(
	input: TeamInvoiceFormInput & { location?: string },
	context: { ip: string },
	deps: TeamInvoiceDeps,
): Promise<TeamInvoiceResult> {
	const now = deps.now()
	const email = String(input.billingEmail ?? '').trim().toLowerCase()

	// Bots get the answer they expect and nothing else, as the inquiry form does.
	if (input.website) {
		await deps.log('team_invoice.spam.honeypot', { ip: context.ip })
		return { kind: 'sent', email }
	}
	const elapsed = now.getTime() - new Date(input.timestamp).getTime()
	if (!(elapsed >= MIN_FILL_MS)) {
		await deps.log('team_invoice.spam.timing', { ip: context.ip, elapsed })
		return { kind: 'sent', email }
	}
	if (elapsed > MAX_FILL_MS) {
		return {
			kind: 'invalid',
			message: 'This form is out of date. Reload the page and try again.',
		}
	}

	if (Number(input.seats) > TEAM_INVOICE_MAX_SEATS) return { kind: 'contact-us' }
	const parsed = teamInvoiceSchema.safeParse(input)
	if (!parsed.success) {
		return { kind: 'invalid', message: firstIssue(parsed.error) }
	}
	const request = parsed.data

	if (!(await deps.rateLimit({ ip: context.ip, email: request.billingEmail }))) {
		await deps.log('team_invoice.ratelimited', { ip: context.ip })
		return { kind: 'rate-limited' }
	}

	const product = await deps.loadProduct(request.productId)
	if (!product) return { kind: 'not-on-sale' }

	const sale = teamSaleState(product.product, {
		now,
		purchaseCount: product.purchaseCount,
		seats: request.seats,
	})
	const forward = async (reason: string): Promise<TeamInvoiceResult> => {
		await deps.forwardRequest(request, {
			productName: product.product.name,
			reason,
			location: input.location,
		})
		await deps.log('team_invoice.requested', {
			productId: request.productId,
			seats: request.seats,
			reason,
		})
		return {
			kind: 'requested',
			email: request.billingEmail,
			when: reason === 'invoicing-disabled' ? 'working-day' : 'seats-open',
		}
	}
	if (!sale.onSale) {
		// No invoice for a product that is not on sale. An upcoming one still
		// takes the request, so the buyer is first in line when seats open.
		return REQUESTABLE_REASONS.has(sale.reason)
			? forward(sale.reason)
			: { kind: 'not-on-sale' }
	}
	if (!deps.invoicingEnabled(request.productId)) {
		return forward('invoicing-disabled')
	}

	const orderKey = teamInvoiceOrderKey(request, now)
	const previous = await deps.idempotency.get(orderKey)
	if (previous) return previous
	if (!(await deps.idempotency.lock(orderKey))) return { kind: 'error' }

	try {
		const buyer = await deps.buyer(request.billingEmail, request.productId)
		if (!buyer) {
			await deps.log('team_invoice.price_unavailable', {
				productId: request.productId,
				reason: 'existing-seats-unknown',
			})
			return { kind: 'price-unavailable' }
		}

		const price = await deps.priceSource(request.productId).price({
			productId: request.productId,
			quantity: request.seats,
			existingSeats: buyer.existingSeats,
			listUnitAmount: product.listUnitAmount,
			userId: buyer.userId,
		})
		if (price.kind !== 'priced') {
			await deps.log('team_invoice.price_unavailable', {
				productId: request.productId,
				reason: price.reason,
			})
			return { kind: 'price-unavailable' }
		}

		const invoice = await deps.createInvoice({
			orderKey,
			billingEmail: request.billingEmail,
			companyName: request.companyName,
			address: request.address,
			taxId: request.taxId,
			poNumber: request.poNumber,
			daysUntilDue: DAYS_UNTIL_DUE[request.terms],
			stripePriceId: product.stripePriceId,
			stripeProductId: product.stripeProductId,
			quantity: request.seats,
			discount: price.discount,
			expectedTotal: price.amount,
			metadata: teamInvoiceMetadata({
				request,
				product,
				orderKey,
				policy: price.policy,
				priceSource: price.source,
				extra: deps.extraMetadata,
			}),
		})

		const result: TeamInvoiceResult = {
			kind: 'sent',
			email: request.billingEmail,
		}
		await deps.idempotency.set(orderKey, result)
		await deps.log('team_invoice.sent', {
			productId: request.productId,
			seats: request.seats,
			invoiceId: invoice.invoiceId,
			total: invoice.total,
			policy: price.policy,
		})
		return result
	} catch (error) {
		if (error instanceof TeamInvoiceTotalMismatch) {
			await deps.log('team_invoice.total_mismatch', {
				invoiceId: error.invoiceId,
				expected: error.expected,
				actual: error.actual,
			})
			return { kind: 'price-unavailable' }
		}
		await deps.log('team_invoice.error', {
			productId: request.productId,
			message: error instanceof Error ? error.message : String(error),
		})
		return { kind: 'error' }
	} finally {
		await deps.idempotency.unlock(orderKey)
	}
}
