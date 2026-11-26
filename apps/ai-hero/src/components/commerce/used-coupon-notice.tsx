'use client'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { TYPE } from '@/components/landing/type'
import { COUPON_USED_UP_MESSAGE } from '@/lib/purchase-guardrails'

const isUsed = (value: unknown) =>
	!!value &&
	typeof value === 'object' &&
	'paidCouponUsedUp' in value &&
	value.paidCouponUsedUp === true

export function UsedCouponNotice({ coupon }: { coupon?: unknown }) {
	const { formattedPrice, isPreviouslyPurchased } = Pricing.usePricing()
	if (
		isPreviouslyPurchased ||
		formattedPrice?.authoritative ||
		!(isUsed(coupon) || isUsed(formattedPrice))
	)
		return null
	return (
		<p role="status" className={TYPE.meta}>
			{COUPON_USED_UP_MESSAGE}
		</p>
	)
}
