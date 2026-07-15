import { describe, expect, it } from 'vitest'
import {
	evaluateInvoiceShortfall,
	referenceMatchesInvoiceNumber,
	senderMatchesCustomerName,
} from './invoice-shortfall-policy'

const base = {
	amountRemainingCents: 298_500,
	availableCashBalanceCents: 296_500,
	currency: 'usd',
	isOneTimeInvoice: true,
	isSendInvoice: true,
	hasSingleProductLine: true,
	referenceMatchesInvoice: true,
	senderMatchesCustomer: true,
}

describe('evaluateInvoiceShortfall', () => {
	it('accepts the verified Sievo shortfall', () => {
		expect(evaluateInvoiceShortfall(base)).toMatchObject({
			eligible: true,
			shortfallCents: 2_000,
		})
	})

	it('accepts exactly $100 when still under 5%', () => {
		expect(
			evaluateInvoiceShortfall({
				...base,
				amountRemainingCents: 300_000,
				availableCashBalanceCents: 290_000,
			}),
		).toMatchObject({ eligible: true, shortfallCents: 10_000 })
	})

	it('rejects exactly 5%', () => {
		expect(
			evaluateInvoiceShortfall({
				...base,
				amountRemainingCents: 100_000,
				availableCashBalanceCents: 95_000,
			}),
		).toEqual({
			eligible: false,
			reason: 'percentage-cap-reached',
			shortfallCents: 5_000,
		})
	})

	it.each([
		['absolute cap', { availableCashBalanceCents: 280_000 }, 'absolute-cap-exceeded'],
		['non USD', { currency: 'eur' }, 'unsupported-currency'],
		['subscription', { isOneTimeInvoice: false }, 'subscription-invoice'],
		['card invoice', { isSendInvoice: false }, 'not-send-invoice'],
		['multiple lines', { hasSingleProductLine: false }, 'not-single-product-line'],
		['wrong reference', { referenceMatchesInvoice: false }, 'invoice-reference-mismatch'],
		['wrong sender', { senderMatchesCustomer: false }, 'sender-customer-mismatch'],
	] as const)('rejects %s', (_, patch, reason) => {
		expect(evaluateInvoiceShortfall({ ...base, ...patch })).toMatchObject({
			eligible: false,
			reason,
		})
	})
})

describe('senderMatchesCustomerName', () => {
	it('matches a sender whose bank label extends the company name', () => {
		expect(
			senderMatchesCustomerName(
				'SIEVO OY ELIELINAUKIO',
				'Sievo Oy',
				'Elielinaukio 5 B',
			),
		).toBe(true)
	})

	it('rejects missing, unrelated, or dangerously short names', () => {
		expect(senderMatchesCustomerName('Other Company', 'Sievo Oy')).toBe(false)
		expect(senderMatchesCustomerName('Sievo Oy Fraud', 'Sievo Oy')).toBe(false)
		expect(senderMatchesCustomerName('Paid Services', 'AI')).toBe(false)
		expect(senderMatchesCustomerName(undefined, 'Sievo Oy')).toBe(false)
	})
})

describe('referenceMatchesInvoiceNumber', () => {
	it('matches an exact whitespace-delimited invoice token', () => {
		expect(referenceMatchesInvoiceNumber('INVOICE FY3ULKJO-0001', 'FY3ULKJO-0001')).toBe(true)
	})

	it('rejects partial invoice-number collisions', () => {
		expect(referenceMatchesInvoiceNumber('INVOICE INV-100', 'INV-10')).toBe(false)
	})
})
