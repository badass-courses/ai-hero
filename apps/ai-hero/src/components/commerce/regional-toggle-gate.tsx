'use client'

import * as React from 'react'
import { clearRegionalSelection } from '@/lib/pricing-decisions'
import { regionalAllowedForQuantity } from '@/lib/purchase-guardrails'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { usePricing } from '@coursebuilder/commerce-next/pricing/pricing-context'

/**
 * Clears an applied regional coupon when the quantity is a team quantity, so
 * no regional coupon is carried to checkout (which refuses it). Other coupons
 * are untouched: see `clearRegionalSelection`.
 */
export function useClearRegionalAtTeamQuantity() {
	const { quantity, activeMerchantCoupon, setMerchantCoupon } = usePricing()
	const clear = clearRegionalSelection({
		quantity: quantity ?? 1,
		activeCouponType: activeMerchantCoupon?.type,
	})
	React.useEffect(() => {
		if (clear) setMerchantCoupon(undefined)
	}, [clear, setMerchantCoupon])
}

/** The stock regional toggle, hidden at team quantities. */
export function GatedPPPToggle(props: { className?: string }) {
	const { quantity } = usePricing()
	useClearRegionalAtTeamQuantity()
	if (!regionalAllowedForQuantity(quantity ?? 1)) return null
	return <Pricing.PPPToggle {...props} />
}
