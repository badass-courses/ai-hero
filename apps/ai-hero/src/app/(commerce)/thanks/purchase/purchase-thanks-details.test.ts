import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPurchaseThanksDetails } from './purchase-thanks-details'

const mocks = vi.hoisted(() => ({ getPurchaseInfo: vi.fn(), check: vi.fn() }))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: { getPurchaseInfo: mocks.getPurchaseInfo },
}))
vi.mock('@/db', () => ({ courseBuilderAdapter: {} }))
vi.mock('@coursebuilder/commerce', () => ({
	checkForPaymentSuccessWithoutPurchase: mocks.check,
}))
vi.mock(
	'@coursebuilder/commerce-next/utils/serialize-for-next-response',
	() => ({ convertToSerializeForNextResponse: (value: unknown) => value }),
)
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

describe('post-retry purchase recovery, never a paid-buyer 404', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})
	it('returns a support state, not notFound, when no Stripe fallback exists', async () => {
		mocks.check.mockResolvedValue({ shouldShowError: false })
		expect(
			await getPurchaseThanksDetails('cs_test_synthetic', { maxRetries: 0 }),
		).toEqual({ processingUnconfirmed: true })
	})
	it('still returns a support state if the Stripe fallback is unavailable', async () => {
		mocks.check.mockRejectedValue(new Error('provider unavailable'))
		expect(
			await getPurchaseThanksDetails('cs_test_synthetic', { maxRetries: 0 }),
		).toEqual({ processingUnconfirmed: true })
	})
	it('preserves payment-confirmed failure only with Stripe evidence', async () => {
		mocks.check.mockResolvedValue({
			shouldShowError: true,
			stripeEventId: 'evt_synthetic',
		})
		expect(
			await getPurchaseThanksDetails('cs_test_synthetic', { maxRetries: 0 }),
		).toEqual({ paymentSucceededButProcessingFailed: true })
	})
})
