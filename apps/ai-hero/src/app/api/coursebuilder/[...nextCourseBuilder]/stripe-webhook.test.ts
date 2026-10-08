import { NextRequest } from 'next/server'
import Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mounts the real Course Builder route (NextCourseBuilder, the real
// StripePaymentAdapter and this route's cash-balance wrapper) and sends it
// Stripe webhooks signed locally with the dummy STRIPE_WEBHOOK_SECRET from
// src/test/setup.ts. No network, no real keys. Pins the core fix
// (course-builder #1158): a delivery is verified before anything dispatches.

const WEBHOOK_SECRET = 'test_webhook_secret'

const mocks = vi.hoisted(() => ({
	inngestSend: vi.fn().mockResolvedValue({ ids: [] }),
	nextHeaders: () => ({
		headers: async () => new Headers(),
		cookies: async () => ({ get: () => undefined }),
	}),
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock('@/db', () => ({ db: {}, courseBuilderAdapter: {} }))
vi.mock('@/server/auth', () => ({
	authOptions: {},
	getServerAuthSession: async () => ({ session: null, ability: null }),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
// @coursebuilder/next imports next/headers.js; the route needs no request scope.
vi.mock('next/headers', () => mocks.nextHeaders())
vi.mock('next/headers.js', () => mocks.nextHeaders())

import { POST } from './route'

const stripe = new Stripe('sk_test_dummy_token')

const invoiceEvent = {
	id: 'evt_aihero_webhook_1',
	object: 'event',
	type: 'invoice.payment_succeeded',
	data: {
		object: {
			id: 'in_aihero_webhook_1',
			object: 'invoice',
			subscription: null,
			charge: 'ch_aihero_webhook_1',
			customer: 'cus_aihero_webhook_1',
			amount_paid: 1000,
			currency: 'usd',
			status: 'paid',
		},
	},
}

const cashBalanceEvent = {
	id: 'evt_aihero_cash_balance_1',
	object: 'event',
	type: 'cash_balance.funds_available',
	data: {
		object: { object: 'cash_balance', customer: 'cus_aihero_webhook_1' },
	},
}

const sign = (payload: string, secret = WEBHOOK_SECRET) =>
	stripe.webhooks.generateTestHeaderString({ payload, secret })

const post = (payload: string, signature?: string) =>
	POST(
		new NextRequest('http://localhost:3000/api/coursebuilder/webhook/stripe', {
			method: 'POST',
			body: payload,
			headers: {
				'content-type': 'application/json',
				...(signature ? { 'stripe-signature': signature } : {}),
			},
		}),
	)

describe('Course Builder Stripe webhook route', () => {
	beforeEach(() => {
		mocks.inngestSend.mockClear()
	})

	it('accepts a validly signed delivery and dispatches it', async () => {
		const payload = JSON.stringify(invoiceEvent)

		const response = await post(payload, sign(payload))

		expect(response.status).not.toBe(400)
		expect(response.ok).toBe(true)
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
	})

	it('dispatches cash-balance reconciliation for a validly signed delivery', async () => {
		const payload = JSON.stringify(cashBalanceEvent)

		const response = await post(payload, sign(payload))

		expect(response.ok).toBe(true)
		expect(mocks.inngestSend).toHaveBeenCalledWith(
			expect.objectContaining({
				id: cashBalanceEvent.id,
				data: expect.objectContaining({
					customerId: 'cus_aihero_webhook_1',
				}),
			}),
		)
	})

	it('rejects a forged signature with 400 and dispatches nothing', async () => {
		const payload = JSON.stringify(invoiceEvent)

		const response = await post(payload, sign(payload, 'whsec_forged_secret'))

		expect(response.status).toBe(400)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('rejects a forged cash-balance delivery before reconciliation', async () => {
		const payload = JSON.stringify(cashBalanceEvent)

		const response = await post(payload, sign(payload, 'whsec_forged_secret'))

		expect(response.status).toBe(400)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('rejects a missing stripe-signature header with 400', async () => {
		const response = await post(JSON.stringify(invoiceEvent))

		expect(response.status).toBe(400)
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})
})
