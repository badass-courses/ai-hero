import type Stripe from 'stripe'
import { CreditRefusal, positiveInteger } from './domain'
import type { InvoiceEvidence } from './service'

export const isCreditDescription = (description: string | null) =>
	/crash course (?:team seat )?credit/i.test(description ?? '')

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
