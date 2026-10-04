import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzleInvoiceLinkDataSource } from '@/lib/invoice-links'
import { verifyInvoiceLinkToken } from '@/lib/invoice-link-token'

const secret = 'synthetic-support-secret'
const invoiceSecret = 'synthetic-invoice-secret-with-at-least-32-bytes'
const envMock = vi.hoisted(() => ({
	SUPPORT_WEBHOOK_SECRET: 'synthetic-support-secret',
	NEXT_PUBLIC_URL: 'https://example.invalid',
}))
vi.mock('@/env.mjs', () => ({ env: envMock }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	createRequestContext: () => ({}),
	withLogContext: (_: unknown, fn: () => unknown) => fn(),
	serializeError: () => ({}),
}))
vi.mock('@/db', () => ({
	db: new Proxy(
		{},
		{
			get() {
				throw new Error('Real DB forbidden')
			},
		},
	),
}))
import { POST } from './route'

const charge = 'mc_synthetic_a'
function request(
	body: unknown,
	mode: 'valid' | 'missing' | 'invalid' | 'expired' = 'valid',
) {
	const bodyText = typeof body === 'string' ? body : JSON.stringify(body)
	const timestamp =
		Math.floor(Date.now() / 1000) - (mode === 'expired' ? 301 : 0)
	const sig = createHmac('sha256', secret)
		.update(`${timestamp}.${bodyText}`)
		.digest('hex')
	return new NextRequest('https://example.invalid/api/support/invoice-link', {
		method: 'POST',
		body: bodyText,
		headers:
			mode === 'missing'
				? {}
				: {
						'x-support-signature': `timestamp=${timestamp},v1=${mode === 'invalid' ? 'bad' : sig}`,
					},
	})
}
beforeEach(() => {
	vi.restoreAllMocks()
	vi.stubEnv('INVOICE_LINK_SECRET', invoiceSecret)
	envMock.SUPPORT_WEBHOOK_SECRET = secret
	vi.spyOn(
		drizzleInvoiceLinkDataSource,
		'loadPurchaseByMerchantChargeId',
	).mockResolvedValue({
		id: 'purchase-a',
		merchantChargeId: charge,
		userId: 'payer',
	})
	vi.spyOn(drizzleInvoiceLinkDataSource, 'loadVersion').mockResolvedValue(1)
	vi.spyOn(drizzleInvoiceLinkDataSource, 'rotateVersion').mockImplementation(
		async () => {
			throw new Error('Support mint must not write')
		},
	)
})

describe('support signed invoice link endpoint', () => {
	it.each(['missing', 'invalid', 'expired'] as const)(
		'rejects %s support authentication before invoice access',
		async (mode) => {
			expect(
				(await POST(request({ merchantChargeId: charge }, mode))).status,
			).toBe(401)
			expect(
				drizzleInvoiceLinkDataSource.loadPurchaseByMerchantChargeId,
			).not.toHaveBeenCalled()
		},
	)
	it('returns a signed link using read-only invoice lookup', async () => {
		const response = await POST(request({ merchantChargeId: charge }))
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		const url = new URL((await response.json()).invoiceUrl)
		expect(url.origin).toBe('https://example.invalid')
		expect(url.pathname).toBe(`/invoices/${charge}`)
		expect(
			verifyInvoiceLinkToken({
				token: url.searchParams.get('t'),
				chargeId: charge,
				linkVersion: 1,
				secret: invoiceSecret,
			}),
		).toBe(true)
		expect(drizzleInvoiceLinkDataSource.rotateVersion).not.toHaveBeenCalled()
	})
	it('fails closed without the invoice secret', async () => {
		vi.stubEnv('INVOICE_LINK_SECRET', '')
		expect((await POST(request({ merchantChargeId: charge }))).status).toBe(503)
		expect(
			drizzleInvoiceLinkDataSource.loadPurchaseByMerchantChargeId,
		).not.toHaveBeenCalled()
	})
	it('fails closed without support configuration', async () => {
		envMock.SUPPORT_WEBHOOK_SECRET = ''
		expect((await POST(request({ merchantChargeId: charge }))).status).toBe(503)
	})
	it.each(['{', {}, { merchantChargeId: charge, rotate: true }])(
		'rejects malformed requests (%s)',
		async (body) => {
			expect((await POST(request(body))).status).toBe(400)
			expect(
				drizzleInvoiceLinkDataSource.loadPurchaseByMerchantChargeId,
			).not.toHaveBeenCalled()
		},
	)
	it('returns not found without minting when the purchase is absent', async () => {
		vi.mocked(
			drizzleInvoiceLinkDataSource.loadPurchaseByMerchantChargeId,
		).mockResolvedValue(null)
		expect((await POST(request({ merchantChargeId: charge }))).status).toBe(404)
	})
})
