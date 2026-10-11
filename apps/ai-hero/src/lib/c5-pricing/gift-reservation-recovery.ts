import type Stripe from 'stripe'
import { C5_PRODUCT_ID } from './products'

export type DueGiftReservation = { codeRef: string; claimId: string; checkoutSessionId: string | null }
export type GiftRecoveryDeps = {
  listDue: () => Promise<readonly DueGiftReservation[]>
  retrieve: (id: string) => Promise<Stripe.Checkout.Session>
  settle: (session: Stripe.Checkout.Session) => Promise<void>
  flag: (row: DueGiftReservation, reason: string) => Promise<void>
}

/** due -> provider-verified -> paid/spent or expired/released; ambiguous -> held. */
export async function recoverDueGiftReservations(deps: GiftRecoveryDeps) {
  const result = { checked: 0, paidSettlementAttempts: 0, expirySettlementAttempts: 0, held: 0 }
  for (const row of await deps.listDue()) {
    result.checked += 1
    try {
      if (!row.checkoutSessionId) throw new Error('gift-unbound-reservation-needs-review')
      const session = await deps.retrieve(row.checkoutSessionId)
      if (session.id !== row.checkoutSessionId || session.metadata?.productId !== C5_PRODUCT_ID || session.metadata.codeRef !== row.codeRef || session.metadata.giftClaimId !== row.claimId) throw new Error('gift-reservation-provider-binding-mismatch')
      if (session.payment_status === 'paid') {
        await deps.settle(session)
        result.paidSettlementAttempts += 1
      } else if (session.status === 'expired' && session.payment_status === 'unpaid') {
        await deps.settle(session)
        result.expirySettlementAttempts += 1
      } else throw new Error('gift-provider-state-still-ambiguous')
    } catch (error) {
      result.held += 1
      await deps.flag(row, error instanceof Error ? error.message : 'gift-reservation-recovery-failed')
    }
  }
  return result
}
