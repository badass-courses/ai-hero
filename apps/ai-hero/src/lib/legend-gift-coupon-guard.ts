import type { CouponPort } from '@coursebuilder/core/ports/coupon'
import type { PurchasePort } from '@coursebuilder/core/ports/purchase'

type NormalCouponPaths = Pick<CouponPort, 'getCoupon' | 'getCouponWithBulkPurchases' | 'couponForIdOrCode' | 'getDefaultCoupon'> & Pick<PurchasePort, 'redeemFullPriceCoupon'>
export const isLegendGiftCoupon = (row: { fields?: unknown } | null) => {
  const fields = row?.fields
  return typeof fields === 'object' && fields !== null && 'purpose' in fields && fields.purpose === 'legend-gift'
}

/** Gift rows are facts, never coupons or redeemable entitlements. Keep identity/receivers. */
export function guardLegendGiftCouponPaths<T extends NormalCouponPaths>(adapter: T): T {
  const getCoupon = adapter.getCoupon.bind(adapter)
  const getBulk = adapter.getCouponWithBulkPurchases.bind(adapter)
  const redeem = adapter.redeemFullPriceCoupon.bind(adapter)
  const select = adapter.couponForIdOrCode.bind(adapter)
  const defaultCoupon = adapter.getDefaultCoupon.bind(adapter)
  return Object.assign(adapter, {
    getCoupon: async (key: string) => {
      const row = await getCoupon(key)
      return isLegendGiftCoupon(row) ? null : row
    },
    getCouponWithBulkPurchases: async (key?: string) => {
      const row = await getBulk(key)
      return isLegendGiftCoupon(row) ? null : row
    },
    couponForIdOrCode: async (options: Parameters<CouponPort['couponForIdOrCode']>[0]) => {
      const row = await select(options)
      return isLegendGiftCoupon(row) ? null : row
    },
    getDefaultCoupon: async (ids?: string[]) => {
      const result = await defaultCoupon(ids)
      return isLegendGiftCoupon(result?.defaultCoupon ?? null) ? null : result
    },
    redeemFullPriceCoupon: async (options: Parameters<PurchasePort['redeemFullPriceCoupon']>[0]) => {
      if (options.couponId && isLegendGiftCoupon(await getCoupon(options.couponId))) throw new Error('legend-gift-normal-coupon-forbidden')
      return redeem(options)
    },
  })
}
