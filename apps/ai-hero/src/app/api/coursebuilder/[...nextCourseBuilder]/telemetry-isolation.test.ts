import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({
	emit: vi.fn(),
	log: vi.fn(),
	settle: vi.fn(),
	retrieve: vi.fn(),
	core: vi.fn(),
	decision: 'new_purchase',
}))
vi.mock('@/coursebuilder/course-builder-config', () => ({
	GET: vi.fn(),
	POST: mocks.core,
}))
vi.mock('@/coursebuilder/protect-commerce-request', () => ({
	protectCommerceRequest: async (request: NextRequest) => ({
		request,
		userId: 'user_fixture',
	}),
	authoritativeCheckoutProduct: () => null,
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		options: {
			paymentsAdapter: {
				stripe: {
					webhooks: { constructEvent: (body: string) => JSON.parse(body) },
					checkout: { sessions: { retrieve: mocks.retrieve } },
				},
			},
		},
	},
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/c5-pricing/checkout-siblings', () => ({
	createdCheckoutSessionId: () => 'cs_test_created',
}))
vi.mock('@/lib/c5-pricing/server-checkout', () => ({
	expireC5SiblingSessions: vi.fn(),
}))
vi.mock('@/lib/c5-pricing/trusted-country', () => ({
	trustedCountryFromHeaders: () => null,
	withTrustedPricingCountry: (_country: unknown, run: () => unknown) => run(),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('@/lib/buy-path/server', () => ({ emitBuyPath: mocks.emit }))
vi.mock('@/lib/buy-path/legacy-logger', () => ({
	installBuyPathLegacyAliases: vi.fn(),
}))
vi.mock('@/lib/buy-path/checkout-context', () => ({
	withCheckoutTelemetry: async (_pre: unknown, run: () => unknown) => ({
		value: await run(),
		decisionKind: mocks.decision,
	}),
}))
vi.mock('@/lib/c5-pricing/gift-settlement', () => ({
	settleGiftSession: mocks.settle,
}))
vi.mock('@/server/logger', () => ({ log: { error: mocks.log } }))
import { POST } from './route'
const session = {
	id: 'cs_test_gift',
	amount_total: 90650,
	metadata: { productId: 'product_fixture', userId: 'user_fixture' },
}
beforeEach(() => {
	vi.resetAllMocks()
	mocks.core.mockResolvedValue(new Response(null, { status: 200 }))
	mocks.retrieve.mockResolvedValue(session)
	mocks.emit.mockResolvedValue(undefined)
	mocks.settle.mockResolvedValue(undefined)
	mocks.log.mockResolvedValue(undefined)
})
const webhook = () =>
	new NextRequest('http://localhost/api/coursebuilder/webhook/stripe', {
		method: 'POST',
		headers: { 'stripe-signature': 'fixture-signature' },
		body: JSON.stringify({
			type: 'checkout.session.completed',
			created: 1767225600,
			data: { object: session },
		}),
	})
it.each([false, true])(
	'settles gift slots even if telemetry throws (log also throws: %s)',
	async (logThrows) => {
		mocks.emit.mockRejectedValue(new Error('telemetry unavailable'))
		if (logThrows) mocks.log.mockRejectedValue(new Error('log unavailable'))
		const response = await POST(webhook())
		expect(response.status).toBe(200)
		expect(mocks.settle).toHaveBeenCalledWith(session)
		expect(mocks.retrieve).toHaveBeenCalledWith(session.id)
	},
)
it('reads the amount from the completed webhook, not a telemetry retrieval', async () => {
	await POST(webhook())
	expect(mocks.emit).toHaveBeenCalledWith(
		expect.objectContaining({ buyPathId: session.id }),
		'webhook_received',
		{ amountCents: 90650 },
	)
})
it('redirects checkout without a Stripe retrieval and keeps the captured decision', async () => {
	mocks.core.mockResolvedValue(
		new Response(null, {
			status: 303,
			headers: { location: 'https://checkout.stripe.com/c/pay/fixture' },
		}),
	)
	const response = await POST(
		new NextRequest(
			'http://localhost/api/coursebuilder/checkout/stripe?productId=product_fixture',
			{ method: 'POST' },
		),
	)
	expect(response.status).toBe(303)
	expect(mocks.retrieve).not.toHaveBeenCalled()
	expect(mocks.emit).toHaveBeenCalledWith(
		expect.objectContaining({ buyPathId: 'cs_test_created' }),
		'checkout_created',
		expect.objectContaining({ decisionKind: 'new_purchase' }),
	)
	const call = mocks.emit.mock.calls.find(
		([, step]) => step === 'checkout_created',
	)
	expect(call?.[2]).not.toHaveProperty('amountCents')
	expect(response.headers.get('set-cookie')).toContain('buy_path_session=')
})
