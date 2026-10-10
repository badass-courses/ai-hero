import {
	createFrontDeskHandler,
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
	type PricingSettlement,
} from './pricing-facts'

// Synthetic database: plain rows behind the same source port the live layer
// fills from MySQL and Stripe. No real customer, provider or DB data.
const C5 = 'product-s00zs'
const CC = 'product-ma254'
const C3 = 'product-7t9ek'
const C4 = 'product-pqkk5'
const legendProducts = [
	'product-3vfob',
	'product-9wdta',
	'product-wdhub',
	C3,
	C4,
	CC,
]
const legendRefs = legendProducts.map((id) => `product:${id}`)

/** A PurchaseUserTransfer row; `completed` when the target accepted it. */
interface SyntheticTransfer {
	purchaseId: string
	sourceUserId: string
	targetUserId: string | null
	completed?: boolean
}
type SyntheticPurchase = PricingPurchaseRow & {
	userId?: string
	createdAt?: Date
}
interface SyntheticDb {
	users?: Record<string, string>
	purchases?: SyntheticPurchase[]
	coupons?: Record<string, string | null>
	prices?: { id: string; unitAmountCents: number }[]
	settlements?: Record<string, PricingSettlement>
	transfers?: SyntheticTransfer[]
	/** Defaults to `cutover`; null leaves it unconfigured. */
	cutover?: Date | null
	/** Saved decisions by credit source: the purchases that spent it. */
	ledger?: Record<string, string[]>
	down?: SourceUnavailable['source'][]
}
type Session = NonNullable<PricingSettlement['session']>
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
	checkoutSessionId: `cs_${over.id}`,
	stripeProductId: 'prod_cc',
	...over,
})
// Target purchases default to after the cutover; `before` places one earlier.
const cutover = new Date('2030-01-01T00:00:00Z')
const before = new Date('2029-12-31T23:59:59Z')
const after = new Date('2030-01-01T00:00:00Z')
/** A settled charge whose own session has one Crash Course line. */
const charge = (
	id: string,
	over: Partial<PricingSettlement['charge']> & {
		session?: Partial<Session> | null
		line?: Partial<Session['lines'][number]>
	} = {},
): [string, PricingSettlement] => {
	const { session, line, ...charged } = over
	return [
		`ch_${id}`,
		{
			charge: {
				id: `ch_${id}`,
				amount: 25_000,
				currency: 'usd',
				paid: true,
				captured: true,
				status: 'succeeded',
				amountRefunded: 0,
				refundCount: 0,
				disputed: false,
				paymentIntentId: `pi_${id}`,
				...charged,
			},
			session:
				session === null
					? null
					: {
							id: `cs_${id}`,
							status: 'complete',
							paymentStatus: 'paid',
							paymentIntentId: `pi_${id}`,
							linesComplete: true,
							lines: [
								{
									stripeProductId: 'prod_cc',
									quantity: 1,
									currency: 'usd',
									amountTotal: charged.amount ?? 25_000,
									amountTax: 0,
									...line,
								},
							],
							...session,
						},
		},
	]
}
const email = 'buyer@example.test'
const ask: PricingRequest = {
	email,
	productId: C5,
	quantity: 1,
	orderKind: 'individual',
}

function synthetic(data: SyntheticDb) {
	const stripeReads: string[] = []
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
						(data.purchases ?? []).filter(
							(row) =>
								(row.userId ?? 'user-test') === userId &&
								productIds.includes(row.productId),
						),
					),
		creditChain: ({ creditSource, productId }) => {
			if (down('transfers')) return fail('transfers')
			const all = data.purchases ?? []
			const ownerOf = (id: string) =>
				all.find((row) => row.id === id)?.userId ?? 'user-test'
			const moves = (data.transfers ?? []).filter(
				(row) => row.purchaseId === creditSource,
			)
			const holders = [
				...new Set([
					ownerOf(creditSource),
					...moves.flatMap((row) => [
						row.sourceUserId,
						...(row.completed && row.targetUserId ? [row.targetUserId] : []),
					]),
				]),
			]
			const held = all.filter(
				(row) =>
					holders.includes(row.userId ?? 'user-test') &&
					row.productId === productId,
			)
			const movedAway = (data.transfers ?? [])
				.filter((row) => holders.includes(row.sourceUserId))
				.map((row) => all.find((purchase) => purchase.id === row.purchaseId))
			if (movedAway.some((row) => !row)) return fail('transfers')
			const targets = new Map(
				[...held, ...movedAway]
					.filter((row) => row!.productId === productId)
					.map((row) => [
						row!.id,
						{
							id: row!.id,
							createdAt: row!.createdAt ?? after,
							bulkCouponId: row!.bulkCouponId,
							redeemedBulkCouponId: row!.redeemedBulkCouponId,
						},
					]),
			)
			return Effect.succeed({ holders, targets: [...targets.values()] })
		},
		decisionCutover: data.cutover === undefined ? cutover : data.cutover,
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
		settlement: ({ stripeChargeId }) => {
			stripeReads.push(stripeChargeId)
			return down('settlement')
				? fail('settlement')
				: Effect.succeed(data.settlements?.[stripeChargeId] ?? null)
		},
		creditSpentBy: (creditSource) =>
			down('ledger')
				? fail('ledger')
				: Effect.succeed(data.ledger?.[creditSource] ?? []),
	})
	return { layer, stripeReads }
}
const run = (data: SyntheticDb, request: PricingRequest = ask) => {
	const { layer, stripeReads } = synthetic(data)
	return Effect.runPromise(
		buyerPricingFacts(request).pipe(Effect.provide(layer)),
	).then((facts) => ({ facts: facts!, stripeReads }))
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

	it('computes legend and keeps PPP as a gap, with the product, quantity and order from the request', async () => {
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
		expect(facts.facts.legend).toEqual({ value: 'no', sourceRefs: legendRefs })
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
			settlements: Object.fromEntries([charge('cc')]),
		})
		for (const fact of Object.values(facts.facts))
			if ('value' in fact) expect(fact.sourceRefs.length).toBeGreaterThan(0)
		expect(JSON.stringify(facts)).not.toContain(email)
	})

	it('an email with no exact account match is IdentityUnverified, not an empty history', async () => {
		const { facts, stripeReads } = await run({
			users: { 'other@example.test': 'user-other' },
			purchases: [purchase({ id: 'cc' })],
		})
		expect(facts.buyer).toEqual({
			userId: null,
			sourceRefs: ['ai-hero:user:none-for-email'],
		})
		for (const field of [
			'legend',
			'alumni',
			'credit',
			'creditUse',
			'existingSeats',
		] as const)
			expect(facts.facts[field]).toEqual({ gap: 'IdentityUnverified' })
		expect(facts.facts.order).toMatchObject({ value: 'individual' })
		expect(stripeReads).toEqual([])
	})

	it.each(['user', 'purchases'] as const)(
		'an unavailable %s source becomes gaps, never an empty history',
		async (source) => {
			const { facts } = await run({ ...buyer, down: [source] })
			for (const field of [
				'legend',
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

describe('legend', () => {
	const all = legendProducts.map((productId, index) =>
		purchase({ id: `legend-${index}`, productId }),
	)
	const legendOf = async (data: SyntheticDb) =>
		(await run({ ...buyer, ...data })).facts.facts.legend

	it('verifies all six individual courses with exactly the manifest refs', async () => {
		expect(await legendOf({ purchases: all })).toEqual({
			value: 'verified',
			sourceRefs: legendRefs,
		})
	})

	it.each(legendProducts)(
		'requires %s, even with workshop ownership and duplicates',
		async (missing) => {
			expect(
				await legendOf({
					purchases: [
						...all.filter((row) => row.productId !== missing),
						purchase({ id: 'workshop', productId: 'product-qocpc' }),
						purchase({ id: 'duplicate', productId: missing === C3 ? C4 : C3 }),
					],
				}),
			).toEqual({ value: 'no', sourceRefs: legendRefs })
		},
	)

	it.each([
		['a redeemed team seat', { redeemedBulkCouponId: 'bulk' }],
		['a bulk purchase', { bulkCouponId: 'bulk', bulkSeats: 5 }],
		['a refunded purchase', { status: 'Refunded' }],
		['a banned purchase', { status: 'Banned' }],
	] as const)('does not count %s', async (_, over) => {
		expect(
			await legendOf({
				purchases: all.map((row, index) =>
					index === 0 ? { ...row, ...over } : row,
				),
			}),
		).toEqual({ value: 'no', sourceRefs: legendRefs })
	})

	it('counts Restricted and free ownership without settlement evidence', async () => {
		const { facts, stripeReads } = await run({
			...buyer,
			purchases: all.map((row) => ({
				...row,
				status: 'Restricted',
				totalAmountCents: 0,
				stripeChargeId: null,
			})),
			down: ['settlement', 'coupons', 'transfers'],
		})
		expect(facts.facts.legend).toEqual({
			value: 'verified',
			sourceRefs: legendRefs,
		})
		expect(stripeReads).toEqual([])
	})

	it('does not count a course transferred out, even with its transfer history', async () => {
		expect(
			await legendOf({
				purchases: all.map((row, index) => ({
					...row,
					userId: index === 0 ? 'user-recipient' : 'user-test',
				})),
				transfers: [
					{
						purchaseId: all[0]!.id,
						sourceUserId: 'user-test',
						targetUserId: 'user-recipient',
						completed: true,
					},
				],
			}),
		).toEqual({ value: 'no', sourceRefs: legendRefs })
	})

	it('still counts current ownership with an unaccepted transfer offer', async () => {
		expect(
			await legendOf({
				purchases: all,
				transfers: [
					{
						purchaseId: all[0]!.id,
						sourceUserId: 'user-test',
						targetUserId: null,
					},
				],
			}),
		).toEqual({ value: 'verified', sourceRefs: legendRefs })
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
	it('is the product line on the purchase session less tax, never the gross charge or Purchase total', async () => {
		const [id, settled] = charge('cc', { amount: 30_000 })
		const session = settled.session!
		const withOtherLine: PricingSettlement = {
			...settled,
			session: {
				...session,
				lines: [
					{ ...session.lines[0]!, amountTotal: 27_000, amountTax: 2_000 },
					{
						...session.lines[0]!,
						stripeProductId: 'prod_other',
						amountTotal: 3_000,
					},
				],
			},
		}
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc', totalAmountCents: 26_000 })],
				settlements: { [id]: withOtherLine },
			}),
		).toEqual({
			value: { paid: 25_000, source: 'cc' },
			sourceRefs: [
				'ai-hero:purchase:cc',
				'stripe:charge:ch_cc',
				'stripe:checkout-session:cs_cc#product:prod_cc',
			],
		})
	})

	it('accepts a coupon verified as special', async () => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc', couponId: 'coupon-special' })],
				coupons: { 'coupon-special': 'special' },
				settlements: Object.fromEntries([charge('cc', { amount: 20_000 })]),
			}),
		).toMatchObject({ value: { paid: 20_000, source: 'cc' } })
	})

	it('takes one highest credit, never a sum', async () => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'low' }), purchase({ id: 'high' })],
				settlements: Object.fromEntries([
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
		const { facts, stripeReads } = await run({
			...buyer,
			purchases: [purchase({ id: 'cc', ...over })],
			coupons: { 'coupon-ppp': 'ppp', 'coupon-bulk': 'bulk' },
		})
		expect(facts.facts.credit).toEqual({
			value: null,
			sourceRefs: [`ai-hero:purchase:cc#excluded:${why}`],
		})
		expect(stripeReads).toEqual([])
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
				settlements: Object.fromEntries([charge('cc', over)]),
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
				settlements: Object.fromEntries([
					charge('cc', { amountRefunded: 5_000, refundCount: 1 }),
				]),
			},
			'PaymentAmbiguous',
		],
		[
			'disputed',
			{ settlements: Object.fromEntries([charge('cc', { disputed: true })]) },
			'PaymentAmbiguous',
		],
		[
			'not USD',
			{ settlements: Object.fromEntries([charge('cc', { currency: 'eur' })]) },
			'PaymentAmbiguous',
		],
		['missing at Stripe', { settlements: {} }, 'PaymentAmbiguous'],
		['unreadable at Stripe', { down: ['settlement'] }, 'FactsUnavailable'],
	] as const)('holds a charge that is %s', async (_, data, reason) => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc' })],
				...data,
			} as SyntheticDb),
		).toEqual({ gap: reason })
	})

	it.each([
		['not paid', { paid: false }],
		['not captured', { captured: false }],
		['pending', { status: 'pending' }],
		['failed', { status: 'failed' }],
		['without a payment intent', { paymentIntentId: null }],
		['without its checkout session at Stripe', { session: null }],
		['on an open session', { session: { status: 'open' } }],
		['on an unpaid session', { session: { paymentStatus: 'unpaid' } }],
		['on a different session', { session: { id: 'cs_other' } }],
		[
			'on a session for another payment',
			{ session: { paymentIntentId: 'pi_other' } },
		],
		['with unread session lines', { session: { linesComplete: false } }],
		['with no product line', { line: { stripeProductId: 'prod_other' } }],
		['with no line product', { line: { stripeProductId: null } }],
		['with a quantity other than one', { line: { quantity: 2 } }],
		['with a non-USD line', { line: { currency: 'eur' } }],
		['with a line above the charge', { line: { amountTotal: 30_000 } }],
		[
			'with tax above the line',
			{ line: { amountTotal: 1_000, amountTax: 2_000 } },
		],
		[
			'with two product lines',
			{
				session: {
					lines: [1, 2].map(() => ({
						stripeProductId: 'prod_cc',
						quantity: 1,
						currency: 'usd',
						amountTotal: 10_000,
						amountTax: 0,
					})),
				},
			},
		],
	] as const)('holds a charge %s', async (_, over) => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc' })],
				settlements: Object.fromEntries([charge('cc', over as any)]),
			}),
		).toEqual({ gap: 'PaymentAmbiguous' })
	})

	it('excludes a zero product line', async () => {
		expect(
			await creditOf({
				purchases: [purchase({ id: 'cc' })],
				settlements: Object.fromEntries([
					charge('cc', { line: { amountTotal: 0 } }),
				]),
			}),
		).toEqual({
			value: null,
			sourceRefs: ['ai-hero:purchase:cc#excluded:zero-paid'],
		})
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
		[
			'a coupon with no MerchantCoupon or type',
			purchase({ id: 'cc', couponId: 'coupon-untyped' }),
		],
		[
			'a coupon type it does not recognize',
			purchase({ id: 'cc', couponId: 'coupon-new' }),
		],
		[
			'no checkout session link',
			purchase({ id: 'cc', checkoutSessionId: null }),
		],
		[
			'no Stripe product on its charge',
			purchase({ id: 'cc', stripeProductId: null }),
		],
	])('holds a purchase with %s, without asking Stripe', async (_, row) => {
		const { facts, stripeReads } = await run({
			...buyer,
			purchases: [row],
			coupons: { 'coupon-untyped': null, 'coupon-new': 'mystery' },
			settlements: Object.fromEntries([charge('cc')]),
		})
		expect(facts.facts.credit).toEqual({ gap: 'PaymentAmbiguous' })
		expect(stripeReads).toEqual([])
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
				settlements: Object.fromEntries([
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

	it('holds a seat total above front-desk bounds', async () => {
		const { facts } = await run({
			...buyer,
			purchases: [
				bulk('a', { bulkSeats: 60_000 }),
				bulk('b', { bulkCouponId: 'bulk-b', bulkSeats: 40_001 }),
			],
		})
		expect(facts.facts.existingSeats).toEqual({ gap: 'PaymentAmbiguous' })
		const max = await run({
			...buyer,
			purchases: [bulk('a', { bulkSeats: 100_000 })],
		})
		expect(max.facts.facts.existingSeats).toMatchObject({ value: 100_000 })
	})

	it('holds seat counts it cannot read', async () => {
		const { facts } = await run({
			...buyer,
			purchases: [bulk('a', { bulkSeats: null })],
		})
		expect(facts.facts.existingSeats).toEqual({ gap: 'PaymentAmbiguous' })
	})

	const withCredit = {
		...buyer,
		purchases: [purchase({ id: 'cc' })] as SyntheticPurchase[],
		settlements: Object.fromEntries([charge('cc')]),
	}
	const chainRef = 'ai-hero:purchase-transfers:purchase:cc'
	const c5 = (id: string, over: Partial<SyntheticPurchase> = {}) =>
		purchase({ id, productId: C5, ...over }) as SyntheticPurchase
	const useOf = async (data: SyntheticDb) =>
		(await run({ ...withCredit, ...data })).facts.facts.creditUse

	it('reads credit use from saved decisions after the cutover', async () => {
		const mine = [...withCredit.purchases, c5('mine', { createdAt: after })]
		expect(await useOf({ purchases: mine })).toEqual({
			value: 'available',
			sourceRefs: [chainRef, 'ai-hero:c5-decision-ledger'],
		})
		// Spent by any purchase, whoever owns it now.
		expect(await useOf({ purchases: mine, ledger: { cc: ['c5-elsewhere'] } }))
			.toEqual({
				value: 'spent',
				sourceRefs: [
					'ai-hero:c5-decision-ledger',
					'ai-hero:purchase:c5-elsewhere#decision',
				],
			})
	})

	it.each(['Valid', 'Restricted', 'Refunded', 'Banned', 'Disputed'])(
		'spends the credit beside an individual C5 purchase from before the cutover, even %s',
		async (status) => {
			expect(
				await useOf({
					purchases: [
						...withCredit.purchases,
						c5('old', { status, createdAt: before }),
					],
				}),
			).toEqual({
				value: 'spent',
				sourceRefs: [chainRef, 'ai-hero:purchase:old#before-cutover'],
			})
		},
	)

	it('places a purchase at the cutover instant after it', async () => {
		expect(
			await useOf({
				purchases: [...withCredit.purchases, c5('edge', { createdAt: cutover })],
			}),
		).toMatchObject({ value: 'available' })
	})

	it.each([
		['a team purchase', { bulkCouponId: 'bulk', bulkSeats: 5 }],
		['a redeemed team seat', { redeemedBulkCouponId: 'bulk' }],
	])('ignores %s from before the cutover', async (_, over) => {
		expect(
			await useOf({
				purchases: [
					...withCredit.purchases,
					c5('team', { ...over, createdAt: before }),
				],
			}),
		).toMatchObject({ value: 'available' })
	})

	it('holds credit use when C5 history exists but no cutover is configured', async () => {
		expect(
			await useOf({
				purchases: [...withCredit.purchases, c5('any')],
				cutover: null,
			}),
		).toEqual({ gap: 'FactsUnavailable' })
		expect(await useOf({ cutover: null })).toMatchObject({
			value: 'available',
		})
	})

	it('holds credit use when the decision ledger cannot be read', async () => {
		const { facts } = await run({ ...withCredit, down: ['ledger'] })
		expect(facts.facts.credit).toMatchObject({ value: { source: 'cc' } })
		expect(facts.facts.creditUse).toEqual({ gap: 'FactsUnavailable' })
	})

	it('reports no credit as available, without reading the chain', async () => {
		const { facts } = await run({
			...buyer,
			purchases: [c5('old', { createdAt: before })],
			down: ['transfers'],
		})
		expect(facts.facts.credit).toMatchObject({ value: null })
		expect(facts.facts.creditUse).toEqual({
			value: 'available',
			sourceRefs: [
				'ai-hero:purchases:user:user-test',
				'ai-hero:c5-decision-ledger',
			],
		})
	})
})

describe('transfer chain', () => {
	const withCredit = {
		...buyer,
		purchases: [purchase({ id: 'cc' })] as SyntheticPurchase[],
		settlements: Object.fromEntries([charge('cc')]),
	}
	const c5 = (id: string, userId: string, createdAt = before) =>
		({ ...purchase({ id, productId: C5 }), userId, createdAt }) as SyntheticPurchase
	const factsOf = async (data: SyntheticDb) =>
		(await run({ ...withCredit, ...data })).facts.facts

	it('credits a Crash Course purchase that came from another owner', async () => {
		const { facts, stripeReads } = await run({
			...withCredit,
			transfers: [
				{
					purchaseId: 'cc',
					sourceUserId: 'user-previous',
					targetUserId: 'user-test',
					completed: true,
				},
			],
		})
		expect(facts.facts.credit).toMatchObject({
			value: { paid: 25_000, source: 'cc' },
		})
		expect(facts.facts.creditUse).toMatchObject({ value: 'available' })
		expect(stripeReads).toEqual(['ch_cc'])
	})

	it('spends the credit when an earlier holder held a C5 purchase from before the cutover', async () => {
		const facts = await factsOf({
			purchases: [...withCredit.purchases, c5('theirs', 'user-previous')],
			transfers: [
				{
					purchaseId: 'cc',
					sourceUserId: 'user-previous',
					targetUserId: 'user-test',
					completed: true,
				},
			],
		})
		expect(facts.creditUse).toEqual({
			value: 'spent',
			sourceRefs: [
				'ai-hero:purchase-transfers:purchase:cc',
				'ai-hero:purchase:theirs#before-cutover',
			],
		})
	})

	it('spends the credit when a holder transferred such a C5 purchase away', async () => {
		const facts = await factsOf({
			purchases: [...withCredit.purchases, c5('moved', 'user-recipient')],
			transfers: [
				{
					purchaseId: 'moved',
					sourceUserId: 'user-test',
					targetUserId: 'user-recipient',
					completed: true,
				},
			],
		})
		expect(facts.creditUse).toMatchObject({ value: 'spent' })
	})

	it('leaves the credit available when a later C5 purchase in the chain saved no decision', async () => {
		const facts = await factsOf({
			purchases: [...withCredit.purchases, c5('later', 'user-previous', after)],
			transfers: [
				{
					purchaseId: 'cc',
					sourceUserId: 'user-previous',
					targetUserId: 'user-test',
					completed: true,
				},
			],
		})
		expect(facts.creditUse).toMatchObject({ value: 'available' })
	})

	it('does not count someone who was only offered the Crash Course purchase', async () => {
		const facts = await factsOf({
			purchases: [...withCredit.purchases, c5('offered', 'user-offered')],
			transfers: [
				{ purchaseId: 'cc', sourceUserId: 'user-test', targetUserId: 'user-offered' },
			],
		})
		expect(facts.creditUse).toMatchObject({ value: 'available' })
	})

	it('holds credit use when a transferred purchase in the chain cannot be read', async () => {
		const facts = await factsOf({
			transfers: [
				{ purchaseId: 'gone', sourceUserId: 'user-test', targetUserId: 'x' },
			],
		})
		expect(facts.credit).toMatchObject({ value: { source: 'cc' } })
		expect(facts.creditUse).toEqual({ gap: 'FactsUnavailable' })
	})

	it('holds only credit use when the chain cannot be read', async () => {
		const facts = await factsOf({ down: ['transfers'] })
		expect(facts.credit).toMatchObject({ value: { source: 'cc' } })
		expect(facts.creditUse).toEqual({ gap: 'FactsUnavailable' })
		expect(facts.alumni).toMatchObject({ value: 'none' })
	})

	it('reads the chain only when no saved decision spent the credit', async () => {
		const facts = await factsOf({ ledger: { cc: ['c5'] }, down: ['transfers'] })
		expect(facts.creditUse).toMatchObject({ value: 'spent' })
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
			settlements: Object.fromEntries([charge('cc')]),
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
