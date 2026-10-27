import { describe, expect, it } from 'vitest'
import {
	formatInvoiceAmount,
	getInvoicePresentment,
	stripeAmountToMajorUnits,
} from './invoice-amounts'

describe('Stripe invoice amounts', () => {
	it.each([
		['usd', 29900, 299, '$299.00'],
		['eur', 27806, 278.06, '€278.06'],
		['jpy', 42000, 42000, '¥42,000'],
		['krw', 5000, 5000, '₩5,000'],
		['bhd', 12345, 12.345, 'BHD\u00a012.345'],
		['isk', 50000, 500, 'ISK\u00a0500'],
		['ugx', 50000, 500, 'UGX\u00a0500'],
		['mga', 500, 500, 'MGA\u00a0500'],
		['huf', 1045, 10.45, 'HUF\u00a010.45'],
		['twd', 1045, 10.45, 'NT$10.45'],
	] as const)(
		'formats %s in Stripe charge units',
		(currency, amount, major, formatted) => {
			expect(stripeAmountToMajorUnits(amount, currency)).toBe(major)
			expect(formatInvoiceAmount(amount, currency)).toBe(formatted)
		},
	)

	it('accepts a validated extra field from the existing charge response', () => {
		expect(
			getInvoicePresentment({
				currency: 'usd',
				presentment_details: {
					presentment_amount: 27806,
					presentment_currency: 'eur',
				},
			}),
		).toEqual({ amount: 27806, currency: 'EUR' })
	})

	it.each([
		undefined,
		null,
		'eur',
		{},
		{ presentment_amount: 27806 },
		{ presentment_currency: 'eur' },
		{ presentment_amount: -1, presentment_currency: 'eur' },
		{ presentment_amount: 1.5, presentment_currency: 'eur' },
		{ presentment_amount: NaN, presentment_currency: 'eur' },
		{ presentment_amount: Infinity, presentment_currency: 'eur' },
		{
			presentment_amount: Number.MAX_SAFE_INTEGER + 1,
			presentment_currency: 'eur',
		},
		{ presentment_amount: '27806', presentment_currency: 'eur' },
		{ presentment_amount: 27806, presentment_currency: 'not-a-currency' },
		{ presentment_amount: 27806, presentment_currency: 'zzz' },
		{ presentment_amount: 29900, presentment_currency: 'USD' },
	])(
		'ignores absent, malformed or same-currency details (%j)',
		(presentment_details) => {
			expect(
				getInvoicePresentment({ currency: 'usd', presentment_details }),
			).toBeNull()
		},
	)

	it('allows a zero presentment amount without treating it as missing', () => {
		expect(
			getInvoicePresentment({
				currency: 'usd',
				presentment_details: {
					presentment_amount: 0,
					presentment_currency: 'eur',
				},
			}),
		).toEqual({ amount: 0, currency: 'EUR' })
	})
})
