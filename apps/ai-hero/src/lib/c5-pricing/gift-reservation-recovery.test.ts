import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { C5_PRODUCT_ID } from './products'
import { recoverDueGiftReservations, type DueGiftReservation } from './gift-reservation-recovery'
const row: DueGiftReservation = { codeRef: 'synthetic-code', claimId: 'synthetic-claim', checkoutSessionId: 'cs_test_fixture' }
const session = (status: Stripe.Checkout.Session.Status, payment_status: Stripe.Checkout.Session.PaymentStatus) => ({ id: 'cs_test_fixture', status, payment_status, metadata: { productId: C5_PRODUCT_ID, codeRef: row.codeRef, giftClaimId: row.claimId } }) as unknown as Stripe.Checkout.Session
const deps = () => ({ listDue: vi.fn(async () => [row]), retrieve: vi.fn(async () => session('expired', 'unpaid')), recoverUnbound: vi.fn(async () => 'held' as const), settle: vi.fn(async () => undefined), flag: vi.fn(async () => undefined) })
describe('provider-verified recovery of due reservations', () => {
  it('recovers a missed expiry webhook, idempotently delegating terminal state', async () => {
    const d = deps();expect(await recoverDueGiftReservations(d)).toMatchObject({ expirySettlementAttempts: 1, held: 0 });expect(d.settle).toHaveBeenCalledWith(session('expired', 'unpaid'))
  })
  it('a paid session becomes spent even after its local deadline', async () => {
    const d = deps();d.retrieve.mockResolvedValue(session('complete', 'paid'));expect(await recoverDueGiftReservations(d)).toMatchObject({ paidSettlementAttempts: 1, expirySettlementAttempts: 0 });expect(d.settle).toHaveBeenCalledTimes(1)
  })
  it('holds unbound, open, mismatched and unreadable provider state', async () => {
    for (const variant of ['unbound', 'open', 'mismatch', 'unreadable']) {
      const d = deps()
      if (variant === 'unbound') d.listDue.mockResolvedValue([{ ...row, checkoutSessionId: null }])
      if (variant === 'open') d.retrieve.mockResolvedValue(session('open', 'unpaid'))
      if (variant === 'mismatch') d.retrieve.mockResolvedValue({ ...session('expired', 'unpaid'), metadata: { codeRef: 'another-code', giftClaimId: row.claimId } })
      if (variant === 'unreadable') d.retrieve.mockRejectedValue(new Error('provider unavailable'))
      expect(await recoverDueGiftReservations(d)).toMatchObject({ held: 1, paidSettlementAttempts: 0, expirySettlementAttempts: 0 });expect(d.settle).not.toHaveBeenCalled();expect(d.flag).toHaveBeenCalledTimes(1)
    }
  })
})
