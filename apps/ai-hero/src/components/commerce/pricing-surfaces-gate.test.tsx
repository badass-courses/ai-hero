import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every AI Hero surface that shows the C5 price, rendered with the pricing
// context a non-purchasable decision produces. The stock buy button submits
// the checkout form; on these surfaces it must never render.
const mocks = vi.hoisted(() => ({
	pricing: {} as Record<string, unknown>,
	mdxComponents: {} as Record<string, (props: any) => React.ReactNode>,
}))

vi.mock('@coursebuilder/commerce-next/pricing/pricing', () => {
	const passthrough = ({ children }: { children?: React.ReactNode }) => (
		<>{children}</>
	)
	return {
		usePricing: () => mocks.pricing,
		// The stock button: disabled only on pending, error or sold out.
		BuyButton: ({ children }: { children?: React.ReactNode }) => (
			<button type="submit" data-stock="">
				{children ?? 'Buy Now'}
			</button>
		),
		Root: passthrough,
		Product: passthrough,
		Details: passthrough,
		Purchased: passthrough,
		BuyMoreSeats: passthrough,
		PPPToggle: passthrough,
		GuaranteeBadge: passthrough,
		Price: passthrough,
		Name: () => null,
		LiveQuantity: () => null,
		ProductImage: () => null,
		TeamToggle: () => null,
		TeamQuantityInput: () => null,
		LiveRefundPolicy: () => null,
		SaleCountdown: () => null,
		BuyMoreSeatsToggle: () => null,
	}
})
vi.mock('@coursebuilder/commerce-next/pricing/pricing-context', () => ({
	usePricing: () => mocks.pricing,
}))
vi.mock('@coursebuilder/commerce-next/pricing/pricing-check-context', () => ({
	PriceCheckProvider: ({ children }: { children?: React.ReactNode }) => (
		<>{children}</>
	),
	usePriceCheck: () => ({ isDiscount: () => false }),
}))
vi.mock('@coursebuilder/commerce-next/coupons/use-coupon', () => ({
	useCoupon: () => ({ validCoupon: false }),
}))
vi.mock('@coursebuilder/ui', () => ({
	Button: ({ children, asChild: _asChild, ...props }: any) => (
		<button {...props}>{children}</button>
	),
	Checkbox: () => null,
}))
vi.mock('@/trpc/react', () => ({
	api: {
		convertkit: {
			answerSurvey: { useMutation: () => ({ mutateAsync: vi.fn() }) },
			checkoutSurveyAnswer: { useQuery: () => ({ data: undefined }) },
		},
	},
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/c5' }))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test',
		NEXT_PUBLIC_URL: 'https://app.test',
	},
}))
vi.mock('@/db', () => ({
	db: { query: { products: { findMany: async () => [] } } },
}))
vi.mock('@/utils/compile-mdx', () => ({
	compileMDX: async (_: string, components: typeof mocks.mdxComponents) => {
		mocks.mdxComponents = components
		return { content: null }
	},
}))

import { EventBodyWithPricing } from '@/app/(content)/events/[slug]/_components/event-body-with-pricing'
import { BuyButtonComponent } from '@/app/(content)/workshops/_components/inline-mdx-pricing'
import { PricingWidget as WorkshopPricingWidget } from '@/app/(content)/workshops/_components/pricing-widget'
import { VideoOverlayWorkshopPricing } from '@/app/(content)/workshops/_components/video-overlay-pricing-widget'

import { CheckoutSurveyBuyButton } from './checkout-survey-buy-button'
import { PricingWidget as HomePricingWidget } from './home-pricing-widget'

const product = {
	id: 'product-s00zs',
	name: 'Synthetic cohort',
	type: 'cohort',
	status: 1,
	fields: { slug: 'synthetic-cohort', state: 'published' },
	resources: [{ resource: { type: 'cohort', fields: { slug: 'synthetic-cohort' } } }],
} as any
const loader = Promise.resolve({ formattedPrice: null, quantityAvailable: -1 })

const authoritative = (kind: string, reasons: string[] = []) => ({
	kind,
	purchasable: kind === 'priced',
	isUpperBound: kind === 'bounded',
	amountCents: kind === 'priced' || kind === 'bounded' ? 80_000 : 0,
	unitAmountCents: 80_000,
	restriction: 'none',
	reasons,
	decisionRef: 'c5d1.0000000000000000.-',
	engineVersion: 'synthetic',
	policyVersion: 'synthetic',
})
const decisionWith = (kind: string, reasons: string[] = []) => ({
	status: 'success',
	product,
	quantity: 1,
	isSoldOut: false,
	pricingData: { quantityAvailable: -1 },
	formattedPrice: {
		fullPrice: 1000,
		calculatedPrice: 800,
		availableCoupons: [],
		authoritative: authoritative(kind, reasons),
	},
	options: {},
})

async function eventEnroll() {
	await EventBodyWithPricing({
		rawBody: '<Enroll />',
		pricingProps: {
			event: { id: 'event-1', fields: { slug: 'event' } },
			product,
			hasPurchasedCurrentProduct: false,
			pricingDataLoader: loader,
			purchases: [],
			allowPurchase: true,
			userId: 'user-1',
			country: 'US',
			isSoldOut: false,
		} as any,
	})
	return mocks.mdxComponents.Enroll!({})
}

const SURFACES: readonly [string, () => Promise<React.ReactNode> | React.ReactNode][] = [
	[
		'the workshop and cohort pricing widget',
		() => (
			<WorkshopPricingWidget
				product={product}
				quantityAvailable={-1}
				commerceProps={{ country: 'US' } as any}
				pricingDataLoader={loader as any}
				hideFeatures
			/>
		),
	],
	[
		'the cohort sidebar, with its checkout survey button',
		() => (
			<WorkshopPricingWidget
				product={product}
				quantityAvailable={-1}
				commerceProps={{ country: 'US' } as any}
				pricingDataLoader={loader as any}
				hideFeatures
				buyButton={<CheckoutSurveyBuyButton>Enroll</CheckoutSurveyBuyButton>}
			/>
		),
	],
	['the checkout survey button', () => <CheckoutSurveyBuyButton />],
	[
		'the video overlay',
		() => (
			<VideoOverlayWorkshopPricing
				{...({
					product,
					quantityAvailable: -1,
					pricingDataLoader: loader,
					purchasedProductIds: [],
					country: 'US',
				} as any)}
			/>
		),
	],
	[
		'inline MDX pricing',
		() => (
			<BuyButtonComponent
				product={product}
				quantityAvailable={-1}
				commerceProps={{} as any}
				pricingDataLoader={loader as any}
				resourceType="cohort"
			/>
		),
	],
	['the event body <Enroll>', eventEnroll],
	[
		'the home team card',
		() => (
			<HomePricingWidget
				product={product}
				quantityAvailable={-1}
				commerceProps={{ country: 'US' } as any}
				pricingDataLoader={loader as any}
			/>
		),
	],
]

const render = async (surface: () => Promise<React.ReactNode> | React.ReactNode) =>
	renderToStaticMarkup(<>{await surface()}</>)

describe('Buy Now on every C5 pricing surface', () => {
	beforeEach(() => {
		mocks.pricing = decisionWith('priced')
	})

	describe.each(SURFACES)('%s', (_, surface) => {
		it('offers checkout for a chargeable decision', async () => {
			const html = await render(surface)
			expect(html).not.toContain('data-purchase-gate')
			expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(Not open|Enrollment closed|Price unavailable)/)
		})

		it.each([
			['bounded', 'Price unavailable', ['quotes-unavailable']],
			['not-open', 'Not open yet', []],
			['closed', 'Enrollment closed', []],
			['held', 'Price unavailable', ['facts-unavailable']],
		])('disables it for a %s decision', async (kind, label, reasons) => {
			mocks.pricing = decisionWith(kind, reasons)
			const html = await render(surface)
			expect(html).not.toContain('type="submit"')
			expect(html).toContain(label)
			expect(html).toMatch(/<button[^>]*disabled=""/)
		})

		it('sends a regional ticket holder to support', async () => {
			mocks.pricing = decisionWith('held', ['restricted-holder'])
			const html = await render(surface)
			expect(html).not.toContain('type="submit"')
			expect(html).toContain('data-purchase-gate="support"')
		})
	})
})
