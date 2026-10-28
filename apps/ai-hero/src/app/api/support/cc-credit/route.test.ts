import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreditRefusal } from '@/lib/cc-credit/domain'

const mocks = vi.hoisted(() => ({
	enabled: false,
	run: vi.fn(),
	balance: vi.fn(),
	invoice: vi.fn(),
	writes: vi.fn(),
}))
vi.mock('@/server/logger', () => ({
	log: { info: async () => undefined, warn: async () => undefined },
}))
vi.mock('@/env.mjs', () => ({
	env: {
		SUPPORT_WEBHOOK_SECRET: 'synthetic-secret',
		STRIPE_SECRET_TOKEN: 'sk_test_synthetic',
	},
}))
vi.mock('@/lib/cc-credit/runtime', () => ({
	creditEnabled: () => mocks.enabled,
	creditImportEnabled: () => false,
	creditStore: {},
	c5StripeProducts: async () => new Set(['prod_synthetic']),
	assertCreditWritesAllowed: mocks.writes,
}))
vi.mock('@/lib/cc-credit/service', () => ({
	runCreditCommand: mocks.run,
	readCreditBalance: mocks.balance,
}))
vi.mock('@/lib/cc-credit/stripe', () => ({ readCreditInvoice: mocks.invoice }))
import { POST } from './route'

const input = {
	mode: 'reserve',
	scope: { stripeCustomerId: 'cus_synthetic' },
	invoiceId: 'in_synthetic',
	seats: 2,
	audit: {
		operatorId: 'synthetic',
		runId: 'synthetic',
		approvalReference: 'synthetic',
	},
}
function request(
	body: unknown,
	signed = true,
	timestamp = Math.floor(Date.now() / 1000),
) {
	const text = typeof body === 'string' ? body : JSON.stringify(body)
	const signature = createHmac('sha256', 'synthetic-secret')
		.update(`${timestamp}.${text}`)
		.digest('hex')
	return new NextRequest('https://example.test/api/support/cc-credit', {
		method: 'POST',
		body: text,
		headers: signed
			? { 'x-support-signature': `timestamp=${timestamp},v1=${signature}` }
			: {},
	})
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.enabled = true
	mocks.invoice.mockResolvedValue({
		invoiceId: 'in_synthetic',
		stripeCustomerId: 'cus_synthetic',
	})
	mocks.run.mockResolvedValue({ state: 'reserved' })
	mocks.balance.mockResolvedValue({
		seats: 2,
		amountCents: 20000,
		currency: 'usd',
	})
})
describe('signed CC credit support seam', () => {
	it('rejects unsigned and expired requests before any ledger or Stripe read', async () => {
		expect((await POST(request(input, false))).status).toBe(401)
		expect((await POST(request(input, true, 1))).status).toBe(401)
		expect(mocks.run).not.toHaveBeenCalled()
		expect(mocks.invoice).not.toHaveBeenCalled()
	})
	it('rejects malformed JSON and invalid signed quantities', async () => {
		expect((await POST(request('{'))).status).toBe(400)
		for (const seats of [0, -1, 1.5, 100001])
			expect((await POST(request({ ...input, seats }))).status).toBe(400)
	})
	it('keeps reserve off by default but permits read-only inventory and reconciliation', async () => {
		mocks.enabled = false
		expect((await POST(request(input))).status).toBe(503)
		expect(mocks.run).not.toHaveBeenCalled()
		expect((await POST(request({ ...input, mode: 'backfill' }))).status).toBe(
			503,
		)
		expect(
			(await POST(request({ ...input, mode: 'backfill_preview' }))).status,
		).toBe(200)
		expect(mocks.writes).not.toHaveBeenCalled()
		expect((await POST(request({ ...input, mode: 'reconcile' }))).status).toBe(
			200,
		)
		expect(mocks.writes).toHaveBeenCalledOnce()
	})
	it('returns a remaining balance on overspend and never authorizes finalization on unavailable evidence', async () => {
		mocks.run.mockRejectedValueOnce(
			new CreditRefusal('insufficient_credit', {
				seats: 1,
				amountCents: 10000,
			}),
		)
		const refused = await POST(request(input))
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({
			state: 'refused',
			remaining: { seats: 1, amountCents: 10000 },
		})
		mocks.invoice.mockRejectedValueOnce(new Error('unavailable'))
		const held = await POST(request(input))
		expect(held.status).toBe(503)
		expect(await held.json()).toMatchObject({ state: 'hold' })
	})
	it('serves signed balances through the same ledger without Stripe or writes', async () => {
		const result = await POST(
			request({ mode: 'balance', scope: { organizationId: 'org_synthetic' } }),
		)
		expect(result.status).toBe(200)
		expect(mocks.balance).toHaveBeenCalledWith(
			{},
			{ organizationId: 'org_synthetic', stripeCustomerId: '' },
		)
		expect(mocks.invoice).not.toHaveBeenCalled()
		expect(mocks.writes).not.toHaveBeenCalled()
		expect(result.headers.get('cache-control')).toContain('no-store')
	})
})
