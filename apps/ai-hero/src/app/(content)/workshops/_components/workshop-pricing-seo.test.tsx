import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkshopPageProps } from './workshop-page-props'

const mocks = vi.hoisted(() => ({
	getProduct: vi.fn(),
	getPricingData: vi.fn(),
	products: vi.fn(),
	commerce: vi.fn(),
	coupon: vi.fn(),
}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getDefaultCoupon: mocks.coupon },
}))
vi.mock('@/lib/pricing-query', () => ({ getPricingData: mocks.getPricingData }))
vi.mock('@/lib/products-query', () => ({ getProduct: mocks.getProduct }))
vi.mock('@/lib/workshops-query', () => ({
	getCachedAllWorkshopProducts: mocks.products,
}))
vi.mock('@coursebuilder/commerce/props-for-commerce', () => ({
	propsForCommerce: mocks.commerce,
}))
import { PublicWorkshopPricing } from './workshop-public-pricing-server'

describe('workshop SEO pricing slot', () => {
	it('passes the exact same resolved product and stock to metadata and the buy widget without a second fetch', async () => {
		const product = {
			id: 'synthetic',
			type: 'self-paced',
			fields: { state: 'published', visibility: 'public' },
			price: { unitAmount: 247, fields: {} },
		}
		mocks.products.mockResolvedValue([product])
		mocks.getProduct.mockResolvedValue(product)
		mocks.getPricingData.mockResolvedValue({
			formattedPrice: null,
			quantityAvailable: 0,
		})
		mocks.coupon.mockResolvedValue(null)
		mocks.commerce.mockResolvedValue({})
		const metadata = vi.fn((_props: WorkshopPageProps) => (
			<script type="application/ld+json">{'{}'}</script>
		))
		const widget = vi.fn((_props: WorkshopPageProps) => <div>Pricing</div>)
		const markup = renderToStaticMarkup(
			await PublicWorkshopPricing({
				moduleSlug: 'synthetic',
				structuredData: metadata,
				children: widget,
			}),
		)
		expect(markup).toContain('application/ld+json')
		expect(metadata.mock.calls[0]?.[0]).toBe(widget.mock.calls[0]?.[0])
		expect(metadata).toHaveBeenCalledWith(
			expect.objectContaining({ product, quantityAvailable: 0 }),
		)
		expect(mocks.getProduct).toHaveBeenCalledTimes(1)
		expect(mocks.getPricingData).toHaveBeenCalledTimes(1)
	})
})
