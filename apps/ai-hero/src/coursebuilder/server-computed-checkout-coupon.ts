import { AUTHORITATIVE_PRODUCT_IDS } from '@/lib/c5-pricing/decision'

import { formatPricesForProduct } from '@coursebuilder/commerce'
import type { CommerceAdapter } from '@coursebuilder/commerce/types'

export async function resolveServerComputedCheckoutCoupon({
	adapter,
	productId,
	quantity,
	verifiedUserId,
	country,
}: {
	adapter: CommerceAdapter
	productId: string
	quantity: number
	verifiedUserId?: string
	country: string
}) {
	// The authoritative-price hook prices these; no coupon is chosen for them.
	if (AUTHORITATIVE_PRODUCT_IDS.has(productId)) return null
	const defaultCoupons = await adapter.getDefaultCoupon([productId])
	const pricing = await formatPricesForProduct({
		productId,
		quantity,
		country,
		userId: verifiedUserId,
		autoApplyPPP: true,
		preferStacking: false,
		merchantCouponId: defaultCoupons?.defaultMerchantCoupon?.id,
		usedCouponId: defaultCoupons?.defaultCoupon?.id,
		ctx: adapter,
	})
	const coupon = pricing.appliedMerchantCoupon
	return coupon?.type === 'bulk' || coupon?.type === 'ppp'
		? { id: coupon.id, type: coupon.type }
		: null
}
