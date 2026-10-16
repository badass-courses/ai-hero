import type Stripe from 'stripe'

import type { TeamDiscount } from './team-price-source'
import type { TeamInvoiceAddress } from './schema'

/**
 * Creates, checks and sends one self-serve team invoice in Stripe.
 *
 * The call shape is Course Builder's generic invoice path (`cb stripe
 * invoices` in course-builder's aihero-cli): a customer by email, a
 * `send_invoice` invoice carrying the metadata and discount, one invoice item
 * for the product's price × quantity, then finalize. That shape is what the
 * existing `invoice.payment_succeeded` fulfillment reads: one product line, no
 * subscription, a customer email, quantity above one as a bulk purchase.
 *
 * Two additions for an unattended path. The invoice is finalized without
 * auto-advance and its total read back before anything is sent: a total that
 * is not the priced amount voids the invoice instead of mailing it. And every
 * write carries an idempotency key built from the order key, a hash of the
 * whole request, so a retry returns the same Stripe objects instead of a
 * second invoice, and a corrected retry gets fresh ones.
 *
 * It never edits an existing Stripe customer. A self-serve customer is reused
 * only when its billing details already match this order's.
 */

/** The Stripe calls this module makes, narrowed for tests. */
export type TeamInvoiceStripe = {
	customers: Pick<Stripe['customers'], 'list' | 'create'>
	coupons: Pick<Stripe['coupons'], 'create'>
	invoices: Pick<
		Stripe['invoices'],
		'create' | 'finalizeInvoice' | 'sendInvoice' | 'voidInvoice'
	>
	invoiceItems: Pick<Stripe['invoiceItems'], 'create'>
}

export type CreateTeamInvoiceInput = {
	/** A hash of the whole normalized request. Prefixes every idempotency key. */
	orderKey: string
	billingEmail: string
	companyName: string
	address?: TeamInvoiceAddress
	taxId?: string
	poNumber?: string
	due: TeamInvoiceDue
	stripePriceId: string
	stripeProductId: string
	quantity: number
	discount: TeamDiscount
	/** What the invoice must total after discount, in cents. */
	expectedTotal: number
	metadata: Record<string, string>
}

export type CreatedTeamInvoice = {
	invoiceId: string
	customerId: string
	total: number
	hostedInvoiceUrl: string | null
	status: Stripe.Invoice.Status | null
}

/**
 * When the invoice falls due: a number of days, or a fixed date (unix
 * seconds) when an enrollment window closes first.
 */
export type TeamInvoiceDue =
	| { kind: 'days'; days: number }
	| { kind: 'date'; at: number }

export class TeamInvoiceTotalMismatch extends Error {
	constructor(
		readonly invoiceId: string,
		readonly expected: number,
		readonly actual: number,
	) {
		super(
			`Team invoice ${invoiceId} totals ${actual}, expected ${expected}; voided`,
		)
		this.name = 'TeamInvoiceTotalMismatch'
	}
}

/** Self-serve customers are tagged, so a buyer's other customers stay untouched. */
export const SELF_SERVE_CUSTOMER_SOURCE = 'self_serve_team_invoice'

const stripeAddress = (
	address: TeamInvoiceAddress | undefined,
): Stripe.AddressParam | undefined =>
	address?.line1 && address.country
		? {
				line1: address.line1,
				line2: address.line2 ?? '',
				city: address.city ?? '',
				state: address.state ?? '',
				postal_code: address.postalCode ?? '',
				country: address.country,
			}
		: undefined

/**
 * Invoice custom fields print on the PDF. A free-text tax ID goes here, not
 * into `tax_ids`, because Stripe's tax ID objects need a typed scheme the
 * form cannot know.
 */
export const invoiceCustomFields = (input: {
	taxId?: string
	poNumber?: string
}): Stripe.InvoiceCreateParams.CustomField[] => [
	...(input.poNumber ? [{ name: 'PO number', value: input.poNumber }] : []),
	...(input.taxId ? [{ name: 'Tax ID', value: input.taxId }] : []),
]

const addressKey = (address: Partial<Stripe.Address> | null | undefined) =>
	[
		address?.line1,
		address?.line2,
		address?.city,
		address?.state,
		address?.postal_code,
		address?.country,
	]
		.map((part) => part ?? '')
		.join('|')

function sameBillingDetails(
	customer: Pick<Stripe.Customer, 'name' | 'address'>,
	details: { name: string; address?: Stripe.AddressParam },
): boolean {
	return (
		(customer.name ?? '') === details.name &&
		addressKey(customer.address) === addressKey(details.address)
	)
}

export async function findOrCreateTeamCustomer(
	stripe: TeamInvoiceStripe,
	input: Pick<
		CreateTeamInvoiceInput,
		'orderKey' | 'billingEmail' | 'companyName' | 'address' | 'metadata'
	>,
): Promise<string> {
	const details = {
		name: input.companyName,
		...(stripeAddress(input.address)
			? { address: stripeAddress(input.address) }
			: {}),
	}
	const existing = await stripe.customers.list({
		email: input.billingEmail,
		limit: 100,
	})
	// Reuse a self-serve customer only when it already says what this order
	// says. Different details get a new customer, so no request ever rewrites
	// the name or address a past invoice was billed to.
	const same = existing.data.find(
		(customer) =>
			!('deleted' in customer && customer.deleted) &&
			customer.metadata?.source === SELF_SERVE_CUSTOMER_SOURCE &&
			sameBillingDetails(customer, details),
	)
	if (same) return same.id
	const created = await stripe.customers.create(
		{
			email: input.billingEmail,
			...details,
			metadata: {
				source: SELF_SERVE_CUSTOMER_SOURCE,
				companyName: input.companyName,
				...(input.metadata.rig ? { rig: input.metadata.rig } : {}),
				...(input.metadata.rig_run ? { rig_run: input.metadata.rig_run } : {}),
			},
		},
		{ idempotencyKey: `${input.orderKey}:customer` },
	)
	return created.id
}

async function invoiceDiscounts(
	stripe: TeamInvoiceStripe,
	input: CreateTeamInvoiceInput,
): Promise<Stripe.InvoiceCreateParams.Discount[]> {
	switch (input.discount.kind) {
		case 'none':
			return []
		case 'stripe-coupon':
			return [{ coupon: input.discount.stripeCouponId }]
		case 'amount-off': {
			// One coupon per invoice, spent by it: once, one redemption, this
			// product only. The manual invoice script makes the same object.
			const coupon = await stripe.coupons.create(
				{
					amount_off: input.discount.amountOff,
					currency: 'usd',
					duration: 'once',
					max_redemptions: 1,
					applies_to: { products: [input.stripeProductId] },
					name: 'Team pricing',
					metadata: input.metadata,
				},
				{ idempotencyKey: `${input.orderKey}:coupon` },
			)
			return [{ coupon: coupon.id }]
		}
	}
}

export async function createAndSendTeamInvoice(
	stripe: TeamInvoiceStripe,
	input: CreateTeamInvoiceInput,
): Promise<CreatedTeamInvoice> {
	const customerId = await findOrCreateTeamCustomer(stripe, input)
	const discounts = await invoiceDiscounts(stripe, input)
	const customFields = invoiceCustomFields(input)

	const invoice = await stripe.invoices.create(
		{
			customer: customerId,
			collection_method: 'send_invoice',
			...(input.due.kind === 'date'
				? { due_date: input.due.at }
				: { days_until_due: input.due.days }),
			auto_advance: false,
			pending_invoice_items_behavior: 'exclude',
			...(discounts.length ? { discounts } : {}),
			...(customFields.length ? { custom_fields: customFields } : {}),
			metadata: input.metadata,
		},
		{ idempotencyKey: `${input.orderKey}:invoice` },
	)

	await stripe.invoiceItems.create(
		{
			customer: customerId,
			invoice: invoice.id,
			price: input.stripePriceId,
			quantity: input.quantity,
			metadata: input.metadata,
		},
		{ idempotencyKey: `${input.orderKey}:item` },
	)

	const finalized = await stripe.invoices.finalizeInvoice(
		invoice.id,
		{ auto_advance: false },
		{ idempotencyKey: `${input.orderKey}:finalize` },
	)

	if (finalized.total !== input.expectedTotal) {
		await stripe.invoices.voidInvoice(finalized.id, undefined, {
			idempotencyKey: `${input.orderKey}:void`,
		})
		throw new TeamInvoiceTotalMismatch(
			finalized.id,
			input.expectedTotal,
			finalized.total,
		)
	}

	const sent = await stripe.invoices.sendInvoice(finalized.id, undefined, {
		idempotencyKey: `${input.orderKey}:send`,
	})

	return {
		invoiceId: sent.id,
		customerId,
		total: sent.total,
		hostedInvoiceUrl: sent.hosted_invoice_url ?? null,
		status: sent.status,
	}
}
