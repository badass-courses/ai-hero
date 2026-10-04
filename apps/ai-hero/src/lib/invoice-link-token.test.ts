import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	createInvoiceLinkToken,
	verifyInvoiceLinkToken,
} from './invoice-link-token'

const secret = 'synthetic-invoice-secret-with-at-least-32-bytes'
const chargeId = 'mc_synthetic_a'
const nowSeconds = 1800000000

describe('signed invoice token', () => {
	it('mints a default 30-day HMAC token bound to the invoice and version', () => {
		const token = createInvoiceLinkToken({
			chargeId,
			linkVersion: 1,
			secret,
			nowSeconds,
		})
		const expiry = nowSeconds + 30 * 86400
		const signature = createHmac('sha256', secret)
			.update(`${chargeId}|1|${expiry}`)
			.digest('base64url')
		expect(token).toBe(`1.${expiry}.${signature}`)
		expect(
			verifyInvoiceLinkToken({
				token,
				chargeId,
				linkVersion: 1,
				secret,
				nowSeconds,
			}),
		).toBe(true)
	})
	it('uses the configured TTL in whole days', () => {
		const token = createInvoiceLinkToken({
			chargeId,
			linkVersion: 1,
			secret,
			nowSeconds,
			ttlDays: '7',
		})
		expect(token.split('.')[1]).toBe(String(nowSeconds + 7 * 86400))
	})
	it.each(['', '0', '-1', '1.5', '1e2', 'NaN', '9999999999999999999999'])(
		'refuses invalid TTL %s',
		(ttlDays) => {
			expect(() =>
				createInvoiceLinkToken({
					chargeId,
					linkVersion: 1,
					secret,
					nowSeconds,
					ttlDays,
				}),
			).toThrow('lifetime')
		},
	)
	it('expires at the exact unix-second boundary', () => {
		const token = createInvoiceLinkToken({
			chargeId,
			linkVersion: 1,
			secret,
			nowSeconds,
		})
		expect(
			verifyInvoiceLinkToken({
				token,
				chargeId,
				linkVersion: 1,
				secret,
				nowSeconds: nowSeconds + 30 * 86400,
			}),
		).toBe(false)
	})
	it.each(['signature', 'version', 'expiry', 'chargeId'])(
		'rejects a tampered %s',
		(field) => {
			const token = createInvoiceLinkToken({
				chargeId,
				linkVersion: 1,
				secret,
				nowSeconds,
			})
			const [version, expiry, sig] = token.split('.')
			const changed =
				field === 'signature'
					? `${version}.${expiry}.${'A'.repeat(43)}`
					: field === 'version'
						? `2.${expiry}.${sig}`
						: field === 'expiry'
							? `${version}.${Number(expiry) + 100}.${sig}`
							: token
			expect(
				verifyInvoiceLinkToken({
					token: changed,
					chargeId: field === 'chargeId' ? 'mc_synthetic_b' : chargeId,
					linkVersion: 1,
					secret,
					nowSeconds,
				}),
			).toBe(false)
		},
	)
	it('rejects an old token after rotation', () => {
		const token = createInvoiceLinkToken({
			chargeId,
			linkVersion: 1,
			secret,
			nowSeconds,
		})
		expect(
			verifyInvoiceLinkToken({
				token,
				chargeId,
				linkVersion: 2,
				secret,
				nowSeconds,
			}),
		).toBe(false)
	})
	it.each([undefined, '', '   '])(
		'fails closed without a configured secret (%s)',
		(missing) => {
			const token = createInvoiceLinkToken({
				chargeId,
				linkVersion: 1,
				secret,
				nowSeconds,
			})
			expect(
				verifyInvoiceLinkToken({
					token,
					chargeId,
					linkVersion: 1,
					secret: missing,
					nowSeconds,
				}),
			).toBe(false)
			expect(() =>
				createInvoiceLinkToken({
					chargeId,
					linkVersion: 1,
					secret: missing,
					nowSeconds,
				}),
			).toThrow('not configured')
		},
	)
	it.each([
		undefined,
		null,
		[],
		{},
		'garbage',
		'1.1800000100.A',
		'01.1800000100.A',
		'1.1e20.A',
		'0.1800000100.A',
		'1.1800000100.A.extra',
	])('rejects malformed tokens (%s)', (token) => {
		expect(
			verifyInvoiceLinkToken({
				token,
				chargeId,
				linkVersion: 1,
				secret,
				nowSeconds,
			}),
		).toBe(false)
	})
})
