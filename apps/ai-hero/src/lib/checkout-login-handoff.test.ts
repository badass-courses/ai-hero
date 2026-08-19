import { describe, expect, it } from 'vitest'

import {
	createCheckoutLoginHandoff,
	verifyCheckoutLoginHandoff,
} from './checkout-login-handoff'

const secret = 'test-checkout-login-handoff-secret'
const issuedAt = new Date('2026-08-19T20:00:00.000Z')
const expected = {
	country: 'TR',
	productId: 'product-crash-course',
	quantity: 1,
}

const createToken = (
	overrides: Partial<Parameters<typeof createCheckoutLoginHandoff>[0]> = {},
) =>
	createCheckoutLoginHandoff({
		secret,
		...expected,
		pppSelected: true,
		nonce: 'nonce-turkey-1',
		now: issuedAt,
		...overrides,
	})

describe('checkout login handoff', () => {
	it('accepts an authentic short-lived Turkey PPP handoff', () => {
		const token = createToken()

		expect(
			verifyCheckoutLoginHandoff({
				token,
				secret,
				expected,
				now: new Date('2026-08-19T20:05:00.000Z'),
			}),
		).toEqual({
			valid: true,
			payload: {
				version: 1,
				...expected,
				pppSelected: true,
				nonce: 'nonce-turkey-1',
				issuedAt: issuedAt.getTime(),
				expiresAt: issuedAt.getTime() + 10 * 60 * 1000,
			},
		})
	})

	it('rejects payload tampering', () => {
		const token = createToken()
		const [version, encodedPayload, signature] = token.split('.')
		const payload = JSON.parse(
			Buffer.from(encodedPayload!, 'base64url').toString('utf8'),
		) as Record<string, unknown>
		payload.country = 'US'
		const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
			'base64url',
		)

		expect(
			verifyCheckoutLoginHandoff({
				token: `${version}.${tamperedPayload}.${signature}`,
				secret,
				expected: { ...expected, country: 'US' },
				now: issuedAt,
			}),
		).toEqual({ valid: false, reason: 'tampered' })
	})

	it('rejects an expired handoff', () => {
		const token = createToken()

		expect(
			verifyCheckoutLoginHandoff({
				token,
				secret,
				expected,
				now: new Date('2026-08-19T20:10:00.000Z'),
			}),
		).toEqual({ valid: false, reason: 'expired' })
	})

	it.each([
		['product', { ...expected, productId: 'product-other' }, 'product-mismatch'],
		['quantity', { ...expected, quantity: 2 }, 'quantity-mismatch'],
		['country', { ...expected, country: 'US' }, 'country-mismatch'],
	] as const)('rejects a changed %s', (_, changedExpected, reason) => {
		const token = createToken()

		expect(
			verifyCheckoutLoginHandoff({
				token,
				secret,
				expected: changedExpected,
				now: issuedAt,
			}),
		).toEqual({ valid: false, reason })
	})

	it('fails closed when the token or signing secret is missing', () => {
		expect(
			verifyCheckoutLoginHandoff({
				token: undefined,
				secret,
				expected,
				now: issuedAt,
			}),
		).toEqual({ valid: false, reason: 'missing' })
		expect(
			verifyCheckoutLoginHandoff({
				token: createToken(),
				secret: undefined,
				expected,
				now: issuedAt,
			}),
		).toEqual({ valid: false, reason: 'missing-secret' })
	})
})
