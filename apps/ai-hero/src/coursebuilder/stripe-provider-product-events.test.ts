import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	schedule: vi.fn(),
	gift: vi.fn(),
}))
vi.mock('@/env.mjs', () => ({
	env: {
		COURSEBUILDER_URL: 'https://example.test',
		STRIPE_SECRET_TOKEN: 'sk_test_fixture',
		STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
	},
}))
vi.mock('@/lib/subscriber-marketing/product-events-live', () => ({
	scheduleCheckoutProductEvents: mocks.schedule,
}))
vi.mock('@/lib/c5-pricing/gift-checkout', () => ({
	createGiftCheckout: mocks.gift,
}))
vi.mock('@coursebuilder/commerce/stripe-provider', () => ({
	default: (options: unknown) => ({ options }),
	StripePaymentAdapter: class {
		constructor(_config: unknown) {}
		createCheckoutSession(params: unknown, options: unknown) {
			return mocks.create(params, options)
		}
	},
}))
import { stripeProvider } from './stripe-provider'

beforeEach(() => {
	vi.clearAllMocks()
})
it('observes the successful server receipt without changing Stripe inputs or return value', async () => {
	const params = {
		metadata: { userId: 'user-test' },
		line_items: [{ price: 'price_test', quantity: 4 }],
	}
	const options = { idempotencyKey: 'test-idempotency' }
	const session = { id: 'cs_test', metadata: { userId: 'user-test' } }
	mocks.create.mockResolvedValue(session)
	mocks.gift.mockImplementation(async ({ create, params, idempotencyKey }) =>
		create(params, idempotencyKey),
	)
	const adapter = stripeProvider.options.paymentsAdapter!
	expect(await adapter.createCheckoutSession(params, options)).toBe(session)
	expect(mocks.create).toHaveBeenCalledOnce()
	expect(mocks.create).toHaveBeenCalledWith(params, options)
	expect(mocks.schedule).toHaveBeenCalledWith(session, 4)
})
it('does not report a refused or failed checkout', async () => {
	mocks.gift.mockRejectedValueOnce(new Error('synthetic refusal'))
	await expect(
		stripeProvider.options.paymentsAdapter!.createCheckoutSession({}),
	).rejects.toThrow('synthetic refusal')
	expect(mocks.schedule).not.toHaveBeenCalled()
})
