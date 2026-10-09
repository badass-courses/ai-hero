import type {
	ChargeState,
	FactGap,
	PricingBuyerFacts,
	PricingFact,
	PricingFacts,
	PricingRequest,
} from '@ai-hero/front-desk-support'
import { Context, Data, Effect, Either } from 'effect'

/**
 * Buyer facts for front-desk's pricing. Read-only: SELECTs and the existing
 * Stripe charge read. The pricing rules live in front-desk; this module only
 * reports evidence. A source that cannot answer becomes a fact gap, never an
 * empty history, and every known fact carries sourceRefs.
 */

/** Products this app reports pricing facts for. */
export const FACT_PRODUCTS: ReadonlySet<string> = new Set(['product-s00zs'])
export const CRASH_COURSE_PRODUCT = 'product-ma254'
export const ALUMNI_PRODUCTS = {
	'product-7t9ek': 'c3',
	'product-pqkk5': 'c4',
} as const

export interface PricingPurchaseRow {
	readonly id: string
	readonly productId: string
	readonly status: string
	readonly bulkCouponId: string | null
	readonly redeemedBulkCouponId: string | null
	/** maxUses of the bulk coupon this purchase bought, when it bought one. */
	readonly bulkSeats: number | null
	readonly couponId: string | null
	readonly totalAmountCents: number
	/** MerchantCharge identifier, only when it is a Stripe charge id. */
	readonly stripeChargeId: string | null
}
export interface PricingPriceRow {
	readonly id: string
	readonly unitAmountCents: number
}

export class SourceUnavailable extends Data.TaggedError('SourceUnavailable')<{
	readonly source: 'user' | 'purchases' | 'coupons' | 'price' | 'charge'
}> {}
/** No single active price, so no merchant unit to price against. */
export class MerchantPriceUnavailable extends Data.TaggedError(
	'MerchantPriceUnavailable',
)<{ readonly reason: 'SourceUnavailable' | 'NotExactlyOneActivePrice' }> {}

export interface PricingFactsSourceShape {
	readonly userByEmail: (
		email: string,
	) => Effect.Effect<{ readonly id: string } | null, SourceUnavailable>
	readonly purchases: (
		userId: string,
		productIds: readonly string[],
	) => Effect.Effect<readonly PricingPurchaseRow[], SourceUnavailable>
	/** MerchantCoupon type per coupon id. A missing coupon has no entry. */
	readonly couponTypes: (
		couponIds: readonly string[],
	) => Effect.Effect<ReadonlyMap<string, string | null>, SourceUnavailable>
	readonly activePrices: (
		productId: string,
	) => Effect.Effect<readonly PricingPriceRow[], SourceUnavailable>
	readonly chargeState: (
		stripeChargeId: string,
	) => Effect.Effect<ChargeState | null, SourceUnavailable>
}
export class PricingFactsSource extends Context.Tag(
	'ai-hero/front-desk/PricingFactsSource',
)<PricingFactsSource, PricingFactsSourceShape>() {}

const CURRENT = new Set(['Valid', 'Restricted'])
const known = <A>(value: A, sourceRefs: readonly string[]): PricingFact<A> => ({
	value,
	sourceRefs,
})
const gap = <A>(reason: FactGap): PricingFact<A> => ({ gap: reason })
const purchaseRef = (id: string) => `ai-hero:purchase:${id}`
const individual = (row: PricingPurchaseRow) =>
	!row.bulkCouponId && !row.redeemedBulkCouponId

/** C3/C4 purchases that are current and the buyer's own, not a team seat. */
export function alumniFact(
	rows: readonly PricingPurchaseRow[],
	scanRef: string,
): PricingBuyerFacts['alumni'] {
	const qualifying = rows.filter(
		(row) =>
			row.productId in ALUMNI_PRODUCTS &&
			CURRENT.has(row.status) &&
			individual(row),
	)
	const cohorts = new Set(
		qualifying.map(
			(row) => ALUMNI_PRODUCTS[row.productId as keyof typeof ALUMNI_PRODUCTS],
		),
	)
	const value =
		cohorts.size === 2 ? 'both' : ([...cohorts][0] ?? ('none' as const))
	return known(
		value,
		qualifying.length
			? qualifying.map((row) => purchaseRef(row.id))
			: [scanRef],
	)
}

/** Seats already bought for the priced product, counted per bulk coupon. */
export function existingSeatsFact(
	rows: readonly PricingPurchaseRow[],
	productId: string,
	scanRef: string,
): PricingBuyerFacts['existingSeats'] {
	const bulk = rows.filter(
		(row) =>
			row.productId === productId &&
			CURRENT.has(row.status) &&
			row.bulkCouponId,
	)
	const seats = new Map<string, number | null>()
	for (const row of bulk) seats.set(row.bulkCouponId!, row.bulkSeats)
	if ([...seats.values()].some((count) => count === null || count < 0))
		return gap('PaymentAmbiguous')
	return known(
		[...seats.values()].reduce<number>((sum, count) => sum + (count ?? 0), 0),
		bulk.length ? bulk.map((row) => purchaseRef(row.id)) : [scanRef],
	)
}

/** There is no credit redemption ledger yet. An existing individual purchase
 * of this product may already have used a credit, so it holds. */
export function creditUseFact(
	rows: readonly PricingPurchaseRow[],
	productId: string,
	scanRef: string,
): PricingBuyerFacts['creditUse'] {
	return rows.some(
		(row) =>
			row.productId === productId && CURRENT.has(row.status) && individual(row),
	)
		? gap('FactsUnavailable')
		: known('available', [scanRef, 'ai-hero:credit-redemption-ledger:none-yet'])
}

type CreditCandidate =
	| {
			readonly kind: 'eligible'
			readonly paid: number
			readonly purchaseId: string
			readonly refs: readonly string[]
	  }
	| { readonly kind: 'excluded'; readonly ref: string }
	| { readonly kind: 'unknown'; readonly gap: FactGap }

const excluded = (row: PricingPurchaseRow, why: string): CreditCandidate => ({
	kind: 'excluded',
	ref: `${purchaseRef(row.id)}#excluded:${why}`,
})

/** DB checks for one Crash Course purchase. Only a survivor needs Stripe. */
export function purchaseCandidate(
	row: PricingPurchaseRow,
	couponType: string | null | undefined,
):
	| CreditCandidate
	| { readonly kind: 'charge'; readonly stripeChargeId: string } {
	if (row.status === 'Restricted') return excluded(row, 'restricted-ppp')
	if (row.status === 'Refunded') return excluded(row, 'refunded')
	if (row.status === 'Banned') return excluded(row, 'banned')
	if (row.status !== 'Valid')
		return { kind: 'unknown', gap: 'PaymentAmbiguous' }
	if (row.bulkCouponId) return excluded(row, 'bulk')
	if (row.redeemedBulkCouponId) return excluded(row, 'redeemed-bulk-seat')
	if (row.couponId) {
		if (couponType === undefined)
			return { kind: 'unknown', gap: 'PaymentAmbiguous' }
		// Never infer PPP from the amount. Only the coupon's own type counts.
		if (couponType === 'ppp') return excluded(row, 'ppp-coupon')
		if (couponType === 'bulk') return excluded(row, 'bulk-coupon')
	}
	if (!row.stripeChargeId)
		return row.totalAmountCents === 0
			? excluded(row, 'zero-paid')
			: { kind: 'unknown', gap: 'PaymentAmbiguous' }
	return { kind: 'charge', stripeChargeId: row.stripeChargeId }
}

/** The settled Stripe charge behind a purchase that passed the DB checks. */
export function chargeCandidate(
	row: PricingPurchaseRow,
	charge: Either.Either<ChargeState | null, SourceUnavailable>,
): CreditCandidate {
	if (Either.isLeft(charge)) return { kind: 'unknown', gap: 'FactsUnavailable' }
	const state = charge.right
	if (
		!state ||
		state.stripeChargeId !== row.stripeChargeId ||
		state.currency !== 'usd' ||
		state.disputed
	)
		return { kind: 'unknown', gap: 'PaymentAmbiguous' }
	if (state.amount === 0) return excluded(row, 'zero-paid')
	if (state.amountRefunded >= state.amount) return excluded(row, 'refunded')
	// A partial refund leaves no clean paid amount to credit.
	if (state.amountRefunded > 0 || state.refundCount > 0)
		return { kind: 'unknown', gap: 'PaymentAmbiguous' }
	// Settled USD product money. Checkout collects no tax, and presentment
	// currency is ignored on purpose.
	return {
		kind: 'eligible',
		paid: state.amount,
		purchaseId: row.id,
		refs: [purchaseRef(row.id), `stripe:charge:${state.stripeChargeId}`],
	}
}

/** One highest credit. Any unresolved candidate holds the whole fact. */
export function creditFact(
	candidates: readonly CreditCandidate[],
	scanRef: string,
): PricingBuyerFacts['credit'] {
	const unknown = candidates.find((candidate) => candidate.kind === 'unknown')
	if (unknown?.kind === 'unknown') return gap(unknown.gap)
	let best: Extract<CreditCandidate, { kind: 'eligible' }> | undefined
	for (const candidate of candidates)
		if (candidate.kind === 'eligible' && candidate.paid > (best?.paid ?? 0))
			best = candidate
	const refs = candidates.flatMap((candidate) =>
		candidate.kind === 'excluded'
			? [candidate.ref]
			: candidate === best
				? candidate.refs
				: [],
	)
	return known(
		best ? { paid: best.paid, source: best.purchaseId } : null,
		refs.length ? refs : [scanRef],
	)
}

const creditFor = (
	rows: readonly PricingPurchaseRow[],
	scanRef: string,
): Effect.Effect<PricingBuyerFacts['credit'], never, PricingFactsSource> =>
	Effect.gen(function* () {
		const source = yield* PricingFactsSource
		const crashCourse = rows.filter(
			(row) => row.productId === CRASH_COURSE_PRODUCT,
		)
		const couponIds = [
			...new Set(crashCourse.flatMap((row) => row.couponId ?? [])),
		]
		const types = couponIds.length
			? yield* Effect.either(source.couponTypes(couponIds))
			: Either.right(new Map<string, string | null>())
		if (Either.isLeft(types)) return gap('FactsUnavailable')
		const candidates = yield* Effect.forEach(crashCourse, (row) => {
			const checked = purchaseCandidate(
				row,
				row.couponId ? types.right.get(row.couponId) : null,
			)
			return checked.kind === 'charge'
				? Effect.either(source.chargeState(checked.stripeChargeId)).pipe(
						Effect.map((charge) => chargeCandidate(row, charge)),
					)
				: Effect.succeed(checked)
		})
		return creditFact(candidates, scanRef)
	})

const merchantUnitFor = (productId: string) =>
	Effect.gen(function* () {
		const source = yield* PricingFactsSource
		const prices = yield* source
			.activePrices(productId)
			.pipe(
				Effect.mapError(
					() => new MerchantPriceUnavailable({ reason: 'SourceUnavailable' }),
				),
			)
		const [price] = prices
		if (prices.length !== 1 || !price)
			return yield* new MerchantPriceUnavailable({
				reason: 'NotExactlyOneActivePrice',
			})
		return {
			merchantPriceId: price.id,
			merchantUnit: price.unitAmountCents,
			sourceRefs: [`ai-hero:price:${price.id}`],
		}
	})

/** Null for a product this app reports no pricing facts for. */
export const buyerPricingFacts = (
	request: PricingRequest,
): Effect.Effect<
	PricingFacts | null,
	MerchantPriceUnavailable,
	PricingFactsSource
> =>
	Effect.gen(function* () {
		if (!FACT_PRODUCTS.has(request.productId)) return null
		const source = yield* PricingFactsSource
		const merchant = yield* merchantUnitFor(request.productId)
		// No reviewed legend list exists, and the support read carries no
		// trusted country or consent, so both stay gaps.
		const pending = {
			order: known(request.orderKind, ['request:orderKind']),
			legend: gap<'no' | 'verified'>('FactsUnavailable'),
			ppp: gap<{ accepted: boolean; percent: number } | null>(
				'FactsUnavailable',
			),
		}
		const unavailable = {
			...pending,
			alumni: gap<'none'>('FactsUnavailable'),
			credit: gap<null>('FactsUnavailable'),
			creditUse: gap<'available'>('FactsUnavailable'),
			existingSeats: gap<number>('FactsUnavailable'),
		}
		const result = (
			buyer: PricingFacts['buyer'],
			facts: PricingBuyerFacts,
		): PricingFacts => ({
			product: { appProductId: request.productId, ...merchant },
			buyer,
			quantity: request.quantity,
			facts,
		})

		const user = yield* Effect.either(source.userByEmail(request.email))
		if (Either.isLeft(user))
			return result({ userId: null, sourceRefs: [] }, unavailable)
		if (!user.right) {
			const none = ['ai-hero:user:none-for-email']
			return result(
				{ userId: null, sourceRefs: none },
				{
					...pending,
					alumni: known('none', none),
					credit: known(null, none),
					creditUse: known('available', none),
					existingSeats: known(0, none),
				},
			)
		}
		const userId = user.right.id
		const buyer = { userId, sourceRefs: [`ai-hero:user:${userId}`] }
		const productIds = [
			request.productId,
			CRASH_COURSE_PRODUCT,
			...Object.keys(ALUMNI_PRODUCTS),
		]
		const rows = yield* Effect.either(source.purchases(userId, productIds))
		if (Either.isLeft(rows)) return result(buyer, unavailable)
		const scanRef = `ai-hero:purchases:user:${userId}`
		return result(buyer, {
			...pending,
			alumni: alumniFact(rows.right, scanRef),
			credit: yield* creditFor(rows.right, scanRef),
			creditUse: creditUseFact(rows.right, request.productId, scanRef),
			existingSeats: existingSeatsFact(rows.right, request.productId, scanRef),
		})
	})
