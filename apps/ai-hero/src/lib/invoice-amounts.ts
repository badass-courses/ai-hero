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

const threeDecimalCurrencies = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND'])

// Stripe's charge units are not ICU's currency display defaults. ISK and UGX
// still use hundredths, and HUF charges support two decimal places.
function stripeCurrencyDecimals(currency: string) {
	const code = currency.toUpperCase()
	return zeroDecimalCurrencies.has(code)
		? 0
		: threeDecimalCurrencies.has(code)
			? 3
			: 2
}

export function stripeAmountToMajorUnits(amount: number, currency: string) {
	return amount / 10 ** stripeCurrencyDecimals(currency)
}

// Number only: callers own the currency label (and the legacy USD symbol).
export function formatInvoiceAmount(amount: number, currency: string) {
	const decimals = stripeCurrencyDecimals(currency)
	return new Intl.NumberFormat('en-US', {
		style: 'decimal',
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	}).format(stripeAmountToMajorUnits(amount, currency))
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
