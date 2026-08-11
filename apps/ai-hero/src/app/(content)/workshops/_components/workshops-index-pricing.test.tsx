import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sessionStatus: 'unauthenticated',
	personalized: undefined as any,
	search: '',
	queryInput: undefined as any,
	queryOptions: undefined as any,
}))

vi.mock('next/navigation', () => ({
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

vi.mock('@/components/commerce/home-pricing-widget', () => ({
	PricingWidget: ({
		commerceProps,
	}: {
		commerceProps: { userId?: string }
	}) => <div data-user={commerceProps.userId ?? 'anonymous'}>pricing</div>,
}))

import {
	WorkshopsIndexPricing,
	WorkshopsIndexPricingFallback,
} from './workshops-index-pricing'

const product = { id: 'product-1' } as any
const pricingData = {
	formattedPrice: null,
	purchaseToUpgrade: null,
	quantityAvailable: -1,
} as any
const initialCommerceProps = { products: [product] } as any

describe('WorkshopsIndexPricing', () => {
	beforeEach(() => {
		mocks.sessionStatus = 'unauthenticated'
		mocks.personalized = undefined
		mocks.search = ''
		mocks.queryInput = undefined
		mocks.queryOptions = undefined
	})

	it('keeps the code-less anonymous render unchanged without a pricing query', () => {
		const markup = renderToStaticMarkup(
			<WorkshopsIndexPricing
				product={product}
				pricingData={pricingData}
				initialCommerceProps={initialCommerceProps}
			/>,
		)
		const fallbackMarkup = renderToStaticMarkup(
			<WorkshopsIndexPricingFallback
				product={product}
				pricingData={pricingData}
				initialCommerceProps={initialCommerceProps}
			/>,
		)

		expect(markup).toBe(fallbackMarkup)
		expect(markup).toContain('data-user="anonymous"')
		expect(markup).toContain('Get Access Today')
		expect(mocks.queryOptions).toMatchObject({ enabled: false })
	})

	it('hydrates URL code commerce for an anonymous visitor', () => {
		mocks.search = 'code=SAVE20'
		mocks.personalized = {
			products: [product],
			userId: 'coupon-visitor',
		}

		const markup = renderToStaticMarkup(
			<WorkshopsIndexPricing
				product={product}
				pricingData={pricingData}
				initialCommerceProps={initialCommerceProps}
			/>,
		)

		expect(markup).toContain('data-user="coupon-visitor"')
		expect(mocks.queryInput).toEqual({
			code: 'SAVE20',
			coupon: undefined,
			allowPurchase: undefined,
			productId: product.id,
		})
		expect(mocks.queryOptions).toMatchObject({ enabled: true })
	})

	it('uses member commerce state after hydration', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.personalized = {
			products: [product],
			userId: 'user-1',
			purchases: [{ productId: product.id }],
		}

		const markup = renderToStaticMarkup(
			<WorkshopsIndexPricing
				product={product}
				pricingData={pricingData}
				initialCommerceProps={initialCommerceProps}
			/>,
		)

		expect(markup).toContain('data-user="user-1"')
		expect(markup).not.toContain('Get Access Today')
		expect(mocks.queryOptions).toMatchObject({ enabled: true })
	})

	it('forces the pricing widget for allowPurchase URL testing', () => {
		mocks.search = 'allowPurchase=true'

		const markup = renderToStaticMarkup(
			<WorkshopsIndexPricing
				product={product}
				pricingData={pricingData}
				initialCommerceProps={initialCommerceProps}
				initialAllowPurchase={false}
			/>,
		)

		expect(markup).toContain('data-user="anonymous"')
		expect(mocks.queryInput).toMatchObject({ allowPurchase: 'true' })
		expect(mocks.queryOptions).toMatchObject({ enabled: true })
	})
})
