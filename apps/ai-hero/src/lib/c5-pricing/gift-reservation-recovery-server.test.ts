import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
const mocks = vi.hoisted(() => ({ acquire: vi.fn(), error: vi.fn(async () => undefined) }))
vi.mock('@/db', () => ({ acquireDatabaseConnection: mocks.acquire }))
vi.mock('@/server/logger', () => ({ log: { error: mocks.error } }))
vi.mock('./gift-settlement', () => ({ settleGiftSession: vi.fn() }))
import { recoverGiftReservations } from './gift-reservation-recovery-server'
describe('gift recovery does not block paid-purchase reconciliation', () => {
  it('a missing migration or DB outage returns unavailable rather than throwing', async () => {
    mocks.acquire.mockRejectedValue(new Error('database unavailable'))
    expect(await recoverGiftReservations({} as Stripe, new Date())).toEqual({ kind: 'unavailable' })
    expect(mocks.error).toHaveBeenCalledWith('c5.gift.review_required', { reason: 'gift-reservation-sweep-unavailable' })
  })
  it('releases its database connection when the reservation query fails', async () => {
    const release = vi.fn()
    mocks.acquire.mockResolvedValue({ query: vi.fn(async () => { throw new Error('table absent') }), release })
    expect(await recoverGiftReservations({} as Stripe, new Date())).toEqual({ kind: 'unavailable' })
    expect(release).toHaveBeenCalledTimes(1)
  })
})
