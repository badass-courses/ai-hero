import {
	ENGINE_VERSION,
	price,
	type BuyerFactsData,
	type FactData,
	type PriceRequestData,
	type PricingPolicyData,
	type PricingResultData,
} from '@ai-hero/front-desk-support/pricing'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
	C5_PRODUCT_ID,
	decodeDecisionRef,
	toAuthoritativeDecision,
} from './decision'
import { createC5AuthoritativePrice, type C5PricingDeps } from './hook'
import { isPppCreditBound } from './ppp-credit-bound'
import { purchaseGate } from './purchasability'
import { APP_REASONS } from './reasons'
import {
	SYNTHETIC_LEGEND_PRODUCTS,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

// Offline, synthetic policies only. Keep the seed fixed for CI; fast-check prints
// the seed and shrink path on failure so a counterexample can be replayed.
const runs = { seed: 0xc500020, numRuns: 500 }
const known = <A>(value: A): FactData<A> => ({
	value,
	sourceRefs: ['synthetic:test'],
})
const ruled = <A>(value: A) => ({
	value,
	source: 'synthetic:credit-off-regional',
})
const early = '2030-01-15T00:00:00.000Z'
const standard = '2030-02-15T00:00:00.000Z'
const cents = fc.integer({ min: 0, max: 200_000 })
const percent = fc.integer({ min: 0, max: 100 })
const gap = fc.constantFrom(
	'FactsUnavailable',
	'IdentityUnverified',
	'PaymentAmbiguous',
)
const creditUse = fc.constantFrom(
	'available',
	'reserved-by-this-attempt',
	'spent',
)
const alumni = fc.constantFrom('none', 'c3', 'c4', 'multiple')
const off = (amount: number, discount: number) =>
	Math.floor((amount * (100 - discount)) / 100)
const sample = fc.record({
	list: fc.integer({ min: 1, max: 200_000 }),
	paid: cents,
	ppp: percent,
	accepted: fc.boolean(),
	early: fc.boolean(),
	newDiscount: percent,
	alumniDiscount: percent,
	alumni,
	creditUse,
})
type Sample = typeof sample extends fc.Arbitrary<infer A> ? A : never

function request(s: Sample): PriceRequestData {
	const policy = syntheticPolicy({
		version: 'synthetic@test.credit-off-regional',
		list: s.list,
		creditOffPpp: ruled(true),
		creditPaidMaximum: ruled(200_000),
		newBuyerEarlyPercent: ruled(s.newDiscount),
		alumniPercent: ruled(s.alumniDiscount),
	})
	return {
		product: { id: policy.product, merchantUnit: s.list, policy },
		now: s.early ? early : standard,
		quantity: 1,
		quotes: [],
		facts: {
			order: known('individual'),
			alumni: known(s.alumni),
			credit: known(
				s.paid === 0 ? null : { paid: s.paid, source: 'synthetic-purchase' },
			),
			creditUse: known(s.creditUse),
			existingSeats: known(0),
			legend: {
				value: 'no',
				sourceRefs: SYNTHETIC_LEGEND_PRODUCTS.map((id) => `product:${id}`),
			},
			ppp: known({ accepted: s.accepted, percent: s.ppp }),
		},
	}
}

function evaluate(input: PriceRequestData): PricingResultData {
	const decoded = price(input)
	expect(decoded.ok, JSON.stringify(decoded)).toBe(true)
	if (!decoded.ok) throw new Error('Synthetic request did not decode')
	return decoded.value
}

function priced(input: PriceRequestData) {
	const result = evaluate(input)
	expect(result.kind).toBe('priced')
	if (result.kind !== 'priced') throw new Error('Expected a resolved price')
	return result
}

function decision(result: PricingResultData, input: PriceRequestData) {
	return toAuthoritativeDecision(result, {
		productId: C5_PRODUCT_ID,
		quantity: input.quantity,
		userId: 'synthetic-user',
		purpose: 'checkout',
		policy: input.product.policy,
		engineVersion: ENGINE_VERSION,
		pppPercent:
			'value' in input.facts.ppp
				? (input.facts.ppp.value?.percent ?? null)
				: null,
	})
}

function hook(input: PriceRequestData, overrides: Partial<C5PricingDeps> = {}) {
	return createC5AuthoritativePrice({
		policy: async () => ({
			ok: true,
			value: {
				version: input.product.policy.version,
				policy: input.product.policy,
			},
		}),
		quotes: async () => ({ ok: true, value: input.quotes }),
		buyer: async () => ({
			kind: 'buyer',
			email: 'buyer@example.test',
			holdsRestrictedPurchase: false,
			holdsValidProductPurchase: false,
			facts: {
				product: {
					appProductId: C5_PRODUCT_ID,
					merchantPriceId: 'synthetic-price',
					merchantUnit: input.product.merchantUnit,
					sourceRefs: ['synthetic:product'],
				},
				buyer: { userId: 'synthetic-user', sourceRefs: ['synthetic:user'] },
				quantity: input.quantity,
				facts: input.facts,
			},
		}),
		trustedCountry: async () => 'IN',
		pppPercent: () =>
			'value' in input.facts.ppp ? (input.facts.ppp.value?.percent ?? 0) : 0,
		price,
		engineVersion: ENGINE_VERSION,
		now: () => new Date(input.now),
		disabled: () => false,
		...overrides,
	})
}

const ask = (
	quantity = 1,
	purpose: 'display' | 'checkout' = 'checkout',
	pppAccepted = true,
) => ({
	productId: C5_PRODUCT_ID,
	priceId: 'synthetic-price',
	userId: 'synthetic-user',
	country: 'IN',
	quantity,
	purpose,
	pppAccepted,
})

const gate = (d: NonNullable<Awaited<ReturnType<ReturnType<typeof hook>>>>) =>
	purchaseGate({
		authoritative: {
			...d,
			purchasable: d.kind === 'priced',
			isUpperBound: d.kind === 'bounded',
		},
	})

// Independent contract, not derived from the values emitted by the code under test.
const allowedReasons = new Set([
	'policy-disabled',
	'policy-unresolved',
	'merchant-price-mismatch',
	'not-open',
	'checkout-stopped',
	'enrollment-closed',
	'fact-unknown',
	'credit-amount-unrecognized',
	'credit-spent',
	'individual-quantity',
	'quote-basis-unknown',
	'quote-expired',
	'quote-out-of-scope',
	'early-window',
	'standard-window',
	'selected',
	'formula-uses-crash-course-credit',
	'identity-required',
	'quotes-unavailable',
	'quotes-unavailable-at-checkout',
	'policy-unavailable',
	'facts-unavailable',
	'kill-switch',
	'already-owned',
	'restricted-holder',
	'ppp-credit-unresolved-bound',
])

function checkReasons(reasons: readonly string[]) {
	for (const reason of reasons)
		expect(allowedReasons.has(reason), reason).toBe(true)
}

describe('C5 credit-off-regional pricing properties (vendored engine 0.2.3)', () => {
	it('exercises the pinned engine, not a mocked pricing implementation', () => {
		expect(ENGINE_VERSION).toBe('0.2.3')
	})

	it('subtracts one settled credit from the winning standard or regional price, with only a zero floor', () => {
		fc.assert(
			fc.property(sample, (s) => {
				const input = request(s)
				const result = priced(input)
				const standardBase = Math.min(
					off(s.list, s.early ? s.newDiscount : 0),
					s.alumni === 'none' ? s.list : off(s.list, s.alumniDiscount),
				)
				const winningBase = s.accepted
					? Math.min(standardBase, off(s.list, s.ppp))
					: standardBase
				const usableCredit = s.creditUse === 'spent' ? 0 : s.paid
				const expected = Math.max(0, winningBase - usableCredit)
				expect(result.amount).toBe(expected)
				expect(result.amount).toBeGreaterThanOrEqual(0)
				expect(winningBase - result.amount).toBe(
					Math.min(usableCredit, winningBase),
				)
				const withoutCredit = priced({
					...input,
					facts: { ...input.facts, credit: known(null) },
				})
				expect(result.amount).toBeLessThanOrEqual(withoutCredit.amount)
				for (const candidate of [...result.candidates, ...result.offers]) {
					expect(Number.isSafeInteger(candidate.amount)).toBe(true)
					expect(candidate.amount).toBeGreaterThanOrEqual(0)
				}
				const mapped = decision(result, input)
				expect(mapped.amountCents).toBe(expected)
				expect(decodeDecisionRef(mapped.decisionRef)?.creditSource).toBe(
					result.creditSource,
				)
			}),
			runs,
		)
	})

	it('can charge every small cent amount, including zero: there is no hidden minimum', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 999 }),
				fc.boolean(),
				(target, regional) => {
					const input = request({
						list: 10_000,
						paid: (regional ? 5_000 : 10_000) - target,
						ppp: 50,
						accepted: regional,
						early: false,
						newDiscount: 0,
						alumniDiscount: 0,
						alumni: 'none',
						creditUse: 'available',
					})
					expect(priced(input).amount).toBe(target)
				},
			),
			{
				...runs,
				examples: [
					[0, true],
					[0, false],
					[1, true],
					[1, false],
				],
			},
		)
	})

	it('does not stack Crash Course credit onto a cheaper quote or legend benefit', () => {
		fc.assert(
			fc.property(sample, cents, fc.boolean(), (s, quoteAmount, legend) => {
				const input = request(s)
				const baseline = priced(input)
				const legendRuling = input.product.policy.legend
				if (!('value' in legendRuling))
					throw new Error('Synthetic legend must resolve')
				const legendAmount = Math.max(
					0,
					off(s.list, legendRuling.value.percent) - legendRuling.value.credit,
				)
				const withAlternatives: PriceRequestData = {
					...input,
					facts: {
						...input.facts,
						legend: {
							...input.facts.legend,
							value: legend ? 'verified' : 'no',
						},
					},
					quotes: [
						{
							ref: 'synthetic-quote',
							amount: quoteAmount,
							basis: 'Total',
							currency: 'USD',
							expiresAt: null,
							product: input.product.id,
							quantity: 1,
						},
					],
				}
				const result = priced(withAlternatives)
				expect(result.amount).toBe(
					Math.min(
						baseline.amount,
						quoteAmount,
						legend ? legendAmount : Infinity,
					),
				)
				if (result.basis === 'quote' || result.rule === 'legend')
					expect(result.creditSource).toBeNull()
			}),
			runs,
		)
	})

	it('repeats the same engine decision, decisionRef and hook amount for identical input', async () => {
		await fc.assert(
			fc.asyncProperty(sample, async (s) => {
				const input = request(s)
				const first = evaluate(input)
				const second = evaluate(structuredClone(input))
				expect(second).toEqual(first)
				expect(decision(second, input)).toEqual(decision(first, input))
				const decide = hook(input)
				const a = await decide(ask(1, 'checkout', s.accepted))
				const b = await decide(ask(1, 'checkout', s.accepted))
				expect(b).toEqual(a)
				expect(a?.amountCents).toBe(priced(input).amount)
			}),
			runs,
		)
	})

	it('never gives team quantity > 1 a regional candidate, offer or checkout price', async () => {
		await fc.assert(
			fc.asyncProperty(
				sample,
				fc.integer({ min: 2, max: 100 }),
				fc.integer({ min: 0, max: 100 }),
				async (s, quantity, seats) => {
					const base = request({ ...s, accepted: true })
					const input = {
						...base,
						quantity,
						facts: {
							...base.facts,
							order: known('team' as const),
							existingSeats: known(seats),
						},
					}
					const result = priced(input)
					for (const candidate of [
						result,
						...result.candidates,
						...result.offers,
					]) {
						expect(candidate.restriction).toBe('none')
						expect(candidate.basis).not.toBe('ppp')
					}
					const d = await hook(input)(ask(quantity))
					expect(d?.kind).toBe('priced')
					expect(d?.restriction).toBe('none')
					expect(d?.amountCents).toBe(result.amount)
					expect(d?.offers.every((offer) => offer.restriction === 'none')).toBe(
						true,
					)
				},
			),
			runs,
		)
	})

	it('promotes only the exact PPP unresolved-credit signature and charges its bound', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 100, max: 200_000 }),
				fc.integer({ min: 1, max: 99 }),
				gap,
				fc.integer({ min: 0, max: 13 }),
				fc.constantFrom('display', 'checkout'),
				async (list, ppp, missing, mutation, purpose) => {
					const resolved = request({
						list,
						paid: 0,
						ppp,
						accepted: true,
						early: false,
						newDiscount: 0,
						alumniDiscount: 0,
						alumni: 'none',
						creditUse: 'available',
					})
					const input = {
						...resolved,
						facts: { ...resolved.facts, credit: { gap: missing } },
					}
					const base = evaluate(input)
					// At these bounds the regional amount is always positive, and only
					// the unresolved credit could lower it. Use the real engine as source.
					expect(base.kind).toBe('bounded')
					if (base.kind !== 'bounded') throw new Error('Expected credit bound')
					let result: PricingResultData = base
					let policy: PricingPolicyData = input.product.policy
					switch (mutation) {
						case 1:
							result = { ...base, amount: 0 }
							break
						case 2:
							result = { ...base, amount: list + 0.5 }
							break
						case 3:
							result = { ...base, creditSource: 'synthetic-purchase' }
							break
						case 4:
							result = { ...base, restriction: 'none' }
							break
						case 5:
							result = { ...base, basis: 'formula' }
							break
						case 6:
							result = { ...base, rule: 'new' }
							break
						case 7:
							result = { ...base, engineVersion: '0.1.0' }
							break
						case 8:
							result = { ...base, unresolved: [] }
							break
						case 9:
							result = {
								...base,
								unresolved: [
									...base.unresolved,
									{
										candidate: 'ppp',
										fact: 'ppp',
										gap: missing,
										needs: 'synthetic',
									},
								],
							}
							break
						case 10:
							result = {
								...base,
								unresolved: [
									{
										candidate: 'credit',
										fact: 'creditUse',
										gap: missing,
										needs: 'synthetic',
									},
								],
							}
							break
						case 11:
							result = {
								...base,
								reasons: [
									...base.reasons,
									{ code: 'quote-basis-unknown', detail: 'synthetic' },
								],
							}
							break
						case 12:
							policy = { ...policy, creditOffPpp: ruled(false) }
							break
						case 13:
							result = {
								...base,
								reasons: base.reasons.filter(
									(reason) => reason.code !== 'fact-unknown',
								),
							}
							break
					}
					expect(isPppCreditBound(result, policy)).toBe(mutation === 0)
					const d = await hook(
						{ ...input, product: { ...input.product, policy } },
						{ price: () => ({ ok: true, value: result }) },
					)(ask(1, purpose))
					expect(d).not.toBeNull()
					if (!d) throw new Error('C5 decision missing')
					expect(d.kind).toBe(
						mutation === 0 && purpose === 'checkout' ? 'priced' : 'bounded',
					)
					expect(d.amountCents).toBe(result.amount)
					expect(d.reasons.includes(APP_REASONS.pppCreditBound)).toBe(
						mutation === 0,
					)
					expect(gate(d).kind).toBe(mutation === 0 ? 'buy' : 'blocked')
					if (mutation === 0)
						expect(decodeDecisionRef(d.decisionRef)?.creditSource).toBeNull()
					checkReasons(d.reasons)
				},
			),
			runs,
		)
	})

	it('emits only allowed reasons across generated refusals, fact gaps and quotes', async () => {
		await fc.assert(
			fc.asyncProperty(
				sample,
				gap,
				fc.integer({ min: 0, max: 13 }),
				async (s, missing, scenario) => {
					let input = request(s)
					const policy = input.product.policy
					switch (scenario) {
						case 1:
							input = {
								...input,
								product: {
									...input.product,
									policy: { ...policy, enabled: false },
								},
							}
							break
						case 2:
							input = {
								...input,
								product: {
									...input.product,
									policy: {
										...policy,
										creditOffPpp: { question: 'synthetic' },
									},
								},
							}
							break
						case 3:
							input = {
								...input,
								product: { ...input.product, merchantUnit: s.list + 1 },
							}
							break
						case 4:
							input = { ...input, now: '2029-12-01T00:00:00.000Z' }
							break
						case 5:
							input = { ...input, now: '2030-03-01T07:45:00.000Z' }
							break
						case 6:
							input = { ...input, now: '2030-03-02T00:00:00.000Z' }
							break
						case 7:
							input = {
								...input,
								facts: { ...input.facts, credit: { gap: missing } },
							}
							break
						case 8:
							input = {
								...input,
								facts: {
									...input.facts,
									credit: known({ paid: 200_001, source: 'synthetic' }),
								},
							}
							break
						case 9:
							input = { ...input, quantity: 2 }
							break
						case 10:
							input = {
								...input,
								facts: {
									...input.facts,
									legend: { gap: missing },
									alumni: { gap: missing },
								},
							}
							break
						case 11:
						case 12:
						case 13:
							input = {
								...input,
								quotes: [
									{
										ref: 'synthetic',
										amount: s.paid,
										basis: scenario === 11 ? 'Unknown' : 'Total',
										currency: scenario === 13 ? 'EUR' : 'USD',
										expiresAt:
											scenario === 12 ? '2029-01-01T00:00:00.000Z' : null,
										quantity: 1,
										product: policy.product,
									},
								],
							}
							break
					}
					const result = evaluate(input)
					checkReasons(result.reasons.map((reason) => reason.code))
					checkReasons(decision(result, input).reasons)
					const d = await hook(input)(
						ask(input.quantity, 'checkout', s.accepted),
					)
					expect(d).not.toBeNull()
					checkReasons(d!.reasons)
				},
			),
			runs,
		)
		checkReasons(Object.values(APP_REASONS))
	})
})
