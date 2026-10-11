import { describe, expect, it } from 'vitest'
import { price, type BuyerFactsData } from '@ai-hero/front-desk-support/pricing'
import { syntheticPolicy, SYNTHETIC_POLICY_PRODUCT } from './synthetic-policy.test-fixture'
import { giftCheckoutOpen } from './gift-window'
import { toAuthoritativeDecision } from './decision'
import { C5_PRODUCT_ID } from './products'
const known = <A>(value: A) => ({ value, sourceRefs: ['synthetic-window'] })
const stop = '2030-02-28T07:30:00Z', end = '2030-02-28T08:00:00Z'
const policy = { ...syntheticPolicy(), checkoutStopsAt: { source: 'synthetic', value: stop }, closesAt: { source: 'synthetic', value: end } }
const facts: BuyerFactsData = { order: known('individual'), alumni: known('none'), credit: known(null), creditUse: known('available'), existingSeats: known(0), legend: known('no'), ppp: known(null), code: known(null) }
describe('creation cutoff and hosted expiry are distinct', () => {
  it('allows a 07:29 checkout with a 08:00 deadline and refuses 07:31', () => {
    const result = price({ product: { id: SYNTHETIC_POLICY_PRODUCT, merchantUnit: policy.list, policy }, quantity: 1, now: '2030-02-28T07:29:00Z', facts, quotes: [] })
    if (!result.ok || (result.value.kind !== 'priced' && result.value.kind !== 'bounded')) throw new Error('expected-priced')
    expect(toAuthoritativeDecision(result.value, { productId: C5_PRODUCT_ID, quantity: 1, userId: 'test-buyer', purpose: 'checkout', policy, pppPercent: null, engineVersion: result.value.engineVersion }).closesAt).toBe(Date.parse(end))
    const late = price({ product: { id: SYNTHETIC_POLICY_PRODUCT, merchantUnit: policy.list, policy }, quantity: 1, now: '2030-02-28T07:31:00Z', facts, quotes: [] })
    expect(late.ok && late.value.kind).toBe('closed')
  })
  it('shares the policy cutoff and derives an earlier provider-safe code window', () => {
    expect(giftCheckoutOpen(end, policy, Date.parse('2030-02-28T07:29:00Z'))).toBe(true)
    expect(giftCheckoutOpen(end, policy, Date.parse('2030-02-28T07:31:00Z'))).toBe(false)
    expect(giftCheckoutOpen('2030-02-28T07:30:00Z', policy, Date.parse('2030-02-28T07:01:00Z'))).toBe(false)
  })
})
