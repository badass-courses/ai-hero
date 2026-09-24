// @vitest-environment happy-dom
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TRPCClientError } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({ search: '' }))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
	usePathname: () => '/workshops/ai-coding-crash-course',
	useSearchParams: () => new URLSearchParams(testState.search),
}))
vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: 'unauthenticated' }),
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'http://localhost:3000' },
}))
vi.mock('@/utils/analytics', () => ({ track: vi.fn() }))
// The published coupon-context module imports an extensionless sibling that
// Node's Vitest loader cannot resolve. Keep only its inert context boundary.
vi.mock('@coursebuilder/commerce-next/coupons/coupon-context', async () => ({
	CouponContext: (await import('react')).createContext({}),
}))
vi.mock('@coursebuilder/commerce-next/coupons/use-coupon', () => ({
	useCoupon: (coupon?: { isValid: boolean }) => ({
		validCoupon: Boolean(coupon?.isValid),
		redeemableCoupon: false,
		RedeemDialogForCoupon: () => null,
	}),
}))
vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => null,
}))
// The sidebar pulls in server-only content and Stripe modules; the actual
// production inline button and its Pricing.Root actor stay mounted below.
vi.mock('./workshop-pricing-widget-container', () => ({
	WorkshopPricingWidgetContainer: () => null,
}))

import { api } from '@/trpc/react'
import { WorkshopInlineBuyButton } from './workshop-pricing'

const product = {
	id: 'product-ma254',
	name: 'AI Coding Crash Course',
	status: 1,
	type: 'live',
	quantityAvailable: -1,
	fields: { state: 'published' },
} as any
const pricingDataLoader = Promise.resolve({
	formattedPrice: null,
	purchaseToUpgrade: null,
	quantityAvailable: -1,
}) as any
const couponId = 'coupon-valid'
const merchantCouponId = 'merchant-coupon-valid'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
	;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
	process.env.NEXT_PUBLIC_URL = 'http://localhost:3000'
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})

afterEach(async () => {
	await act(async () => root.unmount())
	host.remove()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('workshop coupon actor lifecycle', () => {
	it.each(['coupon=coupon-valid', 'code=SAVE199'])(
		'mounts without a coupon, then renders $199 and an authorized checkout after %s resolves',
		async (search) => {
			testState.search = search
			let resolveCommerce!: (value: unknown) => void
			const commerceResult = new Promise<unknown>((resolve) => {
				resolveCommerce = resolve
			})
			const queryClient = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			})
			const trpcClient = api.createClient({
				links: [
					() =>
						({ op }) =>
							observable((observer) => {
								if (op.path !== 'pricing.propsForCommerce') {
									observer.error(
										TRPCClientError.from(
											new Error(`Unexpected query: ${op.path}`),
										),
									)
									return
								}
								void commerceResult.then((data) => {
									observer.next({ result: { data } })
									observer.complete()
								})
							}),
				],
			})
			const priceRequests: Array<string | undefined> = []
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string, options?: RequestInit) => {
					if (url !== '/api/coursebuilder/prices-formatted') {
						throw new Error(`Expected same-origin price request, got ${url}`)
					}
					const body = JSON.parse(String(options?.body)) as {
						couponId?: string
					}
					priceRequests.push(body.couponId)
					return new Response(
						JSON.stringify({
							id: product.id,
							fullPrice: 299,
							calculatedPrice: body.couponId === couponId ? 199 : 299,
							usedCouponId: body.couponId ?? null,
							appliedMerchantCoupon:
								body.couponId === couponId ? { id: merchantCouponId } : null,
						}),
						{ status: 200, headers: { 'Content-Type': 'application/json' } },
					)
				}),
			)

			await act(async () => {
				root.render(
					<QueryClientProvider client={queryClient}>
						<api.Provider client={trpcClient} queryClient={queryClient}>
							<WorkshopInlineBuyButton
								pricingProps={{ products: [product] } as any}
								pricingDataLoader={pricingDataLoader}
								resource={{ fields: { slug: 'ai-coding-crash-course' } } as any}
								resourceType="workshop"
							/>
						</api.Provider>
					</QueryClientProvider>,
				)
			})
			expect(host.textContent).toContain('Checking your coupon')
			expect(host.querySelector('form')).toBeNull()
			expect(priceRequests).toEqual([])

			await act(async () => {
				resolveCommerce({ products: [product], couponIdFromCoupon: couponId })
				await commerceResult
				// React Query notifies subscribers on its scheduler, after the tRPC
				// observable resolves; keep that notification inside React.act.
				await new Promise((resolve) => setTimeout(resolve, 20))
			})
			expect(host.textContent).toContain('$199')
			expect(priceRequests).toEqual([couponId])
			const form = host.querySelector('form[action]')
			expect(form).not.toBeNull()
			const checkout = new URL(
				form!.getAttribute('action')!,
				'http://localhost',
			)
			expect(checkout.pathname).toBe('/api/coursebuilder/checkout/stripe')
			expect(checkout.searchParams.get('productId')).toBe(product.id)
			expect(checkout.searchParams.get('couponId')).toBe(merchantCouponId)
			expect(checkout.searchParams.get('usedCouponId')).toBe(couponId)
		},
	)

	it('shows a failed price request instead of a loading spinner or $0 checkout', async () => {
		testState.search = 'coupon=coupon-valid'
		let resolveCommerce!: (value: unknown) => void
		const commerceResult = new Promise<unknown>((resolve) => {
			resolveCommerce = resolve
		})
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		})
		const trpcClient = api.createClient({
			links: [
				() =>
					({ op }) =>
						observable((observer) => {
							if (op.path !== 'pricing.propsForCommerce') {
								observer.error(
									TRPCClientError.from(
										new Error(`Unexpected query: ${op.path}`),
									),
								)
								return
							}
							void commerceResult.then((data) => {
								observer.next({ result: { data } })
								observer.complete()
							})
						}),
			],
		})
		const fetchPrice = vi.fn(async (url: string) => {
			expect(url).toBe('/api/coursebuilder/prices-formatted')
			return new Response('unavailable', { status: 503 })
		})
		vi.stubGlobal('fetch', fetchPrice)

		await act(async () => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<api.Provider client={trpcClient} queryClient={queryClient}>
						<WorkshopInlineBuyButton
							pricingProps={{ products: [product] } as any}
							pricingDataLoader={pricingDataLoader}
							resource={{ fields: { slug: 'ai-coding-crash-course' } } as any}
							resourceType="workshop"
						/>
					</api.Provider>
				</QueryClientProvider>,
			)
		})
		await act(async () => {
			resolveCommerce({ products: [product], couponIdFromCoupon: couponId })
			await commerceResult
			await new Promise((resolve) => setTimeout(resolve, 20))
		})
		expect(fetchPrice).toHaveBeenCalledTimes(1)
		expect(host.textContent).toContain('Price unavailable')
		expect(host.textContent).not.toContain('$0')
		expect(
			host.querySelector('button[type="submit"]')?.hasAttribute('disabled'),
		).toBe(true)
	})
})
