import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sessionStatus: 'unauthenticated',
	personalized: undefined as any,
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		pricing: {
			propsForCommerce: {
				useQuery: () => ({ data: mocks.personalized }),
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

import { WorkshopsIndexPricing } from './workshops-index-pricing'

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
	})

	it('renders public pricing without member data in the static shell', () => {
		const markup = renderToStaticMarkup(
			<WorkshopsIndexPricing
				product={product}
				pricingData={pricingData}
				initialCommerceProps={initialCommerceProps}
			/>,
		)

		expect(markup).toContain('data-user="anonymous"')
		expect(markup).toContain('Get Access Today')
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
	})
})
