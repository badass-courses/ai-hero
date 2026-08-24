import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	personalized: undefined as any,
	queryInput: undefined as any,
	queryOptions: undefined as any,
	search: '',
	sessionStatus: 'unauthenticated',
}))

vi.mock('next/navigation', () => ({
	usePathname: () => '/workshops/workshop',
	useSearchParams: () => new URLSearchParams(mocks.search),
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		pricing: {
			propsForCommerce: {
				useQuery: (input: unknown, options: unknown) => {
					mocks.queryInput = input
					mocks.queryOptions = options
					return { data: mocks.personalized }
				},
			},
		},
	},
}))

vi.mock('./workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => null,
}))

vi.mock('@coursebuilder/commerce-next/pricing/pricing-check-context', () => ({
	PriceCheckProvider: ({ children }: any) => children,
}))

vi.mock('./workshop-pricing-widget-container', () => ({
	WorkshopPricingWidgetContainer: ({ searchParams, userId }: any) => (
		<div
			data-code={searchParams.code ?? 'none'}
			data-allow-purchase={searchParams.allowPurchase ?? 'none'}
			data-user={userId ?? 'anonymous'}
		>
			pricing
		</div>
	),
}))

import {
	WorkshopPricingClient,
	WorkshopPricingFallback,
} from './workshop-pricing'

const product = { id: 'product-1' } as any
const pricingProps = {
	availableBonuses: [],
	product,
	products: [product],
	quantityAvailable: -1,
	pricingDataLoader: Promise.resolve({
		formattedPrice: null,
		purchaseToUpgrade: null,
		quantityAvailable: -1,
	}),
} as any

describe('WorkshopPricingClient', () => {
	beforeEach(() => {
		mocks.personalized = undefined
		mocks.queryInput = undefined
		mocks.queryOptions = undefined
		mocks.search = ''
		mocks.sessionStatus = 'unauthenticated'
	})

	it('keeps the code-less anonymous render unchanged without a pricing query', () => {
		const markup = renderToStaticMarkup(
			<WorkshopPricingClient {...pricingProps} />,
		)
		const fallbackMarkup = renderToStaticMarkup(
			<WorkshopPricingFallback {...pricingProps} />,
		)

		expect(markup).toBe(fallbackMarkup)
		expect(markup).toContain('data-user="anonymous"')
		expect(markup).toContain('data-code="none"')
		expect(mocks.queryOptions).toMatchObject({ enabled: false })
	})

	it('passes URL commerce params and hydrates their result anonymously', () => {
		mocks.search = 'code=SAVE20&coupon=launch'
		mocks.personalized = { products: [product], userId: 'coupon-visitor' }

		const markup = renderToStaticMarkup(
			<WorkshopPricingClient {...pricingProps} />,
		)

		expect(markup).toContain('data-user="coupon-visitor"')
		expect(markup).toContain('data-code="SAVE20"')
		expect(mocks.queryInput).toEqual({
			code: 'SAVE20',
			coupon: 'launch',
			allowPurchase: undefined,
			productId: product.id,
		})
		expect(mocks.queryOptions).toMatchObject({ enabled: true })
	})
})
