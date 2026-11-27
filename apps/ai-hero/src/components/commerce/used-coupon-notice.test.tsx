import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const usePricing = vi.hoisted(() => vi.fn())
vi.mock('@coursebuilder/commerce-next/pricing/pricing', () => ({ usePricing }))

import { UsedCouponNotice } from './used-coupon-notice'

describe('buy box used-coupon notice', () => {
	it('shows the notice on an otherwise successful full-price quote', () => {
		usePricing.mockReturnValue({
			formattedPrice: { calculatedPrice: 299, paidCouponUsedUp: true },
		})
		const html = renderToStaticMarkup(<UsedCouponNotice />)
		expect(html).toContain('role="status"')
		expect(html).toContain('This code has been used.')
	})

	it('can show the URL lookup result before the repriced quote arrives', () => {
		usePricing.mockReturnValue({})
		expect(
			renderToStaticMarkup(
				<UsedCouponNotice coupon={{ paidCouponUsedUp: true }} />,
			),
		).toContain('This code has been used.')
	})

	it.each([
		{ isPreviouslyPurchased: true },
		{ formattedPrice: { authoritative: {} } },
	])(
		'does not replace ownership or authoritative-product messages',
		(context) => {
			usePricing.mockReturnValue(context)
			expect(
				renderToStaticMarkup(
					<UsedCouponNotice coupon={{ paidCouponUsedUp: true }} />,
				),
			).toBe('')
		},
	)
})
