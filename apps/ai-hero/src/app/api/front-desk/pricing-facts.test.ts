import {
	createFrontDeskHandler,
	type ChargeState,
	type PricingFacts,
	type PricingRequest,
} from '@ai-hero/front-desk-support'
import { Effect, Exit, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
	buyerPricingFacts,
	PricingFactsSource,
	SourceUnavailable,
	type PricingPurchaseRow,
} from './pricing-facts'

// Synthetic database: plain rows behind the same source port the live layer
// fills from MySQL and Stripe. No real customer, provider or DB data.
const C5 = 'product-s00zs'
const CC = 'product-ma254'
const C3 = 'product-7t9ek'
const C4 = 'product-pqkk5'

interface SyntheticDb {
	users?: Record<string, string>
	purchases?: PricingPurchaseRow[]
	coupons?: Record<string, string | null>
	prices?: { id: string; unitAmountCents: number }[]
	charges?: Record<string, ChargeState>
	down?: SourceUnavailable['source'][]
}
const purchase = (
	over: Partial<PricingPurchaseRow> & Pick<PricingPurchaseRow, 'id'>,
): PricingPurchaseRow => ({
	productId: CC,
	status: 'Valid',
	bulkCouponId: null,
	redeemedBulkCouponId: null,
	bulkSeats: null,
	couponId: null,
	totalAmountCents: 25_000,
	stripeChargeId: `ch_${over.id}`,
	...over,
})
const charge = (
	id: string,
	over: Partial<ChargeState> = {},
): [string, ChargeState] => [
	`ch_${id}`,
	{
		stripeChargeId: `ch_${id}`,
		amount: 25_000,
		currency: 'usd',
		amountRefunded: 0,
		refundCount: 0,
		disputed: false,
		disputeStatus: null,
		presentmentAmount: null,
		presentmentCurrency: null,
		...over,
	},
]
const email = 'buyer@example.test'
const ask: PricingRequest = {
	email,
	productId: C5,
	quantity: 1,
	orderKind: 'individual',
}

function synthetic(data: SyntheticDb) {
	const chargeReads: string[] = []
	const down = (source: SourceUnavailable['source']) =>
		data.down?.includes(source)
	const fail = (source: SourceUnavailable['source']) =>
		Effect.fail(new SourceUnavailable({ source }))
	const layer = Layer.succeed(PricingFactsSource, {
		userByEmail: (address) =>
			down('user')
				? fail('user')
				: Effect.succeed(
						data.users?.[address] ? { id: data.users[address]! } : null,
					),
		purchases: (userId, productIds) =>
			down('purchases')
				? fail('purchases')
				: Effect.succeed(
						(data.purchases ?? []).filter((row) =>
							productIds.includes(row.productId),
						),
					),
		couponTypes: (ids) =>
			down('coupons')
				? fail('coupons')
				: Effect.succeed(
						new Map(
							ids.flatMap((id) =>
								data.coupons && id in data.coupons
									? [[id, data.coupons[id]!] as const]
									: [],
							),
						),
					),
		activePrices: () =>
			down('price')
				? fail('price')
				: Effect.succeed(
						data.prices ?? [{ id: 'price-test', unitAmountCents: 100_000 }],
					),
		chargeState: (id) => {
			chargeReads.push(id)
			return down('charge')
				? fail('charge')
				: Effect.succeed(data.charges?.[id] ?? null)
		},
	})
	return { layer, chargeReads }
}
const run = (data: SyntheticDb, request: PricingRequest = ask) => {
	const { layer, chargeReads } = synthetic(data)
	return Effect.runPromise(
		buyerPricingFacts(request).pipe(Effect.provide(layer)),
	).then((facts) => ({ facts: facts!, chargeReads }))
}
const buyer = { users: { [email]: 'user-test' } }
const creditOf = async (data: SyntheticDb) =>
	(await run({ ...buyer, ...data })).facts.facts.credit

describe('buyerPricingFacts', () => {
	it('reports facts only for products it supports', async () => {
		const { layer } = synthetic(buyer)
		expect(
			await Effect.runPromise(
				buyerPricingFacts({ ...ask, productId: CC }).pipe(
					Effect.provide(layer),
				),
			),
		).toBeNull()
	})

	it('keeps legend and PPP as gaps, with the product, quantity and order from the request', async () => {
		const { facts } = await run(buyer, {
			...ask,
			orderKind: 'team',
			quantity: 7,
		})
		expect(facts).toMatchObject({
			product: {
				appProductId: C5,
				merchantPriceId: 'price-test',
				merchantUnit: 100_000,
				sourceRefs: ['ai-hero:price:price-test'],
			},
			buyer: { userId: 'user-test', sourceRefs: ['ai-hero:user:user-test'] },
			quantity: 7,
		})
		expect(Object.keys(facts).sort()).toEqual([
			'buyer',
			'facts',
			'product',
			'quantity',
		])
		expect(facts.facts.legend).toEqual({ gap: 'FactsUnavailable' })
		expect(facts.facts.ppp).toEqual({ gap: 'FactsUnavailable' })
		expect(facts.facts.order).toEqual({
			value: 'team',
			sourceRefs: ['request:orderKind'],
		})
	})

	it('every known fact carries sourceRefs and none carries the email', async () => {
		const { facts } = await run({
			...buyer,
			purchases: [
				purchase({ id: 'cc' }),
				purchase({
					id: 'c4',
					productId: C4,
					totalAmountCents: 0,
					stripeChargeId: null,
				}),
			],
			charges: Object.fromEntries([charge('cc')]),
		})
		for (const fact of Object.values(facts.facts))
			if ('value' in fact) expect(fact.sourceRefs.length).toBeGreaterThan(0)
		expect(JSON.stringify(facts)).not.toContain(email)
	})

	it('an email with no account is a new buyer by evidence, not a gap', async () => {
		const { facts } = await run({})
		expect(facts.buyer).toEqual({
			userId: null,
			sourceRefs: ['ai-hero:user:none-for-email'],
		})
		expect(facts.facts).toMatchObject({
			alumni: { value: 'none' },
			credit: { value: null },
			creditUse: { value: 'available' },
			existingSeats: { value: 0 },
		})
	})

	it.each(['user', 'purchases'] as const)(
		'an unavailable %s source becomes gaps, never an empty history',
		async (source) => {
			const { facts } = await run({ ...buyer, down: [source] })
			for (const field of [
				'alumni',
				'credit',
				'creditUse',
				'existingSeats',
			] as const)
				expect(facts.facts[field]).toEqual({ gap: 'FactsUnavailable' })
		},
	)

	it.each([
		['no active price', [] as { id: string; unitAmountCents: number }[]],
		[
			'two active prices',
			[
				{ id: 'a', unitAmountCents: 100_000 },
				{ id: 'b', unitAmountCents: 90_000 },
			],
		],
	])('fails typed when there is %s', async (_, prices) => {
		const { layer } = synthetic({ ...buyer, prices })
		const exit = await Effect.runPromiseExit(
			buyerPricingFacts(ask).pipe(Effect.provide(layer)),
		)
		expect(Exit.isFailure(exit)).toBe(true)
		expect(JSON.stringify(exit)).toContain('NotExactlyOneActivePrice')
	})

	it('fails typed when the price source is down', async () => {
		const { layer } = synthetic({ ...buyer, down: ['price'] })
		const exit = await Effect.runPromiseExit(
			buyerPricingFacts(ask).pipe(Effect.provide(layer)),
		)
		expect(JSON.stringify(exit)).toContain('MerchantPriceUnavailable')
	})
})

describe('alumni', () => {
	const alumniOf = async (purchases: PricingPurchaseRow[]) =>
		(await run({ ...buyer, purchases })).facts.facts.alumni
	const c3 = purchase({ id: 'c3', productId: C3 })
	const c4 = purchase({ id: 'c4', productId: C4 })

	it.each([
		['C3', [c3], 'c3'],
		['C4', [c4], 'c4'],
		['both', [c3, c4], 'both'],
		[
			'a $0 C3-to-C4 update',
			[
				purchase({
					id: 'c4',
					productId: C4,
					totalAmountCents: 0,
					stripeChargeId: null,
				}),
			],
			'c4',
		],
		['a Restricted (PPP) C4 purchase', [{ ...c4, status: 'Restricted' }], 'c4'],
		['a refunded C4 purchase', [{ ...c4, status: 'Refunded' }], 'none'],
		['a redeemed team seat', [{ ...c4, redeemedBulkCouponId: 'bulk' }], 'none'],
		[
			'a team purchase',
			[{ ...c4, bulkCouponId: 'bulk', bulkSeats: 5 }],
			'none',
		],
		['another product', [purchase({ id: 'cc' })], 'none'],
	] as const)('%s gives %s', async (_, purchases, value) => {
		expect(await alumniOf([...purchases])).toMatchObject({ value })
	})

	it('cites the qualifying purchases', async () => {
		expect(await alumniOf([c3, c4])).toEqual({
			value: 'both',
			sourceRefs: ['ai-hero:purchase:c3', 'ai-hero:purchase:c4'],
		})
	})
})

describe('Crash Course credit', () => {
	it('is the settled USD charge amount, not the purchase total or presentment', async () => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc', totalAmountCents: 25_000 })],
				charges: Object.fromEntries([
					charge('cc', {
						amount: 25_000,
						presentmentAmount: 18_000,
						presentmentCurrency: 'eur',
					}),
				]),
			}),
		).toEqual({
			value: { paid: 25_000, source: 'cc' },
			sourceRefs: ['ai-hero:purchase:cc', 'stripe:charge:ch_cc'],
		})
	})

	it('takes one highest credit, never a sum', async () => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'low' }), purchase({ id: 'high' })],
				charges: Object.fromEntries([
					charge('low', { amount: 12_300 }),
					charge('high', { amount: 45_600 }),
				]),
			}),
		).toMatchObject({ value: { paid: 45_600, source: 'high' } })
	})

	it.each([
		['Restricted (PPP)', { status: 'Restricted' }, 'restricted-ppp'],
		['refunded', { status: 'Refunded' }, 'refunded'],
		['a bulk purchase', { bulkCouponId: 'bulk', bulkSeats: 3 }, 'bulk'],
		[
			'a redeemed bulk seat',
			{ redeemedBulkCouponId: 'bulk' },
			'redeemed-bulk-seat',
		],
		['a PPP coupon', { couponId: 'coupon-ppp' }, 'ppp-coupon'],
		['a bulk coupon', { couponId: 'coupon-bulk' }, 'bulk-coupon'],
		['zero-paid', { totalAmountCents: 0, stripeChargeId: null }, 'zero-paid'],
	] as const)('excludes %s without asking Stripe', async (_, over, why) => {
		const { facts, chargeReads } = await run({
			...buyer,
			purchases: [purchase({ id: 'cc', ...over })],
			coupons: { 'coupon-ppp': 'ppp', 'coupon-bulk': 'bulk' },
		})
		expect(facts.facts.credit).toEqual({
			value: null,
			sourceRefs: [`ai-hero:purchase:cc#excluded:${why}`],
		})
		expect(chargeReads).toEqual([])
	})

	it.each([
		[
			'fully refunded at Stripe',
			{ amountRefunded: 25_000, refundCount: 1 },
			'refunded',
		],
		['a zero charge', { amount: 0 }, 'zero-paid'],
	] as const)('excludes a charge that was %s', async (_, over, why) => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc' })],
				charges: Object.fromEntries([charge('cc', over)]),
			}),
		).toEqual({
			value: null,
			sourceRefs: [`ai-hero:purchase:cc#excluded:${why}`],
		})
	})

	it.each([
		[
			'partly refunded',
			{
				charges: Object.fromEntries([
					charge('cc', { amountRefunded: 5_000, refundCount: 1 }),
				]),
			},
			'PaymentAmbiguous',
		],
		[
			'disputed',
			{ charges: Object.fromEntries([charge('cc', { disputed: true })]) },
			'PaymentAmbiguous',
		],
		[
			'not USD',
			{ charges: Object.fromEntries([charge('cc', { currency: 'eur' })]) },
			'PaymentAmbiguous',
		],
		['missing at Stripe', { charges: {} }, 'PaymentAmbiguous'],
		['unreadable at Stripe', { down: ['charge'] }, 'FactsUnavailable'],
	] as const)('holds a charge that is %s', async (_, data, reason) => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc' })],
				...data,
			} as SyntheticDb),
		).toEqual({ gap: reason })
	})

	it.each([
		['a status it does not know', purchase({ id: 'cc', status: 'Disputed' })],
		[
			'a coupon it cannot find',
			purchase({ id: 'cc', couponId: 'coupon-gone' }),
		],
		[
			'money but no Stripe charge',
			purchase({ id: 'cc', stripeChargeId: null }),
		],
	])('holds a purchase with %s', async (_, row) => {
		expect(await creditOf({ purchases: [row] })).toEqual({
			gap: 'PaymentAmbiguous',
		})
	})

	it('holds when the coupon source is down', async () => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc', couponId: 'coupon-x' })],
				down: ['coupons'],
			}),
		).toEqual({ gap: 'FactsUnavailable' })
	})

	it('holds when any candidate is unresolved, even beside a clean credit', async () => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'good' }), purchase({ id: 'bad' })],
				charges: Object.fromEntries([
					charge('good'),
					charge('bad', { disputed: true }),
				]),
			}),
		).toEqual({ gap: 'PaymentAmbiguous' })
	})

	it('reports no Crash Course purchase as no credit, citing the scan', async () => {
		expect(await creditOf({ purchases: [] })).toEqual({
			value: null,
			sourceRefs: ['ai-hero:purchases:user:user-test'],
		})
	})
})

describe('team seats and credit use', () => {
	const bulk = (id: string, over: Partial<PricingPurchaseRow> = {}) =>
		purchase({
			id,
			productId: C5,
			bulkCouponId: 'bulk-a',
			bulkSeats: 5,
			...over,
		})

	it.each([
		['one bulk purchase', [bulk('a')], 5],
		['two purchases on one bulk coupon', [bulk('a'), bulk('b')], 5],
		[
			'two bulk coupons',
			[bulk('a'), bulk('b', { bulkCouponId: 'bulk-b', bulkSeats: 3 })],
			8,
		],
		['a refunded bulk purchase', [bulk('a', { status: 'Refunded' })], 0],
		['another product', [bulk('a', { productId: C4 })], 0],
		['an individual purchase', [purchase({ id: 'i', productId: C5 })], 0],
	])('%s counts %i existing seats', async (_, purchases, seats) => {
		const { facts } = await run(
			{ ...buyer, purchases },
			{
				...ask,
				orderKind: 'team',
			},
		)
		expect(facts.facts.existingSeats).toMatchObject({ value: seats })
	})

	it('holds seat counts it cannot read', async () => {
		const { facts } = await run({
			...buyer,
			purchases: [bulk('a', { bulkSeats: null })],
		})
		expect(facts.facts.existingSeats).toEqual({ gap: 'PaymentAmbiguous' })
	})

	it('holds credit use once the buyer already owns the product, until a redemption ledger exists', async () => {
		const owns = await run({
			...buyer,
			purchases: [purchase({ id: 'mine', productId: C5 })],
		})
		expect(owns.facts.facts.creditUse).toEqual({ gap: 'FactsUnavailable' })
		const seat = await run({
			...buyer,
			purchases: [
				purchase({ id: 'seat', productId: C5, redeemedBulkCouponId: 'bulk' }),
			],
		})
		expect(seat.facts.facts.creditUse).toMatchObject({ value: 'available' })
	})
})

describe('through the front-desk facade', () => {
	const key = 'synthetic-test-key'
	const handlerFor = (data: SyntheticDb) => {
		const { layer } = synthetic(data)
		return createFrontDeskHandler(
			{
				customerByEmail: async () => null,
				purchasesForUser: async () => [],
				chargeState: async () => null,
				pricingFacts: (request): Promise<PricingFacts | null> =>
					Effect.runPromise(
						buyerPricingFacts(request).pipe(Effect.provide(layer)),
					),
			},
			{ apiKey: key },
		)
	}
	const read = async (data: SyntheticDb, payload: PricingRequest) => {
		const response = await handlerFor(data).POST(
			new Request('http://localhost/api/front-desk/rpc', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({
					_tag: 'Request',
					id: '1',
					tag: 'pricingFacts',
					payload,
					headers: [],
				}),
			}),
		)
		const messages = (await response.json()) as any[]
		return messages.find((m) => m._tag === 'Exit').exit
	}

	it('the facade decodes the facts as the structural BuyerFacts and returns them unchanged', async () => {
		const data = {
			...buyer,
			purchases: [
				purchase({ id: 'cc' }),
				purchase({
					id: 'b',
					productId: C5,
					bulkCouponId: 'bulk',
					bulkSeats: 4,
				}),
			],
			charges: Object.fromEntries([charge('cc')]),
		}
		const exit = await read(data, ask)
		expect(exit._tag).toBe('Success')
		expect(exit.value).toEqual((await run(data)).facts)
		expect(exit.value.facts).toMatchObject({
			credit: { value: { paid: 25_000, source: 'cc' } },
			existingSeats: { value: 4 },
		})
	})

	it('answers PRODUCT_NOT_SUPPORTED for a product with no facts', async () => {
		const exit = await read(buyer, { ...ask, productId: CC })
		expect(exit._tag).toBe('Failure')
		expect(JSON.stringify(exit)).toContain('PRODUCT_NOT_SUPPORTED')
	})
})
