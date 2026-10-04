import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInvoiceLinkToken } from './invoice-link-token'
import { invoiceLinkResponse, INVOICE_LINK_COOKIE } from './invoice-link-http'
import { drizzleInvoiceLinkDataSource } from './invoice-links'

const secret = 'synthetic-invoice-secret-with-at-least-32-bytes'
const charge = 'mc_synthetic_a'
const path = `/invoices/${charge}`
const now = 1800000000
const token = () =>
	createInvoiceLinkToken({
		chargeId: charge,
		linkVersion: 1,
		secret,
		nowSeconds: now,
	})
const request = (suffix = '', cookie?: string, invoice = charge) =>
	new NextRequest(`https://example.invalid/invoices/${invoice}${suffix}`, {
		headers:
			cookie !== undefined
				? { cookie: `${INVOICE_LINK_COOKIE}=${cookie}` }
				: {},
	})
beforeEach(() => {
	vi.restoreAllMocks()
	vi.useFakeTimers({ now: now * 1000 })
	vi.stubEnv('INVOICE_LINK_SECRET', secret)
	vi.spyOn(
		drizzleInvoiceLinkDataSource,
		'loadPurchaseByMerchantChargeId',
	).mockImplementation(async (id) => ({
		id: 'purchase-a',
		merchantChargeId: id,
		userId: 'payer',
	}))
	vi.spyOn(drizzleInvoiceLinkDataSource, 'loadVersion').mockResolvedValue(1)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

describe('invoice token exchange and scoped cookie', () => {
	it('exchanges a valid query token for an HttpOnly cookie and redirects to the bare invoice', async () => {
		const response = await invoiceLinkResponse(
			request(`?t=${token()}&other=x`),
			charge,
		)
		expect(response.status).toBe(307)
		expect(response.headers.get('location')).toBe(
			`https://example.invalid${path}`,
		)
		expect(response.headers.get('location')).not.toContain('?')
		expect(response.cookies.get(INVOICE_LINK_COOKIE)).toMatchObject({
			value: token(),
			path,
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 3600,
		})
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(response.headers.get('cache-control')).toBe('private, no-store')
	})
	it('caps the cookie lifetime at token expiry when less than one hour remains', async () => {
		const shortToken = createInvoiceLinkToken({
			chargeId: charge,
			linkVersion: 1,
			secret,
			nowSeconds: now - 30 * 86400 + 30,
		})
		const response = await invoiceLinkResponse(
			request(`?t=${shortToken}`),
			charge,
		)
		expect(response.cookies.get(INVOICE_LINK_COOKIE)?.maxAge).toBe(30)
	})
	it('lets a valid cookie reach the page only after rechecking the current version', async () => {
		const response = await invoiceLinkResponse(request('', token()), charge)
		expect(response.headers.get('x-middleware-next')).toBe('1')
		expect(drizzleInvoiceLinkDataSource.loadVersion).toHaveBeenCalledWith(
			'purchase-a',
			charge,
		)
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(response.headers.get('cache-control')).toBe('private, no-store')
	})
	it.each(['expired', 'rotated', 'other-invoice', 'tampered', 'empty'])(
		'clears a %s cookie rather than granting access',
		async (kind) => {
			let cookie = token()
			if (kind === 'expired')
				cookie = createInvoiceLinkToken({
					chargeId: charge,
					linkVersion: 1,
					secret,
					nowSeconds: now - 30 * 86400,
				})
			if (kind === 'rotated')
				vi.mocked(drizzleInvoiceLinkDataSource.loadVersion).mockResolvedValue(2)
			if (kind === 'other-invoice')
				cookie = createInvoiceLinkToken({
					chargeId: 'mc_b',
					linkVersion: 1,
					secret,
					nowSeconds: now,
				})
			if (kind === 'tampered') cookie = `${cookie.slice(0, -5)}wrong`
			if (kind === 'empty') cookie = ''
			const response = await invoiceLinkResponse(request('', cookie), charge)
			expect(response.cookies.get(INVOICE_LINK_COOKIE)).toMatchObject({
				value: '',
				maxAge: 0,
				path,
			})
			expect(response.headers.get('x-middleware-next')).toBe('1')
		},
	)
	it('removes a garbage query without setting an access cookie', async () => {
		const response = await invoiceLinkResponse(request('?t=garbage'), charge)
		expect(response.status).toBe(307)
		expect(response.headers.get('location')).toBe(
			`https://example.invalid${path}`,
		)
		expect(response.cookies.get(INVOICE_LINK_COOKIE)).toMatchObject({
			value: '',
			maxAge: 0,
		})
	})
	it('does not use a good prior cookie to rescue an invalid or duplicated query token', async () => {
		const response = await invoiceLinkResponse(
			request('?t=garbage&t=other', token()),
			charge,
		)
		expect(response.cookies.get(INVOICE_LINK_COOKIE)?.maxAge).toBe(0)
	})
	it('clears access when the secret is missing', async () => {
		vi.stubEnv('INVOICE_LINK_SECRET', '')
		const response = await invoiceLinkResponse(request('', token()), charge)
		expect(response.cookies.get(INVOICE_LINK_COOKIE)?.maxAge).toBe(0)
		expect(drizzleInvoiceLinkDataSource.loadVersion).not.toHaveBeenCalled()
	})
})
