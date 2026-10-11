import 'server-only'
import { acquireDatabaseConnection } from '@/db'
import { log } from '@/server/logger'
import type { RowDataPacket } from 'mysql2/promise'
import type Stripe from 'stripe'
import { recoverDueGiftReservations, type DueGiftReservation } from './gift-reservation-recovery'
import { settleGiftSession } from './gift-settlement'
import { recoverUnboundGiftSlot } from './gift-slots'

/** Bounded recovery, independent of auto-fulfillment. Never releases by clock alone. */
export async function recoverGiftReservations(stripe: Stripe, now: Date) {
  try {
    return await recoverDueGiftReservations({
      listDue: async () => {
        const connection = await acquireDatabaseConnection()
        try {
          const [rows] = await connection.query<(RowDataPacket & DueGiftReservation)[]>("SELECT codeRef, claimId, checkoutSessionId FROM AI_GiftCodeSlot WHERE state = 'reserved' AND expiresAt <= ? ORDER BY expiresAt LIMIT 1000", [now])
          if (rows.length === 1000) await log.error('c5.gift.review_required', { reason: 'gift-reservation-sweep-truncated' }).catch(() => undefined)
          return rows
        } finally { connection.release() }
      },
      recoverUnbound: async row => {
        const connection = await acquireDatabaseConnection()
        try { return await recoverUnboundGiftSlot(connection, row.claimId, row.codeRef, now) }
        finally { connection.release() }
      },
      retrieve: id => stripe.checkout.sessions.retrieve(id),
      settle: settleGiftSession,
      flag: async (row, reason) => {
        await log.error('c5.gift.review_required', { claimId: row.claimId, sessionId: row.checkoutSessionId, reason }).catch(() => undefined)
      },
    })
  } catch {
    // A missing migration or outage must not stop the existing paid-purchase sweep.
    await log.error('c5.gift.review_required', { reason: 'gift-reservation-sweep-unavailable' }).catch(() => undefined)
    return { kind: 'unavailable' } as const
  }
}
