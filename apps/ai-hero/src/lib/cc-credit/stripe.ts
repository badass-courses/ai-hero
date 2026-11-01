import type Stripe from 'stripe'
import {
	CreditRefusal,
	positiveInteger,
	type SourcePayment,
	type SourcePaymentRow,
} from './domain'
import type { InvoiceEvidence } from './service'

/** Hand-written credits say "Crash Course credit", "Crash Course team credit"
 * or "Crash Course team seat credit". Any other negative line is held. */
export const isCreditDescription = (description: string | null) =>
	/crash course (?:team )?(?:seat )?credit/i.test(description ?? '')
export const isUnrecognizedNegativeLine = (line: {
	amount: number
	description: string | null
}) => line.amount < 0 && !isCreditDescription(line.description)

/** Read-only Stripe adapter. Always paginate: a hidden credit line is money. */
export async function readCreditInvoice(
	stripe: Pick<Stripe, 'invoices'>,
	invoiceId: string,
	c5StripeProducts: ReadonlySet<string>,
): Promise<InvoiceEvidence> {
	const invoice = await stripe.invoices.retrieve(invoiceId)
	if (invoice.id !== invoiceId || invoice.subscription)
		throw new CreditRefusal('not_a_one_off_target_invoice')
	if (!invoice.status || !invoice.customer)
		throw new CreditRefusal('invoice_evidence_missing')
	const customer =
		typeof invoice.customer === 'string'
			? invoice.customer
			: invoice.customer.id
	const lines: Stripe.InvoiceLineItem[] = []
	let starting_after: string | undefined
	for (;;) {
		const page = await stripe.invoices.listLineItems(invoiceId, {
			limit: 100,
			...(starting_after ? { starting_after } : {}),
		})
		lines.push(...page.data)
		if (!page.has_more) break
		const cursor = page.data.at(-1)?.id
		if (!cursor || cursor === starting_after)
			throw new CreditRefusal('invoice_pagination_incomplete')
		starting_after = cursor
	}
	if (
		lines.some(
			(line) =>
				isCreditDescription(line.description) &&
				(line.discount_amounts ?? []).some((discount) => discount.amount !== 0),
		)
	)
		throw new CreditRefusal('discounted_credit_line_hold_for_review')
	if (lines.some(isUnrecognizedNegativeLine))
		throw new CreditRefusal('unrecognized_negative_line_hold_for_review')
	if (lines.some((line) => line.currency !== invoice.currency))
		throw new CreditRefusal('mixed_invoice_currencies')
	const c5 = lines.filter((line) => {
		const product = line.price?.product
		return (
			product &&
			c5StripeProducts.has(typeof product === 'string' ? product : product.id)
		)
	})
	return {
		invoiceId: invoice.id,
		stripeCustomerId: customer,
		status: invoice.status,
		currency: invoice.currency,
		c5Seats: c5.reduce(
			(n, line) => n + positiveInteger(line.quantity ?? 0, 'c5_line_quantity'),
			0,
		),
		c5AmountCents: c5.reduce(
			(n, line) =>
				n +
				line.amount -
				(line.discount_amounts ?? []).reduce(
					(sum, discount) => sum + discount.amount,
					0,
				),
			0,
		),
		creditLines: lines
			.filter((line) => isCreditDescription(line.description))
			.map((line) => ({
				amountCents: line.amount,
				description: line.description!,
			})),
	}
}

/** Read-only money and seat evidence for source purchases. The charge carries
 * the cents actually paid. The checkout carries the seats bought, which add-seat
 * purchases cannot get from their shared bulk coupon. Call before any DB lock.
 */
export async function readSourcePayments(
	stripe: Pick<Stripe, 'charges' | 'checkout'>,
	rows: SourcePaymentRow[],
): Promise<Map<string, SourcePayment>> {
	const result = new Map<string, SourcePayment>()
	for (const row of rows)
		result.set(row.purchaseId, await readSourcePayment(stripe, row))
	return result
}
async function readSourcePayment(
	stripe: Pick<Stripe, 'charges' | 'checkout'>,
	row: SourcePaymentRow,
): Promise<SourcePayment> {
	const chargeId = row.chargeIdentifier
	if (!chargeId || !/^(?:ch|py)_[A-Za-z0-9]+$/.test(chargeId))
		return { hold: 'source_charge_evidence_missing_hold_for_review' }
	const charge = await stripe.charges.retrieve(chargeId)
	if (
		charge.id !== chargeId ||
		charge.status !== 'succeeded' ||
		charge.currency !== 'usd' ||
		!Number.isSafeInteger(charge.amount) ||
		charge.amount < 1
	)
		return { hold: 'source_charge_not_settled_usd_hold_for_review' }
	if (charge.amount_refunded !== 0)
		return { hold: 'source_charge_refunded_hold_for_review' }
	const sessionId = row.checkoutSessionIdentifier
	if (!sessionId || !sessionId.startsWith('cs_'))
		return { chargeCents: charge.amount, seats: null }
	const items = await stripe.checkout.sessions.listLineItems(sessionId, {
		limit: 100,
	})
	const item = items.data[0]
	// One line, paid by exactly this charge. Anything else is not one purchase.
	if (
		items.has_more ||
		items.data.length !== 1 ||
		!item ||
		item.amount_total !== charge.amount ||
		!Number.isSafeInteger(item.quantity) ||
		(item.quantity ?? 0) < 1
	)
		return { hold: 'source_checkout_evidence_ambiguous_hold_for_review' }
	return { chargeCents: charge.amount, seats: item.quantity }
}
