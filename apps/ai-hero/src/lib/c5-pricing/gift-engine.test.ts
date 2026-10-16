import { describe, it, expect } from 'vitest'
import { price, type BuyerFactsData, type CodeData } from '@ai-hero/front-desk-support/pricing'
import { syntheticPolicy, SYNTHETIC_POLICY_PRODUCT } from './synthetic-policy.test-fixture'
import { decodeDecisionRef, giftCodeDigest, toAuthoritativeDecision } from './decision'
import { C5_PRODUCT_ID } from './products'

const known = <A>(value: A) => ({ value, sourceRefs: ['synthetic-test'] })
const code: CodeData = { codeRef: 'test-reference', unitPrice: 40000, maxUses: 5, usesTaken: 0, expiresAt: '2030-02-15T00:00:00.000Z' }
const base: BuyerFactsData = {
	code: known(code), alumni: known('none'), credit: known(null), creditUse: known('available'), existingSeats: known(0), legend: known('no'), order: known('individual'), ppp: known(null),
}
const policy = syntheticPolicy()
const run = (facts: BuyerFactsData = base, quantity = 1, now = '2030-01-15T00:00:00.000Z') => {
	const result = price({ facts, quantity, now, product: { id: SYNTHETIC_POLICY_PRODUCT, merchantUnit: policy.list, policy }, quotes: [] })
	if (!result.ok) throw new Error('synthetic-engine-input-invalid')
	if (result.value.kind !== 'priced' && result.value.kind !== 'bounded') throw new Error('synthetic-test-price-refused')
	return result.value
}
describe('vendored gift code rule integration', () => {
	it('wins as one independent candidate, never combined with a credit', () => {
		const result = run({ ...base, credit: known({ paid: 15000, source: 'test-credit' }) })
		expect(result.amount).toBe(40000)
		expect(result.basis).toBe('code')
		expect(result.codeRef).toBe(code.codeRef)
		expect(result.creditSource).toBeNull()
	})
	it('keeps a lower eligible alumni and credit formula without consuming the gift', () => {
		const result = run({ ...base, code: known({ ...code, unitPrice: 60000 }), alumni: known('c3'), credit: known({ paid: 15000, source: 'test-credit' }) })
		expect(result.amount).toBe(50000)
		expect(result.codeRef).toBeUndefined()
		expect(result.creditSource).toBe('test-credit')
	})
	it('does not stack with PPP or a team band', () => {
		const ppp = run({ ...base, ppp: known({ accepted: true, percent: 75 }) })
		expect(ppp.amount).toBe(25000)
		expect(ppp.codeRef).toBeUndefined()
		for (const quantity of [2, 5]) expect(run({ ...base, order: known('team') }, quantity).codeRef).toBeUndefined()
	})
	it('has no code candidate at the use cap or expiry boundary', () => {
		expect(run({ ...base, code: known({ ...code, usesTaken: 5 }) }).codeRef).toBeUndefined()
		expect(run(base, 1, code.expiresAt).codeRef).toBeUndefined()
	})
	it('carries an opaque digest to checkout and caps its lifetime at the code expiry', () => {
		const result = run()
		const decision = toAuthoritativeDecision(result, { productId: C5_PRODUCT_ID, quantity: 1, userId: 'test-buyer', purpose: 'checkout', policy, engineVersion: result.engineVersion, pppPercent: null, codeExpiresAt: code.expiresAt })
		expect(decodeDecisionRef(decision.decisionRef)?.codeDigest).toBe(giftCodeDigest(code.codeRef))
		expect(decision.closesAt).toBe(Date.parse(code.expiresAt))
	})
})
