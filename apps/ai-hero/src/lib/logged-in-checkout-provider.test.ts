import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'

import type { CheckoutLoginHandoffPayload } from '@/lib/checkout-login-handoff'
import type {
	CheckoutLoginHandoffClaim,
	CheckoutLoginHandoffStore,
} from '@/lib/checkout-login-handoff-store'
import { createLoggedInCheckoutSession } from '@/lib/logged-in-checkout-provider'

import {
	MockCourseBuilderAdapter,
	type CourseBuilderAdapter,
} from '@coursebuilder/core/adapters'
import StripeProvider, {
	mockStripeAdapter,
} from '@coursebuilder/core/providers/stripe'
import type {
	CheckoutSessionRequestOptions,
	PaymentsAdapter,
} from '@coursebuilder/core/types'

const claim: CheckoutLoginHandoffClaim = {
	nonceHash: 'a'.repeat(64),
	claimId: 'claim-provider-test',
	userId: 'user-provider-test',
}
const handoffPayload: CheckoutLoginHandoffPayload = {
	version: 1,
	country: 'TR',
	pppSelected: true,
	productId: 'product-provider-test',
	quantity: 1,
	issuedAt: new Date('2026-08-19T12:00:00.000Z').getTime(),
	expiresAt: new Date('2026-08-19T12:10:00.000Z').getTime(),
	nonce: 'provider-test-nonce',
}
const checkoutParams = {
	productId: handoffPayload.productId,
	quantity: 1,
	bulk: false,
	country: 'TR',
	cancelUrl: 'https://example.test/cancel',
	userId: claim.userId,
}

function courseAdapter(): CourseBuilderAdapter {
	return {
		...MockCourseBuilderAdapter,
		getUser: vi.fn(async (id: string) => ({
			id,
			email: 'learner@example.test',
		}) as never),
		getProduct: vi.fn(async () => ({
			id: handoffPayload.productId,
			name: 'Provider Test Product',
			type: 'self-paced',
			status: 1,
			createdAt: new Date('2026-08-01T00:00:00.000Z'),
		}) as never),
		getPriceForProduct: vi.fn(async () => ({
			id: 'price-provider-test',
			productId: handoffPayload.productId,
			unitAmount: 299,
			status: 1,
			createdAt: new Date('2026-08-01T00:00:00.000Z'),
		}) as never),
		getPurchase: vi.fn(async () => null),
		getPurchasesForUser: vi.fn(async () => []),
		getMerchantCustomerForUserId: vi.fn(async () => ({
			id: 'merchant-customer-provider-test',
			identifier: 'cus_provider_test',
		}) as never),
		getMerchantProductForProductId: vi.fn(async () => ({
			id: 'merchant-product-provider-test',
			identifier: 'prod_provider_test',
			productId: handoffPayload.productId,
			merchantAccountId: 'merchant-provider-test',
			status: 1,
			createdAt: new Date('2026-08-01T00:00:00.000Z'),
		}) as never),
		getMerchantPriceForProductId: vi.fn(async () => ({
			id: 'merchant-price-provider-test',
			identifier: 'price_provider_test',
			merchantProductId: 'merchant-product-provider-test',
			priceId: 'price-provider-test',
			status: 1,
			createdAt: new Date('2026-08-01T00:00:00.000Z'),
		}) as never),
		getDefaultCoupon: vi.fn(async () => null),
		getEntitlementTypeByName: vi.fn(async () => null),
		getEntitlementsForUser: vi.fn(async () => []),
	} as unknown as CourseBuilderAdapter
}

function provider(paymentsAdapter: PaymentsAdapter) {
	return StripeProvider({
		baseSuccessUrl: 'https://example.test',
		cancelUrl: 'https://example.test/cancel',
		errorRedirectUrl: 'https://example.test/error',
		paymentsAdapter,
	})
}

function store(overrides: Partial<CheckoutLoginHandoffStore> = {}) {
	return {
		issue: vi.fn(async () => undefined),
		claim: vi.fn(async () => ({ kind: 'missing' as const })),
		complete: vi.fn(async () => true),
		failRetryable: vi.fn(async () => true),
		failTerminal: vi.fn(async () => true),
		...overrides,
	} satisfies CheckoutLoginHandoffStore
}

function checkoutSession(
	params: Stripe.Checkout.SessionCreateParams,
): Stripe.Checkout.Session {
	const subtotal = Number(params.metadata?.subtotalCents)
	const total = Number(params.metadata?.expectedTotalCents)
	return {
		id: 'cs_test_provider_recovery',
		url: 'https://checkout.stripe.com/c/pay/cs_test_provider_recovery',
		amount_subtotal: subtotal,
		amount_total: total,
		total_details: {
			amount_discount: subtotal - total,
			amount_shipping: 0,
			amount_tax: 0,
		},
	} as Stripe.Checkout.Session
}

describe('logged-in checkout provider boundary', () => {
	it('does not complete when the real Course Builder provider reports failure', async () => {
		const handoffStore = store()
		const paymentsAdapter = {
			...mockStripeAdapter,
			getPrice: vi.fn(async () => ({ recurring: null }) as never),
			createCheckoutSession: vi.fn(async () => {
				throw new Error('stripe-timeout')
			}),
		} satisfies PaymentsAdapter

		const result = await createLoggedInCheckoutSession({
			provider: provider(paymentsAdapter),
			adapter: courseAdapter(),
			handoffStore,
			claim,
			handoffPayload,
			checkoutParams,
		})

		expect(result).toEqual({
			kind: 'failure',
			failure: { code: 'stripe-timeout', retryable: true },
		})
		expect(handoffStore.complete).not.toHaveBeenCalled()
		expect(handoffStore.failRetryable).toHaveBeenCalledWith({ claim })
	})

	it('never stores an error or base URL as a completed receipt', async () => {
		const handoffStore = store()
		const fakeProvider = {
			...provider(mockStripeAdapter),
			createCheckoutSessionResult: vi.fn(async () => ({
				kind: 'success' as const,
				providerSessionId: 'cs_test_bad_redirect',
				redirect: 'https://example.test/error',
			})),
		}

		const result = await createLoggedInCheckoutSession({
			provider: fakeProvider,
			adapter: courseAdapter(),
			handoffStore,
			claim,
			handoffPayload,
			checkoutParams,
		})

		expect(result).toEqual({
			kind: 'failure',
			failure: {
				code: 'invalid-stripe-checkout-receipt',
				retryable: false,
			},
		})
		expect(handoffStore.complete).not.toHaveBeenCalled()
		expect(handoffStore.failTerminal).toHaveBeenCalled()
	})

	it('recovers the same provider session after completion storage fails', async () => {
		const sessions = new Map<string, Stripe.Checkout.Session>()
		let providerCreates = 0
		const requestKeys: string[] = []
		const paymentsAdapter = {
			...mockStripeAdapter,
			getPrice: vi.fn(async () => ({ recurring: null }) as never),
			createCheckoutSession: vi.fn(
				async (
					params: Stripe.Checkout.SessionCreateParams,
					request?: CheckoutSessionRequestOptions,
				) => {
					if (!request?.idempotencyKey) {
						throw new Error('missing-idempotency-key')
					}
					requestKeys.push(request.idempotencyKey)
					let session = sessions.get(request.idempotencyKey)
					if (!session) {
						providerCreates += 1
						session = checkoutSession(params)
						sessions.set(request.idempotencyKey, session)
					}
					return session
				},
			),
		} satisfies PaymentsAdapter
		const complete = vi
			.fn<
				Parameters<CheckoutLoginHandoffStore['complete']>,
				ReturnType<CheckoutLoginHandoffStore['complete']>
			>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true)
		const handoffStore = store({ complete })
		const realProvider = provider(paymentsAdapter)

		await expect(
			createLoggedInCheckoutSession({
				provider: realProvider,
				adapter: courseAdapter(),
				handoffStore,
				claim,
				handoffPayload,
				checkoutParams,
			}),
		).rejects.toThrow('checkout-login-handoff-receipt-write-failed')
		const recovered = await createLoggedInCheckoutSession({
			provider: realProvider,
			adapter: courseAdapter(),
			handoffStore,
			claim,
			handoffPayload,
			checkoutParams,
		})

		expect(recovered).toMatchObject({
			kind: 'success',
			providerSessionId: 'cs_test_provider_recovery',
		})
		expect(providerCreates).toBe(1)
		expect(requestKeys).toHaveLength(2)
		expect(new Set(requestKeys).size).toBe(1)
		expect(handoffStore.failRetryable).toHaveBeenCalled()
		expect(complete).toHaveBeenCalledTimes(2)
	})
})
