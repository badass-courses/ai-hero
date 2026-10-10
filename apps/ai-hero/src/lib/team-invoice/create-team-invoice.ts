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
	type TeamInvoiceTerms,
} from './schema'
import {
	TeamInvoiceTotalMismatch,
	type CreateTeamInvoiceInput,
	type CreatedTeamInvoice,
	type TeamInvoiceDue,
} from './stripe-team-invoice'
import type { TeamPriceSource } from './team-price-source'

/** `source` on every self-serve invoice, read by fulfillment and support. */
export const SELF_SERVE_TEAM_INVOICE_SOURCE = 'self_serve_team_invoice'

/** Faster than this is a script, not a person filling in billing details. */
const MIN_FILL_MS = 3_000
/** Older than this, the page is stale; ask for a reload. */
const MAX_FILL_MS = 60 * 60 * 1000
/** How long the emailed confirm link works. */
export const CONFIRM_TTL_SECONDS = 30 * 60
const DAY_MS = 24 * 60 * 60 * 1000

export type TeamInvoiceProduct = {
	product: TeamSaleProduct & {
		name?: string
		fields?: TeamSaleProduct['fields'] & { slug?: string | null }
	}
	purchaseCount: number
	/**
	 * Seats on open self-serve invoices for a limited product. They count
	 * against what is left, so open invoices cannot oversell it together.
	 */
	heldSeats: number
	stripePriceId: string
	stripeProductId: string
	/** Retail per-seat price in cents, read from the Stripe price. */
	listUnitAmount: number
}

/** A validated order waiting for its billing email's owner to confirm it. */
export type PendingTeamInvoice = {
	request: TeamInvoiceRequest
	location?: string
	/** ISO time the order was started; its UTC day is part of the order key. */
	startedAt: string
}

export type TeamInvoiceDeps = {
	now: () => Date
	/** True when every key is under its limit. */
	rateLimit: (keys: { ip: string; email: string }) => Promise<boolean>
	/**
	 * Site-wide daily ceilings, on confirm emails and on invoices. False when
	 * the ceiling is reached; the server tells support the first time a day.
	 */
	dailyCeiling: (kind: 'confirmation' | 'invoice') => Promise<boolean>
	pending: {
		put: (token: string, order: PendingTeamInvoice) => Promise<void>
		get: (token: string) => Promise<PendingTeamInvoice | null>
	}
	/** An unguessable confirm token. */
	newToken: () => string
	/**
	 * Emails the billing address a link to confirm. Carries the product name,
	 * the seat count and the link, never a word the requester wrote.
	 */
	sendConfirmation: (input: {
		to: string
		productName: string
		seats: number
		token: string
	}) => Promise<void>
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

/**
 * One order per whole request and UTC day. Every field is in the hash, so an
 * exact resubmit is the same order and a corrected one is a new order.
 */
export function teamInvoiceOrderKey(
	request: TeamInvoiceRequest,
	startedAt: Date,
): string {
	const normalized = {
		productId: request.productId,
		billingEmail: request.billingEmail.toLowerCase(),
		seats: request.seats,
		companyName: request.companyName,
		address: request.address ?? null,
		taxId: request.taxId ?? null,
		poNumber: request.poNumber ?? null,
		terms: request.terms,
		day: startedAt.toISOString().slice(0, 10),
	}
	const digest = createHash('sha256')
		.update(JSON.stringify(normalized))
		.digest('hex')
		.slice(0, 32)
	return `team-invoice-${digest}`
}

/**
 * When the invoice falls due. A cohort or live product's invoice falls due by
 * the time enrollment closes, so it cannot be paid on terms that outlast the
 * window. Inside the last day it is due on receipt, and the expiry job voids
 * whatever is still open when the window shuts.
 */
export function teamInvoiceDue(
	terms: TeamInvoiceTerms,
	product: TeamSaleProduct,
	now: Date,
): TeamInvoiceDue {
	const days = DAYS_UNTIL_DUE[terms]
	const closes = product.fields?.closeEnrollment
		? new Date(product.fields.closeEnrollment)
		: null
	const windowed = product.type === 'cohort' || product.type === 'live'
	if (!windowed || !closes || days === 0) return { kind: 'days', days }
	if (now.getTime() + days * DAY_MS <= closes.getTime()) {
		return { kind: 'days', days }
	}
	if (closes.getTime() - now.getTime() < DAY_MS) return { kind: 'days', days: 0 }
	return { kind: 'date', at: Math.floor(closes.getTime() / 1000) }
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

/** Forwards an order to support and says so. */
async function forwardToSupport(
	deps: TeamInvoiceDeps,
	request: TeamInvoiceRequest,
	product: TeamInvoiceProduct,
	reason: string,
	location?: string,
): Promise<TeamInvoiceResult> {
	await deps.forwardRequest(request, {
		productName: product.product.name,
		reason,
		location,
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

const saleStateFor = (
	product: TeamInvoiceProduct,
	seats: number,
	now: Date,
) =>
	teamSaleState(product.product, {
		now,
		purchaseCount: product.purchaseCount + product.heldSeats,
		seats,
	})

/**
 * Step one of a self-serve team invoice: bot checks, validation, rate
 * limits, the product's sale state, then a confirm link to the billing
 * email. Nothing reaches Stripe here. Only the email's owner, by clicking,
 * turns the order into an invoice (`confirmTeamInvoice`).
 */
export async function startTeamInvoice(
	input: TeamInvoiceFormInput & { location?: string },
	context: { ip: string },
	deps: TeamInvoiceDeps,
): Promise<TeamInvoiceResult> {
	const now = deps.now()
	const email = String(input.billingEmail ?? '').trim().toLowerCase()

	// Bots get the answer they expect and nothing else, as the inquiry form does.
	if (input.website) {
		await deps.log('team_invoice.spam.honeypot', { ip: context.ip })
		return { kind: 'confirm-sent', email }
	}
	const elapsed = now.getTime() - new Date(input.timestamp).getTime()
	if (!(elapsed >= MIN_FILL_MS)) {
		await deps.log('team_invoice.spam.timing', { ip: context.ip, elapsed })
		return { kind: 'confirm-sent', email }
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

	const sale = saleStateFor(product, request.seats, now)
	if (!sale.onSale) {
		// No invoice for a product that is not on sale. An upcoming one still
		// takes the request, so the buyer is first in line when seats open.
		return REQUESTABLE_REASONS.has(sale.reason)
			? forwardToSupport(deps, request, product, sale.reason, input.location)
			: { kind: 'not-on-sale' }
	}
	if (!deps.invoicingEnabled(request.productId)) {
		return forwardToSupport(
			deps,
			request,
			product,
			'invoicing-disabled',
			input.location,
		)
	}

	if (!(await deps.dailyCeiling('confirmation'))) {
		await deps.log('team_invoice.ceiling', { kind: 'confirmation' })
		return { kind: 'rate-limited' }
	}

	const token = deps.newToken()
	await deps.pending.put(token, {
		request,
		location: input.location,
		startedAt: now.toISOString(),
	})
	await deps.sendConfirmation({
		to: request.billingEmail,
		productName: product.product.name ?? 'AI Hero',
		seats: request.seats,
		token,
	})
	await deps.log('team_invoice.confirm_sent', {
		productId: request.productId,
		seats: request.seats,
	})
	return { kind: 'confirm-sent', email: request.billingEmail }
}

/**
 * Step two, run when the billing email's owner confirms: the product's sale
 * state again, idempotency, the team price, then one Stripe invoice. Every
 * failure is closed: no price, no invoice. A second confirm of the same order
 * returns the first answer.
 */
export async function confirmTeamInvoice(
	token: string,
	deps: TeamInvoiceDeps,
): Promise<TeamInvoiceResult> {
	const pending = token ? await deps.pending.get(token) : null
	if (!pending) return { kind: 'expired' }
	// Parsed again: a stored order is still input, never trusted as is.
	const parsed = teamInvoiceSchema.safeParse({
		...pending.request,
		timestamp: pending.startedAt,
	})
	if (!parsed.success) return { kind: 'expired' }
	const request = parsed.data
	const now = deps.now()

	const orderKey = teamInvoiceOrderKey(request, new Date(pending.startedAt))
	const previous = await deps.idempotency.get(orderKey)
	if (previous) return previous
	if (!(await deps.idempotency.lock(orderKey))) return { kind: 'error' }

	try {
		const product = await deps.loadProduct(request.productId)
		if (!product) return { kind: 'not-on-sale' }
		const sale = saleStateFor(product, request.seats, now)
		if (!sale.onSale) return { kind: 'not-on-sale' }
		if (!deps.invoicingEnabled(request.productId)) {
			return forwardToSupport(
				deps,
				request,
				product,
				'invoicing-disabled',
				pending.location,
			)
		}
		if (!(await deps.dailyCeiling('invoice'))) {
			await deps.log('team_invoice.ceiling', { kind: 'invoice' })
			return { kind: 'rate-limited' }
		}

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
			due: teamInvoiceDue(request.terms, product.product, now),
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
