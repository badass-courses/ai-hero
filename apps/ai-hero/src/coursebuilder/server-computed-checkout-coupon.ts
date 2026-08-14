import { formatPricesForProduct } from '@coursebuilder/core'
import type { CourseBuilderAdapter } from '@coursebuilder/core/adapters'

export async function resolveServerComputedCheckoutCoupon({
	adapter,
	productId,
	quantity,
	verifiedUserId,
	country,
}: {
	adapter: CourseBuilderAdapter
	productId: string
	quantity: number
	verifiedUserId?: string
	country: string
}) {
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
