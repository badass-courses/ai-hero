import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	authorizeExclusiveCouponSelection: vi.fn(async () => ({
		authorized: false,
		requestedPPP: true,
	})),
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
vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))

import { verifyCheckoutLoginHandoff } from '@/lib/checkout-login-handoff'

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
		},
	)
})
