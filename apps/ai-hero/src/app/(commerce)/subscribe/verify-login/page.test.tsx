import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	authorizeExclusiveCouponSelection: vi.fn(async () => ({
		authorized: false,
		requestedPPP: true,
	})),
	browserSession: 'test-browser-session',
	cookies: vi.fn(async () => ({
		get: vi.fn((name: string) =>
			name === '__Host-aih_checkout_login_session'
				? { value: 'test-browser-session' }
				: undefined,
		),
	})),
	handoffIssue: vi.fn(async () => undefined),
	headers: vi.fn(async () => new Headers()),
	redirect: vi.fn((url: string) => url),
}))

vi.mock('@/components/brand/logo', () => ({ Logo: () => null }))
vi.mock('@/components/layout-client', () => ({ default: () => null }))
vi.mock('@/components/login', () => ({ Login: () => null }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
	db: { query: { purchases: { findMany: vi.fn(async () => []) } } },
}))
vi.mock('@/db/schema', () => ({ purchases: {} }))
vi.mock('@/env.mjs', () => ({
	env: {
		COURSEBUILDER_URL: 'https://www.aihero.dev',
		NEXTAUTH_SECRET: 'test_nextauth_secret',
	},
}))
vi.mock('@/lib/exclusive-coupon-authorization', () => ({
	authorizeExclusiveCouponSelection:
		mocks.authorizeExclusiveCouponSelection,
}))
vi.mock('@/lib/checkout-login-handoff-store', () => ({
	checkoutLoginHandoffStore: { issue: mocks.handoffIssue },
}))
vi.mock('@/lib/products-query', () => ({
	getProduct: vi.fn(async () => ({
		id: 'product-crash-course',
		type: 'cohort',
	})),
}))
vi.mock('@/lib/subscriptions', () => ({
	getSubscriptionStatus: vi.fn(async () => ({ hasActiveSubscription: false })),
}))
vi.mock('@/server/auth', () => ({
	getProviders: vi.fn(() => []),
	getServerAuthSession: vi.fn(async () => ({ session: null, ability: null })),
}))
vi.mock('next/headers', () => ({
	cookies: mocks.cookies,
	headers: mocks.headers,
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))

import { hashCheckoutLoginBrowserSession } from '@/lib/checkout-login-browser-session'
import {
	hashCheckoutLoginHandoffNonce,
	verifyCheckoutLoginHandoff,
} from '@/lib/checkout-login-handoff'

import VerifyLoginPage from './page'

const checkoutParams = {
	productId: 'product-crash-course',
	quantity: '1',
	bulk: 'false',
	cancelUrl: '/',
	couponId: 'merchant-active-ppp',
	country: 'US',
}

function callbackUrlFrom(result: unknown) {
	const layout = result as ReactElement<{
		children: ReactElement<{ callbackUrl: string }>
	}>
	return new URL(layout.props.children.props.callbackUrl)
}

describe('verify-login checkout handoff', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.cookies.mockResolvedValue({
			get: vi.fn((name: string) =>
				name === '__Host-aih_checkout_login_session'
					? { value: mocks.browserSession }
					: undefined,
			),
		})
		mocks.authorizeExclusiveCouponSelection.mockResolvedValue({
			authorized: false,
			requestedPPP: true,
		})
	})

	it.each([
		{ trustedCountry: 'TR', forgedCountry: 'US' },
		{ trustedCountry: 'US', forgedCountry: 'TR' },
	])(
		'signs trusted $trustedCountry instead of query $forgedCountry',
		async ({ trustedCountry, forgedCountry }) => {
			mocks.headers.mockResolvedValue(
				new Headers({ 'x-vercel-ip-country': trustedCountry }),
			)

			const result = await VerifyLoginPage({
				searchParams: Promise.resolve({
					...checkoutParams,
					country: forgedCountry,
				}),
			})
			const callbackUrl = callbackUrlFrom(result)
			const token = callbackUrl.searchParams.get('checkoutHandoff')

			expect(callbackUrl.searchParams.get('country')).toBe(trustedCountry)
			expect(token).toBeTruthy()
			const verification = verifyCheckoutLoginHandoff({
				token,
				secret: 'test_nextauth_secret',
				expected: {
					country: trustedCountry,
					productId: checkoutParams.productId,
					quantity: 1,
				},
			})
			expect(verification).toMatchObject({
				valid: true,
				payload: { country: trustedCountry, pppSelected: true },
			})
			if (!verification.valid) throw new Error('expected valid handoff')
			expect(mocks.handoffIssue).toHaveBeenCalledWith(
				expect.objectContaining({
					nonceHash: hashCheckoutLoginHandoffNonce(
						verification.payload.nonce,
					),
					browserSessionHash: hashCheckoutLoginBrowserSession(
						mocks.browserSession,
					),
					payload: verification.payload,
				}),
			)
		},
	)

	it('bootstraps an HttpOnly browser session before issuing a handoff', async () => {
		mocks.cookies.mockResolvedValue({
			get: vi.fn(
				(_name: string): { value: string } | undefined => undefined,
			),
		})
		const redirectError = new Error('redirected')
		mocks.redirect.mockImplementationOnce(() => {
			throw redirectError
		})

		await expect(
			VerifyLoginPage({
				searchParams: Promise.resolve(checkoutParams),
			}),
		).rejects.toBe(redirectError)

		expect(mocks.redirect).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\/subscribe\/verify-login\/browser-session\?returnTo=/,
			),
		)
		expect(mocks.handoffIssue).not.toHaveBeenCalled()
	})
})
