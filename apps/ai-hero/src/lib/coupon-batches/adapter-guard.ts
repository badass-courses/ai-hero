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
	resolvesToComp: (key: string) => Promise<boolean>,
): T {
	const redeem = adapter.redeemFullPriceCoupon.bind(adapter)
	const settle = adapter.createMerchantChargeAndPurchase.bind(adapter)
	const getCoupon = adapter.getCoupon.bind(adapter)
	const getBulk = adapter.getCouponWithBulkPurchases.bind(adapter)
	const lookupLegacy = adapter.couponForIdOrCode.bind(adapter)
	// MySQL's collation may resolve an accented or full-width key to a
	// reserved ASCII row. Make the authorization decision on the stored ID.
	function storedReceipt<T extends { id: string; code?: string | null }>(
		key: string | undefined,
		row: T | null,
	) {
		if (!row) return null
		if (inRowNamespace(row.id))
			return key === row.id ? { ...row, code: null } : null
		return inRowNamespace(key) ? null : row
	}
	return Object.assign(adapter, {
		async getCoupon(value: string) {
			if (isPrivateCompReference(value) && !inRowNamespace(value)) return null
			return storedReceipt(value, await getCoupon(value))
		},
		async getCouponWithBulkPurchases(value?: string) {
			if (isPrivateCompReference(value) && !inRowNamespace(value)) return null
			return storedReceipt(value, await getBulk(value))
		},
		async couponForIdOrCode(
			input: Parameters<CouponPort['couponForIdOrCode']>[0],
		) {
			if (
				isPrivateCompReference(input.code) ||
				isPrivateCompReference(input.couponId)
			)
				return null
			const row = await lookupLegacy(input)
			return inRowNamespace(row?.id) ? null : row
		},
		async createMerchantChargeAndPurchase(
			input: Parameters<PurchasePort['createMerchantChargeAndPurchase']>[0],
		) {
			// Never attach a comp reference to settled money, even on webhook replay.
			const key = input.usedCouponId
			return key && (isPrivateCompReference(key) || (await resolvesToComp(key)))
				? settle({ ...input, usedCouponId: undefined })
				: settle(input)
		},
		async redeemFullPriceCoupon(
			input: Parameters<PurchasePort['redeemFullPriceCoupon']>[0],
		) {
			const key = input.couponId
			if (isPrivateCompReference(key) || (key && (await resolvesToComp(key))))
				return redeemComp(input)
			return redeem(input)
		},
	})
}
