import type { CouponPort } from '@coursebuilder/core/ports'

// Keep non-enumerable and prototype ports as well as the adapter's own methods.
export function cloneAdapter<T extends object>(adapter: T): T {
	return Object.create(
		Object.getPrototypeOf(adapter),
		Object.getOwnPropertyDescriptors(adapter),
	)
}

type CouponReader = Pick<CouponPort, 'getCoupon'> & {
	getCouponForDisplay?: (key: string) => Promise<
		| (NonNullable<Awaited<ReturnType<CouponPort['getCoupon']>>> & {
				paidCouponUsedUp?: true
		  })
		| null
	>
}

const readCouponForDisplay = (adapter: CouponReader, key: string) =>
	(adapter.getCouponForDisplay ?? adapter.getCoupon).call(adapter, key)

/** Read-only view for URL/code validation. Never pass it to a write. */
export function couponDisplayView<T extends CouponReader>(adapter: T): T {
	return Object.assign(cloneAdapter(adapter), {
		getCoupon: (key: string) => readCouponForDisplay(adapter, key),
	})
}

/** Legacy formatting does not validate implicit entitlement coupons. Omit
 * exhausted coupons from its pricing input, without changing the stored row. */
export function paidCouponPricingView<T extends CouponReader>(adapter: T): T {
	return Object.assign(cloneAdapter(adapter), {
		getCoupon: async (key: string) => {
			const row = await readCouponForDisplay(adapter, key)
			return row && !('paidCouponUsedUp' in row && row.paidCouponUsedUp)
				? row
				: null
		},
	})
}
