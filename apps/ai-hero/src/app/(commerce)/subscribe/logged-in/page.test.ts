import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CheckoutSessionResult } from '@coursebuilder/core/types'

const mocks = vi.hoisted(() => {
	const merchantCoupon = {
		id: 'merchant-prior-credit',
		type: 'special credit',
		status: 1,
	}
	const pppMerchantCoupon = {
		id: 'merchant-requested-ppp',
		type: 'ppp',
		status: 1,
	}
	const inactivePppMerchantCoupon = {
		id: 'merchant-inactive-ppp',
		type: 'ppp',
		status: 0,
	}
	const coupon = {
		id: 'coupon-prior-credit',
		merchantCouponId: merchantCoupon.id,
		restrictedToProductId: 'product-crash-course',
		fields: { exclusive: true },
		status: 1,
		expires: null,
		maxUses: -1,
		usedCount: 0,
	}
	const entitlement = {
		id: 'entitlement-prior-credit',
		userId: 'user-actual',
		sourceType: 'COUPON',
		sourceId: coupon.id,
		entitlementType: 'entitlement-type-special-credit',
		deletedAt: null,
		expiresAt: null,
	}
	const getEntitlementsForUser = vi.fn()
	let lifecycleState:
		| 'issued'
		| 'consuming'
		| 'completed'
		| 'failed_retryable'
		| 'failed_terminal' = 'issued'
	let boundUserId: string | undefined
	let completedReceipt:
		| { providerSessionId: string; redirect: string }
		| undefined
	let expectedBrowserSessionHash = ''
	const claim = vi.fn(
		async (input: {
			browserSessionHash: string
			nonceHash: string
			userId: string
		}) => {
			if (input.browserSessionHash !== expectedBrowserSessionHash) {
				return { kind: 'browser-mismatch' as const }
			}
			if (boundUserId && boundUserId !== input.userId) {
				return { kind: 'user-mismatch' as const }
			}
			if (lifecycleState === 'completed' && completedReceipt) {
				return { kind: 'completed' as const, receipt: completedReceipt }
			}
			if (
				lifecycleState !== 'issued' &&
				lifecycleState !== 'failed_retryable'
			) {
				return { kind: 'replayed' as const, state: lifecycleState }
			}
			lifecycleState = 'consuming'
			boundUserId = input.userId
			return {
				kind: 'acquired' as const,
				claim: {
					nonceHash: input.nonceHash,
					claimId: 'claim-test',
					userId: input.userId,
				},
			}
		},
	)
	const complete = vi.fn(
		async (input: {
			receipt: { providerSessionId: string; redirect: string }
			claim: { userId: string }
		}) => {
			if (
				lifecycleState !== 'consuming' ||
				boundUserId !== input.claim.userId
			) {
				return false
			}
			lifecycleState = 'completed'
			completedReceipt = input.receipt
			return true
		},
	)
	const failRetryable = vi.fn(
		async (input: { claim: { userId: string } }) => {
			if (
				lifecycleState !== 'consuming' ||
				boundUserId !== input.claim.userId
			) {
				return false
			}
			lifecycleState = 'failed_retryable'
			return true
		},
	)
	const failTerminal = vi.fn(
		async (input: { claim: { userId: string } }) => {
			if (
				lifecycleState !== 'consuming' ||
				boundUserId !== input.claim.userId
			) {
				return false
			}
			lifecycleState = 'failed_terminal'
			return true
		},
	)
	const getServerAuthSession = vi.fn(async () => ({
		session: { user: { id: 'user-actual' } },
	}))
	return {
		browserSession: 'browser-session-a',
		claim,
		complete,
		coupon,
		createCheckoutSession: vi.fn(
			async (): Promise<CheckoutSessionResult> => ({
				kind: 'success',
				providerSessionId: 'cs_test_logged_in',
				redirect: 'https://checkout.stripe.com/c/pay/cs_test_logged_in',
			}),
		),
		entitlement,
		failRetryable,
		failTerminal,
		getEntitlementsForUser,
		getServerAuthSession,
		headers: vi.fn(async () => new Headers()),
		inactivePppMerchantCoupon,
		merchantCoupon,
		pppMerchantCoupon,
		redirect: vi.fn((url: string) => url),
		resetLifecycle(browserSessionHash: string) {
			lifecycleState = 'issued'
			boundUserId = undefined
			completedReceipt = undefined
			expectedBrowserSessionHash = browserSessionHash
		},
		resolveServerComputedCheckoutCoupon: vi.fn(
			async (): Promise<{ id: string; type: string } | null> => null,
		),
	}
})

vi.mock('@/coursebuilder/server-computed-checkout-coupon', () => ({
	resolveServerComputedCheckoutCoupon:
		mocks.resolveServerComputedCheckoutCoupon,
}))
vi.mock('@/coursebuilder/stripe-provider', () => ({
	stripeProvider: {
		createCheckoutSessionResult: mocks.createCheckoutSession,
	},
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getMerchantCoupon: vi.fn(async (id: string) =>
			[
				mocks.merchantCoupon,
				mocks.pppMerchantCoupon,
				mocks.inactivePppMerchantCoupon,
			].find((coupon) => coupon.id === id) ?? null,
		),
		getCoupon: vi.fn(async (id: string) =>
			id === mocks.coupon.id ? mocks.coupon : null,
		),
		getEntitlementTypeByName: vi.fn(async () => ({
			id: 'entitlement-type-special-credit',
		})),
		getEntitlementsForUser: mocks.getEntitlementsForUser,
	},
}))
vi.mock('@/lib/checkout-login-handoff-store', () => ({
	checkoutLoginHandoffStore: {
		claim: mocks.claim,
		complete: mocks.complete,
		failRetryable: mocks.failRetryable,
		failTerminal: mocks.failTerminal,
	},
}))
vi.mock('@/lib/checkout-subscriber-attribution', () => ({
	addKitSubscriberToCheckoutAttribution: vi.fn(() => ({})),
}))
vi.mock('@/lib/subscriptions', () => ({
	getSubscriptionStatus: vi.fn(async () => ({ hasActiveSubscription: false })),
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('next/headers', () => ({
	cookies: vi.fn(async () => ({
		get: vi.fn((name: string) =>
			name === '__Host-aih_checkout_login_session'
				? { value: mocks.browserSession }
				: undefined,
		),
	})),
	headers: mocks.headers,
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@coursebuilder/core/lib/checkout-attribution', () => ({
	buildCheckoutAttribution: vi.fn(() => ({})),
}))

import { hashCheckoutLoginBrowserSession } from '@/lib/checkout-login-browser-session'
import { createCheckoutLoginHandoff } from '@/lib/checkout-login-handoff'

import LoginPage from './page'

const handoffSecret = 'test_nextauth_secret'
const searchParams = {
	productId: 'product-crash-course',
	quantity: '1',
	bulk: 'false',
	cancelUrl: '/',
	couponId: mocks.merchantCoupon.id,
	usedCouponId: mocks.coupon.id,
	userId: 'user-forged',
}

const signedHandoff = ({
	country = 'TR',
	productId = searchParams.productId,
	quantity = 1,
	now = new Date(),
}: {
	country?: string
	productId?: string
	quantity?: number
	now?: Date
} = {}) =>
	createCheckoutLoginHandoff({
		secret: handoffSecret,
		country,
		pppSelected: true,
		productId,
		quantity,
		nonce: 'nonce-logged-in-test',
		now,
	})

describe('logged-in checkout coupon authorization', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.browserSession = 'browser-session-a'
		mocks.resetLifecycle(
			hashCheckoutLoginBrowserSession(mocks.browserSession),
		)
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'user-actual' } },
		})
		mocks.headers.mockResolvedValue(new Headers())
		mocks.resolveServerComputedCheckoutCoupon.mockResolvedValue(null)
	})

	it('removes an unowned exclusive selector before Stripe checkout', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([])

		await LoginPage({ searchParams: Promise.resolve(searchParams) })

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: undefined,
				usedCouponId: undefined,
				userId: 'user-actual',
			}),
			expect.anything(),
		)
	})

	it('preserves the selector for its entitled owner', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])

		await LoginPage({ searchParams: Promise.resolve(searchParams) })

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: mocks.merchantCoupon.id,
				usedCouponId: mocks.coupon.id,
				userId: 'user-actual',
			}),
			expect.anything(),
		)
	})

	it('replaces callback provenance with the entitlement source coupon', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])

		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				usedCouponId: 'coupon-untrusted',
			}),
		})

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: mocks.merchantCoupon.id,
				usedCouponId: mocks.coupon.id,
			}),
			expect.anything(),
		)
	})

	it('forwards a server-computed bulk coupon after rejecting raw input', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])
		mocks.resolveServerComputedCheckoutCoupon.mockResolvedValue({
			id: 'merchant-server-bulk',
			type: 'bulk',
		})

		await LoginPage({
			searchParams: Promise.resolve({ ...searchParams, quantity: '5' }),
		})

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: 'merchant-server-bulk',
				usedCouponId: undefined,
				quantity: 5,
			}),
			expect.anything(),
		)
	})

	it('rejects the selector when checkout quantity is zero', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])

		await LoginPage({
			searchParams: Promise.resolve({ ...searchParams, quantity: '0' }),
		})

		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				couponId: undefined,
				usedCouponId: undefined,
				quantity: 0,
			}),
			expect.anything(),
		)
	})

	it('accepts a valid signed Turkey PPP handoff', async () => {
		mocks.resolveServerComputedCheckoutCoupon.mockResolvedValue({
			id: 'merchant-server-ppp-70',
			type: 'ppp',
		})

		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				country: 'TR',
				couponId: mocks.pppMerchantCoupon.id,
				usedCouponId: undefined,
				checkoutHandoff: signedHandoff(),
			}),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'TR' }),
		)
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				country: 'TR',
				couponId: 'merchant-server-ppp-70',
				usedCouponId: undefined,
			}),
			expect.anything(),
			expect.objectContaining({
				idempotencyKey: expect.stringMatching(/^aih-login-checkout:/),
			}),
		)
	})

	it('returns the completed checkout receipt on sequential replay', async () => {
		const params = {
			...searchParams,
			country: 'TR',
			couponId: mocks.pppMerchantCoupon.id,
			usedCouponId: undefined,
			checkoutHandoff: signedHandoff(),
		}

		await LoginPage({ searchParams: Promise.resolve(params) })
		await LoginPage({ searchParams: Promise.resolve(params) })

		expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)
		expect(mocks.complete).toHaveBeenCalledTimes(1)
		expect(mocks.redirect).toHaveBeenLastCalledWith(
			'https://checkout.stripe.com/c/pay/cs_test_logged_in',
		)
	})

	it('allows exactly one provider call for concurrent handoff consumers', async () => {
		let releaseProvider:
			| ((value: {
					kind: 'success'
					providerSessionId: string
					redirect: string
			  }) => void)
			| undefined
		mocks.createCheckoutSession.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseProvider = resolve
				}),
		)
		const params = {
			...searchParams,
			country: 'TR',
			couponId: mocks.pppMerchantCoupon.id,
			usedCouponId: undefined,
			checkoutHandoff: signedHandoff(),
		}

		const first = LoginPage({ searchParams: Promise.resolve(params) })
		await vi.waitFor(() => {
			expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)
		})
		await LoginPage({ searchParams: Promise.resolve(params) })

		expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)
		expect(mocks.redirect).toHaveBeenCalledWith(
			'/subscribe/error?reason=replayed-consuming',
		)
		releaseProvider?.({
			kind: 'success',
			providerSessionId: 'cs_test_logged_in',
			redirect: 'https://checkout.stripe.com/c/pay/cs_test_logged_in',
		})
		await first
	})

	it('rejects replay from another authenticated user', async () => {
		const params = {
			...searchParams,
			country: 'TR',
			couponId: mocks.pppMerchantCoupon.id,
			usedCouponId: undefined,
			checkoutHandoff: signedHandoff(),
		}
		await LoginPage({ searchParams: Promise.resolve(params) })
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'user-other' } },
		})

		await LoginPage({ searchParams: Promise.resolve(params) })

		expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)
		expect(mocks.redirect).toHaveBeenCalledWith(
			'/subscribe/error?reason=user-mismatch',
		)
	})

	it('rejects a transferred token without its HttpOnly browser session', async () => {
		mocks.browserSession = 'browser-session-b'

		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				country: 'TR',
				couponId: mocks.pppMerchantCoupon.id,
				usedCouponId: undefined,
				checkoutHandoff: signedHandoff(),
			}),
		})

		expect(mocks.createCheckoutSession).not.toHaveBeenCalled()
		expect(mocks.redirect).toHaveBeenCalledWith(
			'/subscribe/error?reason=browser-mismatch',
		)
	})

	it('releases a typed retryable provider failure so the same user can retry', async () => {
		mocks.createCheckoutSession.mockResolvedValueOnce({
			kind: 'failure',
			failure: { code: 'transient-provider-failure', retryable: true },
		})
		const params = {
			...searchParams,
			country: 'TR',
			couponId: mocks.pppMerchantCoupon.id,
			usedCouponId: undefined,
			checkoutHandoff: signedHandoff(),
		}

		await LoginPage({ searchParams: Promise.resolve(params) })
		await LoginPage({ searchParams: Promise.resolve(params) })

		expect(mocks.redirect).toHaveBeenCalledWith(
			'/subscribe/error?reason=transient-provider-failure',
		)
		expect(mocks.failRetryable).toHaveBeenCalledTimes(1)
		expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(2)
		expect(mocks.complete).toHaveBeenCalledTimes(1)
	})

	it.each([
		['a trusted US header', new Headers({ 'x-vercel-ip-country': 'US' })],
		['no country header', new Headers()],
	])(
		'does not honor forged Turkey country with %s and no valid handoff',
		async (_, callbackHeaders) => {
			mocks.headers.mockResolvedValue(callbackHeaders)

			await LoginPage({
				searchParams: Promise.resolve({
					...searchParams,
					country: 'TR',
					couponId: mocks.pppMerchantCoupon.id,
					usedCouponId: undefined,
				}),
			})

			expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
				expect.objectContaining({ country: 'US' }),
			)
			expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
				expect.objectContaining({
					country: 'US',
					couponId: undefined,
				}),
				expect.anything(),
			)
		},
	)

	it('does not let an inactive PPP selector authorize the signed country', async () => {
		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				country: 'TR',
				couponId: mocks.inactivePppMerchantCoupon.id,
				usedCouponId: undefined,
				checkoutHandoff: signedHandoff(),
			}),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'US' }),
		)
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'US', couponId: undefined }),
			expect.anything(),
			expect.objectContaining({
				idempotencyKey: expect.stringMatching(/^aih-login-checkout:/),
			}),
		)
	})

	it.each([
		[
			'tampered',
			() => {
				const token = signedHandoff()
				return `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
			},
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'expired',
			() => signedHandoff({ now: new Date(Date.now() - 11 * 60 * 1000) }),
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'product-mismatched',
			() => signedHandoff({ productId: 'product-other' }),
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'quantity-mismatched',
			() => signedHandoff({ quantity: 2 }),
			{ country: 'TR', productId: searchParams.productId, quantity: '1' },
		],
		[
			'country-mismatched',
			() => signedHandoff({ country: 'TR' }),
			{ country: 'TH', productId: searchParams.productId, quantity: '1' },
		],
	] as const)(
		'rejects a %s signed handoff before pricing or provider work',
		async (_, handoff, callbackParams) => {
			await LoginPage({
				searchParams: Promise.resolve({
					...searchParams,
					...callbackParams,
					couponId: mocks.pppMerchantCoupon.id,
					usedCouponId: undefined,
					checkoutHandoff: handoff(),
				}),
			})

			expect(mocks.resolveServerComputedCheckoutCoupon).not.toHaveBeenCalled()
			expect(mocks.createCheckoutSession).not.toHaveBeenCalled()
			expect(mocks.redirect).toHaveBeenCalledWith(
				expect.stringMatching(/^\/subscribe\/error\?reason=invalid-/),
			)
		},
	)

	it('uses the trusted callback country for an alumni-only checkout', async () => {
		mocks.getEntitlementsForUser.mockResolvedValue([mocks.entitlement])
		mocks.headers.mockResolvedValue(
			new Headers({ 'x-vercel-ip-country': 'CA' }),
		)

		await LoginPage({
			searchParams: Promise.resolve({ ...searchParams, country: 'TR' }),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).not.toHaveBeenCalled()
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				country: 'CA',
				couponId: mocks.merchantCoupon.id,
				usedCouponId: mocks.coupon.id,
			}),
			expect.anything(),
		)
	})

	it('keeps an ineligible signed US PPP region without inventing a coupon', async () => {
		await LoginPage({
			searchParams: Promise.resolve({
				...searchParams,
				country: 'US',
				couponId: mocks.pppMerchantCoupon.id,
				usedCouponId: undefined,
				checkoutHandoff: signedHandoff({ country: 'US' }),
			}),
		})

		expect(mocks.resolveServerComputedCheckoutCoupon).toHaveBeenCalledWith(
			expect.objectContaining({ country: 'US' }),
		)
		expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
			expect.objectContaining({
				country: 'US',
				couponId: undefined,
				usedCouponId: undefined,
			}),
			expect.anything(),
			expect.objectContaining({
				idempotencyKey: expect.stringMatching(/^aih-login-checkout:/),
			}),
		)
	})
})
