import type { CouponPort, PurchasePort } from '@coursebuilder/core/ports'
import { inRowNamespace, isPrivateCompReference } from './namespace'

type Paths = Pick<
	CouponPort,
	'getCoupon' | 'getCouponWithBulkPurchases' | 'couponForIdOrCode'
> &
	Pick<
		PurchasePort,
		'redeemFullPriceCoupon' | 'createMerchantChargeAndPurchase'
	>

/** Receipt readers resolve stored row IDs; selectors may only enter the free claim. */
export function guardC5CompSelectors<T extends Paths>(
	adapter: T,
	redeemComp: PurchasePort['redeemFullPriceCoupon'],
): T {
	const redeem = adapter.redeemFullPriceCoupon.bind(adapter)
	const settle = adapter.createMerchantChargeAndPurchase.bind(adapter)
	const getCoupon = adapter.getCoupon.bind(adapter)
	const getBulk = adapter.getCouponWithBulkPurchases.bind(adapter)
	const lookupLegacy = adapter.couponForIdOrCode.bind(adapter)
	return Object.assign(adapter, {
		async getCoupon(value: string) {
			if (!inRowNamespace(value))
				return isPrivateCompReference(value) ? null : getCoupon(value)
			const row = await getCoupon(value)
			return row ? { ...row, code: null } : null
		},
		async getCouponWithBulkPurchases(value?: string) {
			if (!inRowNamespace(value))
				return isPrivateCompReference(value) ? null : getBulk(value)
			const row = await getBulk(value)
			return row ? { ...row, code: null } : null
		},
		couponForIdOrCode(input: Parameters<CouponPort['couponForIdOrCode']>[0]) {
			return isPrivateCompReference(input.code) ||
				isPrivateCompReference(input.couponId)
				? Promise.resolve(null)
				: lookupLegacy(input)
		},
		createMerchantChargeAndPurchase(
			input: Parameters<PurchasePort['createMerchantChargeAndPurchase']>[0],
		) {
			// Never attach a comp reference to settled money, even on webhook replay.
			return isPrivateCompReference(input.usedCouponId)
				? settle({ ...input, usedCouponId: undefined })
				: settle(input)
		},
		async redeemFullPriceCoupon(
			input: Parameters<PurchasePort['redeemFullPriceCoupon']>[0],
		) {
			if (!isPrivateCompReference(input.couponId)) return redeem(input)
			return redeemComp(input)
		},
	})
}
