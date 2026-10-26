// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pricing: {} as Record<string, any> }))
vi.mock('@coursebuilder/commerce-next/pricing/pricing-context', () => ({
	usePricing: () => mocks.pricing,
}))
vi.mock('@coursebuilder/commerce-next/pricing/pricing-check-context', () => ({
	usePriceCheck: () => ({ isDowngrade: () => false }),
}))
vi.mock('@coursebuilder/commerce-next/pricing/pricing', () => ({}))
vi.mock('@coursebuilder/commerce-next/coupons/use-coupon', () => ({
	useCoupon: vi.fn(),
}))
vi.mock('@/lib/buy-path/beacons', () => ({ BuyPathPricingBeacon: () => null }))
vi.mock('@/components/commerce/gated-buy-button', () => ({
	GatedBuyButton: () => null,
}))
vi.mock('@/components/commerce/product-pricing-features', () => ({
	ProductPricingFeatures: () => null,
}))
vi.mock('@/components/commerce/regional-toggle-gate', () => ({
	RegionalQuantityClear: () => null,
}))
vi.mock('@coursebuilder/ui', () => ({
	Checkbox: (props: any) => (
		<button id={props.id} role="checkbox" aria-checked={props.checked} />
	),
}))

import { RegionalPricingBox } from './pricing-widget'
import { APP_REASONS } from '@/lib/c5-pricing/reasons'
import { C5_PRODUCT_ID } from '@/lib/c5-pricing/products'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
afterEach(async () => {
	await act(async () => root?.unmount())
	root = null
})

const note =
	"Regional pricing doesn't combine with your Crash Course credit. You'll get whichever price is lower."
const coupon = { type: 'ppp', country: 'IN', percentageDiscount: 0.6 }

async function renderBox(overrides: Record<string, any> = {}) {
	mocks.pricing = {
		product: { id: C5_PRODUCT_ID },
		formattedPrice: {
			availableCoupons: [coupon],
			authoritative: { reasons: [APP_REASONS.formulaUsesCredit] },
		},
		status: 'success',
		allowPurchase: true,
		options: { isPPPEnabled: true },
		isPreviouslyPurchased: false,
		isTeamPurchaseActive: false,
		quantity: 1,
		pricingData: {},
		...overrides,
	}
	const host = document.createElement('div')
	await act(async () => {
		root = createRoot(host)
		root.render(<RegionalPricingBox />)
	})
	return host
}

describe('C5 regional credit note', () => {
	it('renders beside the offered toggle when the formula uses credit', async () => {
		const host = await renderBox()
		expect(host.querySelector('[role="checkbox"]')).not.toBeNull()
		expect(host.textContent).toContain(note)
	})

	it('keeps the note when regional is selected and the formula still uses credit', async () => {
		const host = await renderBox({ activeMerchantCoupon: coupon })
		expect(host.textContent).toContain(note)
	})

	it('does not show for regional without credit, including signed-out quotes', async () => {
		const host = await renderBox({
			formattedPrice: {
				availableCoupons: [coupon],
				authoritative: { reasons: [] },
			},
		})
		expect(host.querySelector('[role="checkbox"]')).not.toBeNull()
		expect(host.textContent).not.toContain(note)
	})

	it('does not show for credit without a regional offer', async () => {
		const host = await renderBox({ options: { isPPPEnabled: false } })
		expect(host.textContent).not.toContain(note)
	})

	it.each([{ quantity: 5 }, { isTeamPurchaseActive: true }])(
		'does not show for teams: %j',
		async (overrides) => {
			const host = await renderBox(overrides)
			expect(host.textContent).not.toContain(note)
		},
	)

	it('does not change other products', async () => {
		const host = await renderBox({ product: { id: 'other-product' } })
		expect(host.querySelector('[role="checkbox"]')).not.toBeNull()
		expect(host.textContent).not.toContain(note)
	})

	it('does not show when an upgrade hides the toggle', async () => {
		const host = await renderBox({
			pricingData: { purchaseToUpgrade: { id: 'purchase' } },
		})
		expect(host.querySelector('[role="checkbox"]')).toBeNull()
		expect(host.textContent).not.toContain(note)
	})

	it('removes the note when a new per-buyer quote has no credit', async () => {
		const host = await renderBox()
		expect(host.textContent).toContain(note)
		mocks.pricing.formattedPrice = {
			availableCoupons: [coupon],
			authoritative: { reasons: [] },
		}
		await act(async () => root!.render(<RegionalPricingBox />))
		expect(host.textContent).not.toContain(note)
	})
})
