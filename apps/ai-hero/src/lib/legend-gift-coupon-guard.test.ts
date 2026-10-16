import { describe, it, expect, vi } from 'vitest'
import type { CouponPort } from '@coursebuilder/core/ports/coupon'
import type { PurchasePort } from '@coursebuilder/core/ports/purchase'
import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'
import { guardLegendGiftCouponPaths } from './legend-gift-coupon-guard'
const setup = (purpose: string) => {
  const row = { id: 'synthetic-code-ref', code: 'SYNTHETIC-GIFT', percentageDiscount: 1, amountDiscount: 77600, fields: { purpose } }
  const redeem = vi.fn(async () => ({ purchase: { id: 'synthetic-purchase' } }))
  const adapter = guardLegendGiftCouponPaths({ getCoupon: vi.fn(async () => row), getCouponWithBulkPurchases: vi.fn(async () => row), couponForIdOrCode: vi.fn(async () => row), getDefaultCoupon: vi.fn(async () => ({ defaultCoupon: row })), redeemFullPriceCoupon: redeem } as unknown as CouponPort & PurchasePort)
  return { row, adapter, redeem }
}
describe('legend gifts cannot enter normal Course Builder coupon handling', () => {
  it('rejects gift coupon IDs, codes, formatted lookups and default selections', async () => {
    const { adapter } = setup('legend-gift')
    expect(await adapter.getCoupon('synthetic-code-ref')).toBeNull()
    expect(await adapter.getCoupon('SYNTHETIC-GIFT')).toBeNull()
    expect(await adapter.couponForIdOrCode({ couponId: 'synthetic-code-ref' })).toBeNull()
    expect(await adapter.couponForIdOrCode({ code: 'SYNTHETIC-GIFT' })).toBeNull()
    expect(await adapter.getCouponWithBulkPurchases('synthetic-code-ref')).toBeNull()
    expect(await adapter.getDefaultCoupon()).toBeNull()
  })
  it('getCouponForCode refuses a legend gift even with ordinary discount fields', async () => {
    expect(await getCouponForCode('SYNTHETIC-GIFT', [], setup('legend-gift').adapter)).toBeUndefined()
  })
  it('refuses the redeem workflow before any purchase or entitlement write', async () => {
    const { adapter, redeem } = setup('legend-gift')
    await expect(adapter.redeemFullPriceCoupon({ couponId: 'synthetic-code-ref', email: 'buyer@example.test', productIds: [] })).rejects.toThrow('legend-gift-normal-coupon-forbidden')
    expect(redeem).not.toHaveBeenCalled()
  })
  it('keeps ordinary coupons and their redemption unchanged', async () => {
    const { adapter, row } = setup('ordinary')
    expect(await adapter.getCoupon('ordinary')).toBe(row)
    expect(await adapter.redeemFullPriceCoupon({ couponId: 'ordinary', email: 'buyer@example.test', productIds: [] })).toMatchObject({ purchase: { id: 'synthetic-purchase' } })
  })
})
