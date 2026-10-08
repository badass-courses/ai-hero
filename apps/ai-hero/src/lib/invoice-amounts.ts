// Stripe amounts use minor units, with exceptions to ISO currency exponents.
// https://docs.stripe.com/currencies#zero-decimal
const zeroDecimalCurrencies = new Set([
	'BIF',
	'CLP',
	'DJF',
	'GNF',
	'JPY',
	'KMF',
	'KRW',
	'MGA',
	'PYG',
	'RWF',
	'VND',
	'VUV',
	'XAF',
	'XOF',
	'XPF',
])

export function stripeAmountToMajorUnits(amount: number, currency: string) {
	const code = currency.toUpperCase()
	// ISK and UGX display without decimals but Stripe still sends units of 1/100.
	// HUF allows two-decimal charges even on ICU versions that display no decimals.
	const decimals = zeroDecimalCurrencies.has(code)
		? 0
		: code === 'ISK' || code === 'UGX' || code === 'HUF'
			? 2
			: (new Intl.NumberFormat('en-US', {
					style: 'currency',
					currency: code,
				}).resolvedOptions().maximumFractionDigits ?? 2)
	return amount / 10 ** decimals
}

export function formatInvoiceAmount(amount: number, currency: string) {
	const code = currency.toUpperCase()
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: code,
		...(zeroDecimalCurrencies.has(code)
			? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
			: code === 'HUF'
				? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
				: {}),
	}).format(stripeAmountToMajorUnits(amount, code))
}

export type InvoicePresentment = { amount: number; currency: string }

// stripe@16 predates the presentment_details type. The charge is already
// refetched by the invoice loader; validate this extra response field locally
// instead of upgrading the shared client or changing its API version.
export function getInvoicePresentment(charge: {
	currency: string
	presentment_details?: unknown
}): InvoicePresentment | null {
	const details = charge.presentment_details
	if (!details || typeof details !== 'object') return null
	if (
		!('presentment_amount' in details) ||
		!('presentment_currency' in details)
	)
		return null
	const amount = details.presentment_amount
	const currency = details.presentment_currency
	if (
		typeof amount !== 'number' ||
		!Number.isSafeInteger(amount) ||
		amount < 0 ||
		typeof currency !== 'string' ||
		!Intl.supportedValuesOf('currency').includes(currency.toUpperCase()) ||
		currency.toUpperCase() === charge.currency.toUpperCase()
	)
		return null
	return { amount, currency: currency.toUpperCase() }
}
