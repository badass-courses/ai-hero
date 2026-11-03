import type { PricingFacts } from '@ai-hero/front-desk-support'
import {
	price,
	type BindingQuoteData,
	type BuyerFactsData,
} from '@ai-hero/front-desk-support/pricing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthoritativePriceRequest } from '@coursebuilder/core/schemas'

import { C5_PRODUCT_ID, decodeDecisionRef } from './decision'
import {
	classifyEarlyBirdCode,
	EARLY_BIRD_CHECKOUT_CUTOFF_MS,
	EARLY_BIRD_CODE_REASONS,
	earlyBirdCouponId,
	withEarlyBirdWindow,
	type EarlyBirdCodeRow,
	type EarlyBirdCouponRow,
} from './early-bird-code'
import { createC5AuthoritativePrice, type BuyerRead, type C5PricingDeps } from './hook'
import {
	SYNTHETIC_LEGEND_PRODUCTS,
	SYNTHETIC_LIST,
	SYNTHETIC_POLICY_VERSION,
	SYNTHETIC_WINDOWS,
	syntheticPolicy,
} from './synthetic-policy.test-fixture'

// Synthetic policy: list 1000.00, new buyers 20% off until earlyEndsAt
// (2030-02-01 08:00Z), enrollment closes 2030-03-01 08:00Z.
const AFTER_EARLY = new Date('2030-02-03T00:00:00.000Z')
const CODE_EXPIRES = new Date('2030-02-05T08:00:00.000Z')
const PRICE_ID = 'price-c5'
const CREDIT = { paid: 10_000, source: 'purchase-cc' }

const known = <A>(value: A, sourceRefs: readonly string[] = ['test']) => ({
	value,
	sourceRefs,
})

const product = {
	appProductId: C5_PRODUCT_ID,
	merchantPriceId: PRICE_ID,
	merchantUnit: SYNTHETIC_LIST,
	sourceRefs: ['test:product'],
}

function buyerFacts(
	over: Partial<Omit<BuyerFactsData, 'ppp'>> = {},
): PricingFacts {
	return {
		product,
		buyer: { userId: 'user-1', sourceRefs: ['test:user'] },
		quantity: 1,
		facts: {
			order: known('individual' as const),
			alumni: known('none' as const),
			credit: known(null),
			creditUse: known('available' as const),
			existingSeats: known(0),
			legend: known(
				'no' as const,
				SYNTHETIC_LEGEND_PRODUCTS.map((id) => `product:${id}`),
			),
			ppp: known(null),
			...over,
		} as PricingFacts['facts'],
	}
}

const signedIn = (facts = buyerFacts()): BuyerRead => ({
	kind: 'buyer',
	email: 'buyer@example.test',
	facts,
	holdsRestrictedPurchase: false,
	holdsValidProductPurchase: false,
})

const coupon = (over: Partial<EarlyBirdCouponRow> = {}): EarlyBirdCouponRow => ({
	id: 'coupon_early1',
	status: 1,
	expires: CODE_EXPIRES,
	maxUses: -1,
	usedCount: 0,
	percentageDiscount: '0.20',
	amountDiscount: null,
	restrictedToProductId: C5_PRODUCT_ID,
	organizationId: null,
	fields: { bypassSoldOut: false },
	...over,
})

const presented = (row: EarlyBirdCouponRow | null = coupon()): EarlyBirdCodeRow => ({
	couponId: 'coupon_early1',
	row,
})

let deps: C5PricingDeps
let buyer: BuyerRead
let code: EarlyBirdCodeRow

function makeDeps(over: Partial<C5PricingDeps> = {}): C5PricingDeps {
	return {
		policy: vi.fn(async () => ({
			ok: true as const,
			value: { version: SYNTHETIC_POLICY_VERSION, policy: syntheticPolicy() },
		})),
		quotes: vi.fn(async () => ({
			ok: true as const,
			value: [] as readonly BindingQuoteData[],
		})),
		buyer: vi.fn(async () => buyer),
		trustedCountry: vi.fn(async () => 'US'),
		pppPercent: () => 0,
		price,
		engineVersion: 'engine-test',
		now: () => AFTER_EARLY,
		disabled: () => false,
		earlyBirdCode: vi.fn(async () => code),
		...over,
	}
}

const ask = (over: Partial<AuthoritativePriceRequest> = {}) =>
	createC5AuthoritativePrice(deps)({
		purpose: 'checkout',
		productId: C5_PRODUCT_ID,
		priceId: PRICE_ID,
		quantity: 1,
		userId: 'user-1',
		country: 'US',
		pppAccepted: false,
		...over,
	})

beforeEach(() => {
	buyer = signedIn()
	code = presented()
	deps = makeDeps()
})

describe('early-bird code at C5 checkout', () => {
	it('prices a code alone at the early percent off list', async () => {
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'priced', amountCents: 80_000 })
		expect(decision?.reasons).toContain(EARLY_BIRD_CODE_REASONS.applied)
		// The session ends when the code does.
		expect(decision?.closesAt).toBe(CODE_EXPIRES.getTime())
	})

	it('takes the Crash Course credit off after the percentage, and spends it', async () => {
		buyer = signedIn(buyerFacts({ credit: known(CREDIT) }))
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'priced', amountCents: 70_000 })
		expect(decodeDecisionRef(decision!.decisionRef)?.creditSource).toBe(
			'purchase-cc',
		)
	})

	it('without a code, the credit alone comes off list after the early window', async () => {
		code = { couponId: null }
		buyer = signedIn(buyerFacts({ credit: known(CREDIT) }))
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'priced', amountCents: 90_000 })
		expect(decision?.reasons).not.toContain(EARLY_BIRD_CODE_REASONS.applied)
		expect(decision?.reasons).not.toContain(EARLY_BIRD_CODE_REASONS.ended)
	})

	it('charges list and says the code has ended once it expires', async () => {
		deps = makeDeps({ now: () => new Date(CODE_EXPIRES.getTime() + 1) })
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'priced', amountCents: 100_000 })
		expect(decision?.reasons).toContain(EARLY_BIRD_CODE_REASONS.ended)
	})

	it('names the code and its window in the decisionRef', async () => {
		code = presented(coupon())
		const first = await ask()
		code = {
			couponId: 'coupon_other',
			row: coupon({ id: 'coupon_other', expires: new Date('2030-02-06T08:00:00.000Z') }),
		}
		const second = await ask()
		expect(first?.amountCents).toBe(second?.amountCents)
		expect(first?.decisionRef).not.toBe(second?.decisionRef)
	})

	it('says the code has ended when it is switched off, even with no expiry', async () => {
		for (const row of [coupon({ status: 0 }), coupon({ status: 0, expires: null })]) {
			code = presented(row)
			const decision = await ask()
			expect(decision).toMatchObject({ kind: 'priced', amountCents: 100_000 })
			expect(decision?.reasons).toContain(EARLY_BIRD_CODE_REASONS.ended)
		}
	})

	it('ignores codes that are not early-bird codes for this product', async () => {
		for (const row of [
			null,
			coupon({ expires: null }),
			// A use limit cannot be enforced on this path, so finite codes never apply.
			coupon({ maxUses: 3, usedCount: 0 }),
			coupon({ maxUses: 3, usedCount: 3 }),
			coupon({ percentageDiscount: '0.50' }),
			coupon({ restrictedToProductId: 'product-other' }),
			coupon({ organizationId: 'org-1' }),
			coupon({ amountDiscount: '100' }),
			coupon({ fields: { purpose: 'legend-gift' } }),
		]) {
			code = presented(row)
			const decision = await ask()
			expect(decision).toMatchObject({ kind: 'priced', amountCents: 100_000 })
			expect(decision?.reasons).not.toContain(EARLY_BIRD_CODE_REASONS.applied)
			expect(decision?.reasons).not.toContain(EARLY_BIRD_CODE_REASONS.ended)
		}
	})

	it('never prices a team order with a code', async () => {
		buyer = signedIn({
			...buyerFacts({ order: known('team' as const) }),
			quantity: 5,
		})
		const decision = await ask({ quantity: 5 })
		expect(decision?.reasons).not.toContain(EARLY_BIRD_CODE_REASONS.applied)
		expect(deps.earlyBirdCode).not.toHaveBeenCalled()
	})

	it('changes nothing inside the published early window', async () => {
		deps = makeDeps({ now: () => new Date('2030-01-05T00:00:00.000Z') })
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'priced', amountCents: 80_000 })
		expect(decision?.reasons).not.toContain(EARLY_BIRD_CODE_REASONS.applied)
		expect(decision?.closesAt).toBe(Date.parse(SYNTHETIC_WINDOWS.closesAt))
	})

	it('holds rather than charge list when the code row cannot be read', async () => {
		deps = makeDeps({
			earlyBirdCode: vi.fn(async () => {
				throw new Error('db down')
			}),
		})
		await expect(ask()).resolves.toMatchObject({ kind: 'held' })
	})

	it('leaves a verified legend gift on its own exact price', async () => {
		const gift = {
			codeRef: 'fixture-gift',
			unitPrice: 40_000,
			expiresAt: '2030-02-15T00:00:00.000Z',
			maxUses: 5,
			usesTaken: 0,
		}
		deps = makeDeps({
			disabled: () => true,
			overrideDisabled: () => false,
			code: async () => known(gift),
			now: () => new Date('2029-12-20T00:00:00.000Z'),
		})
		const decision = await ask()
		expect(decision).toMatchObject({ kind: 'priced', amountCents: 40_000 })
		expect(deps.earlyBirdCode).not.toHaveBeenCalled()
	})
})

describe('classifyEarlyBirdCode and withEarlyBirdWindow', () => {
	it('never runs the early window past enrollment close', () => {
		const policy = syntheticPolicy()
		const late = classifyEarlyBirdCode(
			presented(coupon({ expires: new Date('2031-01-01T00:00:00.000Z') })),
			policy,
			AFTER_EARLY.getTime(),
		)
		expect(late.state).toBe('valid')
		if (late.state !== 'valid') return
		const widened = withEarlyBirdWindow(policy, late)
		expect('value' in widened.earlyEndsAt && widened.earlyEndsAt.value).toBe(
			SYNTHETIC_WINDOWS.closesAt,
		)
	})

	it('reads as ended from the checkout cutoff before expiry, not at expiry', () => {
		const policy = syntheticPolicy()
		const at = (now: number) =>
			classifyEarlyBirdCode(presented(coupon()), policy, now).state
		const cutoff = CODE_EXPIRES.getTime() - EARLY_BIRD_CHECKOUT_CUTOFF_MS
		expect(EARLY_BIRD_CHECKOUT_CUTOFF_MS).toBe(31 * 60 * 1000)
		expect(at(cutoff - 1)).toBe('valid')
		expect(at(cutoff)).toBe('ended')
		expect(at(CODE_EXPIRES.getTime() - 1)).toBe('ended')
	})

	it('accepts only well-formed coupon ids', () => {
		expect(earlyBirdCouponId('coupon_h8hfc')).toBe('coupon_h8hfc')
		for (const bad of [null, '', 'coupon_', 'abc', "coupon_x' OR 1=1", 'coupon_' + 'a'.repeat(60)])
			expect(earlyBirdCouponId(bad)).toBeNull()
	})
})
