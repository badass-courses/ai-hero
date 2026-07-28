export const MAX_AUTOMATIC_SHORTFALL_CENTS = 10_000
export const MAX_AUTOMATIC_SHORTFALL_PERCENT = 5

export type InvoiceShortfallCandidate = {
	amountRemainingCents: number
	availableCashBalanceCents: number
	currency: string
	isOneTimeInvoice: boolean
	isSendInvoice: boolean
	hasSingleProductLine: boolean
	referenceMatchesInvoice: boolean
	senderMatchesCustomer: boolean
}

export type InvoiceShortfallDecision =
	| { eligible: true; shortfallCents: number; shortfallPercent: number }
	| { eligible: false; reason: string; shortfallCents?: number }

export function evaluateInvoiceShortfall(
	candidate: InvoiceShortfallCandidate,
): InvoiceShortfallDecision {
	if (candidate.currency.toLowerCase() !== 'usd')
		return { eligible: false, reason: 'unsupported-currency' }
	if (!candidate.isOneTimeInvoice)
		return { eligible: false, reason: 'subscription-invoice' }
	if (!candidate.isSendInvoice)
		return { eligible: false, reason: 'not-send-invoice' }
	if (!candidate.hasSingleProductLine)
		return { eligible: false, reason: 'not-single-product-line' }
	if (!candidate.referenceMatchesInvoice)
		return { eligible: false, reason: 'invoice-reference-mismatch' }
	if (!candidate.senderMatchesCustomer)
		return { eligible: false, reason: 'sender-customer-mismatch' }
	if (
		!Number.isSafeInteger(candidate.amountRemainingCents) ||
		!Number.isSafeInteger(candidate.availableCashBalanceCents) ||
		candidate.amountRemainingCents <= 0 ||
		candidate.availableCashBalanceCents <= 0 ||
		candidate.availableCashBalanceCents >= candidate.amountRemainingCents
	)
		return { eligible: false, reason: 'not-an-underpayment' }

	const shortfallCents =
		candidate.amountRemainingCents - candidate.availableCashBalanceCents
	if (shortfallCents > MAX_AUTOMATIC_SHORTFALL_CENTS)
		return { eligible: false, reason: 'absolute-cap-exceeded', shortfallCents }
	if (
		shortfallCents * 100 >=
		candidate.amountRemainingCents * MAX_AUTOMATIC_SHORTFALL_PERCENT
	)
		return { eligible: false, reason: 'percentage-cap-reached', shortfallCents }

	return {
		eligible: true,
		shortfallCents,
		shortfallPercent:
			(shortfallCents / candidate.amountRemainingCents) * 100,
	}
}

const normalizeParty = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()

export function senderMatchesCustomerName(
	senderName: string | null | undefined,
	customerName: string | null | undefined,
	customerAddressLine1?: string | null,
) {
	const sender = normalizeParty(senderName ?? '')
	const customer = normalizeParty(customerName ?? '')
	if (!sender || customer.length < 4) return false
	if (sender === customer) return true

	const addressToken =
		normalizeParty(customerAddressLine1 ?? '').split(' ')[0] ?? ''
	return (
		addressToken.length >= 4 &&
		sender.startsWith(`${customer} ${addressToken}`)
	)
}

export function referenceMatchesInvoiceNumber(
	reference: string | null | undefined,
	invoiceNumber: string,
) {
	const tokens = (reference ?? '')
		.toLowerCase()
		.trim()
		.split(/\s+/)
	return tokens.includes(invoiceNumber.toLowerCase())
}
