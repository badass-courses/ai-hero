// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	pricing: {} as Record<string, any>,
	downgrade: false,
	session: 'unauthenticated' as string,
	commerce: { data: undefined as any, isError: false },
}))

vi.mock('@coursebuilder/commerce-next/pricing/pricing', () => ({
	usePricing: () => mocks.pricing,
	// Mirrors the stock BuyButton's `disabled` (commerce-next pricing.tsx):
	// pending, error or sold out.
	BuyButton: ({ children }: { children?: React.ReactNode }) => (
		<button
			type="submit"
			data-stock=""
			disabled={
				mocks.pricing.status === 'pending' ||
				mocks.pricing.status === 'error' ||
				mocks.pricing.isSoldOut
			}
		>
			{children ?? 'Buy Now'}
		</button>
	),
	Root: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	Product: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@coursebuilder/commerce-next/pricing/pricing-context', () => ({
	usePricing: () => mocks.pricing,
}))
vi.mock('@coursebuilder/commerce-next/pricing/pricing-check-context', () => ({
	PriceCheckProvider: ({ children }: { children?: React.ReactNode }) => (
		<>{children}</>
	),
	usePriceCheck: () => ({
		isDiscount: () => false,
		isDowngrade: () => mocks.downgrade,
	}),
}))
vi.mock('@coursebuilder/commerce-next/coupons/use-coupon', () => ({
	useCoupon: () => ({ validCoupon: false }),
}))
vi.mock('@coursebuilder/commerce-next/coupons/coupon-context', () => ({
	CouponContext: React.createContext({}),
}))
vi.mock('next/navigation', () => ({
	usePathname: () => '/workshops/x',
	useSearchParams: () =>
		new URLSearchParams('coupon=eoj-coupon%3A' + 'a'.repeat(64)),
}))
vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.session }),
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test' },
}))
vi.mock('@/trpc/react', () => ({
	api: {
		pricing: {
			propsForCommerce: { useQuery: () => mocks.commerce },
		},
	},
}))
vi.mock('./workshop-pricing-widget-container', () => ({
	WorkshopPricingWidgetContainer: () => null,
}))
vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => null,
}))
vi.mock('@/lib/buy-path/beacons', () => ({ BuyPathPricingBeacon: () => null }))
vi.mock('@/components/spinner', () => ({ default: () => null }))
vi.mock('@coursebuilder/ui', () => ({
	Button: ({ children, asChild: _a, ...props }: any) => (
		<button {...props}>{children}</button>
	),
	Checkbox: () => null,
}))

import { EvergreenOfferEndedNotice } from '@/components/evergreen-offer-ended-notice'

import { BuyButtonComponent } from './inline-mdx-pricing'
import { RegionalPricingNote } from './regional-pricing-note'
import { WorkshopEvergreenOfferEndedNotice } from './workshop-evergreen-offer-ended-notice'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement

async function render(node: React.ReactNode) {
	await act(async () => {
		root = createRoot(host)
		root.render(node)
	})
}

beforeEach(() => {
	document.body.innerHTML =
		'<div id="mobile-bar-regional-note"></div><div id="host"></div>'
	host = document.getElementById('host')!
	mocks.downgrade = false
	mocks.session = 'unauthenticated'
	mocks.commerce = { data: undefined, isError: false }
})
afterEach(async () => {
	await act(async () => root?.unmount())
	root = null
	vi.restoreAllMocks()
})

const eligible = () => ({
	options: { isPPPEnabled: true },
	allowPurchase: true,
	isPreviouslyPurchased: false,
	isTeamPurchaseActive: false,
	activeMerchantCoupon: null,
	formattedPrice: {
		fullPrice: 1000,
		calculatedPrice: 1000,
		availableCoupons: [{ type: 'ppp', percentageDiscount: 0.5, country: 'BR' }],
	},
})

describe('RegionalPricingNote', () => {
	const slot = () =>
		document.getElementById('mobile-bar-regional-note')!.innerHTML

	it('renders when eligible', async () => {
		mocks.pricing = eligible()
		await render(<RegionalPricingNote targetId="buy" />)
		expect(slot()).toContain('data-regional-note')
		expect(slot()).toContain('50% off')
	})

	it.each([
		['team purchase', { isTeamPurchaseActive: true }],
		['previously purchased', { isPreviouslyPurchased: true }],
		['purchase not allowed', { allowPurchase: false }],
		['PPP disabled', { options: { isPPPEnabled: false } }],
	])('renders nothing for %s', async (_name, override) => {
		mocks.pricing = { ...eligible(), ...override }
		await render(<RegionalPricingNote targetId="buy" />)
		expect(slot()).toBe('')
	})

	it('renders nothing for a downgrade', async () => {
		mocks.pricing = eligible()
		mocks.downgrade = true
		await render(<RegionalPricingNote targetId="buy" />)
		expect(slot()).toBe('')
	})
})

describe('inline Buy', () => {
	const product = { id: 'p1', type: 'cohort', fields: {} } as any
	const soldOut = (isSoldOut: boolean) => ({
		status: 'success',
		product,
		isSoldOut,
		pricingData: { quantityAvailable: isSoldOut ? 0 : 5 },
		formattedPrice: {
			fullPrice: 1000,
			calculatedPrice: 800,
			availableCoupons: [],
		},
		options: {},
	})

	it('says Sold Out, and its button cannot submit, when sold out', async () => {
		mocks.pricing = soldOut(true)
		await render(
			<BuyButtonComponent
				product={product}
				quantityAvailable={0}
				commerceProps={{} as any}
				pricingDataLoader={Promise.resolve({}) as any}
				resourceType="cohort"
			/>,
		)
		const button = host.querySelector('button')!
		expect(button.textContent).toContain('Sold Out')
		expect(button.textContent).not.toContain('Buy Now')
		expect(button.disabled).toBe(true)
	})

	it('says Buy Now and is enabled when there are seats', async () => {
		mocks.pricing = soldOut(false)
		await render(
			<BuyButtonComponent
				product={product}
				quantityAvailable={5}
				commerceProps={{} as any}
				pricingDataLoader={Promise.resolve({}) as any}
				resourceType="cohort"
			/>,
		)
		const button = host.querySelector('button')!
		expect(button.textContent).toContain('Buy Now')
		expect(button.disabled).toBe(false)
	})
})

describe('ended evergreen offer notice', () => {
	const ended = () =>
		vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(
				async () =>
					new Response(JSON.stringify({ status: 'ended', deadline: 'Oct 1' })),
			)

	it('shows to a viewer who does not own the product', async () => {
		ended()
		await render(
			<EvergreenOfferEndedNotice endpoint="/s" viewerOwnsProduct={false} />,
		)
		await act(async () => {})
		expect(host.textContent).toContain('This private offer ended Oct 1.')
	})

	it('stays hidden for an owner', async () => {
		ended()
		await render(<EvergreenOfferEndedNotice endpoint="/s" viewerOwnsProduct />)
		await act(async () => {})
		expect(host.textContent).toBe('')
	})

	it('call site: owner by the buy box signal sees nothing; non-owner sees it', async () => {
		ended()
		mocks.session = 'authenticated'
		mocks.commerce = {
			data: { purchases: [{ productId: 'p1', status: 'Valid' }] },
			isError: false,
		}
		await render(
			<WorkshopEvergreenOfferEndedNotice endpoint="/s" productId="p1" />,
		)
		await act(async () => {})
		expect(host.textContent).toBe('')
		await act(async () => root?.unmount())
		root = null
		mocks.commerce = { data: { purchases: [] }, isError: false }
		await render(
			<WorkshopEvergreenOfferEndedNotice endpoint="/s" productId="p1" />,
		)
		await act(async () => {})
		expect(host.textContent).toContain('This private offer ended Oct 1.')
	})

	it.each([
		['refunded', { productId: 'p1', status: 'Refunded' }],
		['bulk-only', { productId: 'p1', status: 'Valid', bulkCouponId: 'c' }],
		['another product', { productId: 'p2', status: 'Valid' }],
	])(
		'call site: a %s purchase is not ownership, notice shows',
		async (_n, purchase) => {
			ended()
			mocks.session = 'authenticated'
			mocks.commerce = { data: { purchases: [purchase] }, isError: false }
			await render(
				<WorkshopEvergreenOfferEndedNotice endpoint="/s" productId="p1" />,
			)
			await act(async () => {})
			expect(host.textContent).toContain('This private offer ended Oct 1.')
		},
	)

	it('call site: hidden while ownership is still loading', async () => {
		ended()
		mocks.session = 'authenticated'
		await render(
			<WorkshopEvergreenOfferEndedNotice endpoint="/s" productId="p1" />,
		)
		await act(async () => {})
		expect(host.textContent).toBe('')
	})
})
