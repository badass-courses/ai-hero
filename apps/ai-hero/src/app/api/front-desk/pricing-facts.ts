import type {
	FactGap,
	PricingBuyerFacts,
	PricingFact,
	PricingFacts,
	PricingRequest,
} from '@ai-hero/front-desk-support'
import { Context, Data, Effect, Either } from 'effect'

/**
 * Buyer facts for front-desk's pricing. Read-only: SELECTs and Stripe
 * retrieve and list calls. The pricing rules live in front-desk; this module only
 * reports evidence. A source that cannot answer becomes a fact gap, never an
 * empty history, and every known fact carries sourceRefs.
 */

/** Products this app reports pricing facts for. */
export const FACT_PRODUCTS: ReadonlySet<string> = new Set(['product-s00zs'])
export const CRASH_COURSE_PRODUCT = 'product-ma254'
/** All six paid courses. Workshop ownership is not part of this fact. */
export const LEGEND_PRODUCTS = [
	'product-3vfob',
	'product-9wdta',
	'product-wdhub',
	'product-7t9ek',
	'product-pqkk5',
	'product-ma254',
] as const
export const ALUMNI_PRODUCTS = {
	'product-7t9ek': 'c3',
	'product-pqkk5': 'c4',
} as const
/** MerchantCoupon types that prove a coupon was neither PPP nor bulk. */
export const VERIFIED_COUPON_TYPES: ReadonlySet<string> = new Set(['special'])
/** front-desk's upper bound for the existingSeats fact. */
export const MAX_EXISTING_SEATS = 100_000

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
	/** The purchase's own MerchantSession identifier, when it is a Checkout Session. */
	readonly checkoutSessionId: string | null
	/** Stripe product of the purchase's MerchantCharge, when it maps to this product. */
	readonly stripeProductId: string | null
	/** Whether the purchase carries a saved pricing decision (the credit ledger). */
	readonly hasSavedDecision: boolean
}
/** Settlement evidence for one charge and the Checkout Session that made it. */
export interface PricingSettlement {
	readonly charge: {
		readonly id: string
		readonly amount: number
		readonly currency: string
		readonly paid: boolean
		readonly captured: boolean
		readonly status: string
		readonly amountRefunded: number
		readonly refundCount: number
		readonly disputed: boolean
		readonly paymentIntentId: string | null
	}
	/** Null when Stripe has no such session. */
	readonly session: {
		readonly id: string
		readonly status: string | null
		readonly paymentStatus: string
		readonly paymentIntentId: string | null
		/** False when Stripe has more lines than were read. */
		readonly linesComplete: boolean
		readonly lines: readonly {
			readonly stripeProductId: string | null
			readonly quantity: number | null
			readonly currency: string
			readonly amountTotal: number
			readonly amountTax: number
		}[]
	} | null
}
export interface PricingPriceRow {
	readonly id: string
	readonly unitAmountCents: number
}
/** A PurchaseUserTransfer row the buyer is the source or target of. The
 * source user owned the purchase when the row was made, whatever its state. */
export interface PricingTransferRow {
	readonly id: string
	readonly purchaseId: string
	readonly sourceUserId: string
	readonly targetUserId: string | null
	/** The transferred purchase as it is now. Null when it cannot be read. */
	readonly purchase: Pick<
		PricingPurchaseRow,
		'productId' | 'bulkCouponId' | 'redeemedBulkCouponId' | 'hasSavedDecision'
	> | null
}

export class SourceUnavailable extends Data.TaggedError('SourceUnavailable')<{
	readonly source:
		| 'user'
		| 'purchases'
		| 'transfers'
		| 'coupons'
		| 'price'
		| 'settlement'
		| 'ledger'
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
	/** Every purchase transfer out of or into this user, in any state. */
	readonly transfers: (
		userId: string,
	) => Effect.Effect<readonly PricingTransferRow[], SourceUnavailable>
	/** MerchantCoupon type per coupon id. A missing coupon has no entry; a
	 * missing MerchantCoupon or type is null. */
	readonly couponTypes: (
		couponIds: readonly string[],
	) => Effect.Effect<ReadonlyMap<string, string | null>, SourceUnavailable>
	readonly activePrices: (
		productId: string,
	) => Effect.Effect<readonly PricingPriceRow[], SourceUnavailable>
	/** Null when Stripe has no such charge. */
	readonly settlement: (input: {
		readonly stripeChargeId: string
		readonly checkoutSessionId: string
	}) => Effect.Effect<PricingSettlement | null, SourceUnavailable>
	/**
	 * Every target purchase, any owner or status, whose saved pricing decision
	 * spent this credit. The saved decisions are the credit ledger.
	 */
	readonly creditSpentBy: (
		creditSource: string,
	) => Effect.Effect<readonly string[], SourceUnavailable>
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

/** Current individual ownership, not payment or historical ownership.
 * The source scans only purchases currently held by this exact-email account.
 * Cite exactly the checked manifest, even for a negative result. */
export function legendFact(
	rows: readonly PricingPurchaseRow[],
): PricingBuyerFacts['legend'] {
	const owned = new Set(
		rows
			.filter((row) => CURRENT.has(row.status) && individual(row))
			.map((row) => row.productId),
	)
	return known(
		LEGEND_PRODUCTS.every((productId) => owned.has(productId))
			? 'verified'
			: 'no',
		LEGEND_PRODUCTS.map((productId) => `product:${productId}`),
	)
}

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
	const total = [...seats.values()].reduce<number>(
		(sum, count) => sum + (count ?? 0),
		0,
	)
	if (total > MAX_EXISTING_SEATS) return gap('PaymentAmbiguous')
	return known(
		total,
		bulk.length ? bulk.map((row) => purchaseRef(row.id)) : [scanRef],
	)
}

export const CREDIT_LEDGER_REF = 'ai-hero:c5-decision-ledger'

/** What the saved decisions say about the buyer's one credit. */
export type CreditLedger =
	/** No known credit to look up. */
	| { readonly kind: 'no-credit' }
	| { readonly kind: 'read'; readonly spentBy: readonly string[] }
	| { readonly kind: 'unavailable' }

/**
 * Each paid target purchase saves the decision its checkout charged, and a
 * credit is spent exactly when a saved decision names it. Neither a refund
 * nor a transfer unspends it. A target purchase from before decisions were
 * saved (held, or transferred away) may have spent a credit nobody recorded,
 * so it still holds the fact.
 */
export function creditUseFact(
	rows: readonly PricingPurchaseRow[],
	transfers: readonly PricingTransferRow[],
	userId: string,
	productId: string,
	refs: readonly string[],
	ledger: CreditLedger,
): PricingBuyerFacts['creditUse'] {
	if (ledger.kind === 'unavailable') return gap('FactsUnavailable')
	if (ledger.kind === 'read' && ledger.spentBy.length)
		return known('spent', [
			CREDIT_LEDGER_REF,
			...ledger.spentBy.map((id) => `${purchaseRef(id)}#decision`),
		])
	const unrecordedHeld = rows.some(
		(row) =>
			row.productId === productId && individual(row) && !row.hasSavedDecision,
	)
	const unrecordedTransferredAway = transfers.some(
		(transfer) =>
			transfer.sourceUserId === userId &&
			(!transfer.purchase ||
				(transfer.purchase.productId === productId &&
					!transfer.purchase.bulkCouponId &&
					!transfer.purchase.redeemedBulkCouponId &&
					!transfer.purchase.hasSavedDecision)),
	)
	return unrecordedHeld || unrecordedTransferredAway
		? gap('FactsUnavailable')
		: known('available', [...refs, CREDIT_LEDGER_REF])
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

const ambiguous: CreditCandidate = { kind: 'unknown', gap: 'PaymentAmbiguous' }

/** DB checks for one Crash Course purchase. Only a survivor needs Stripe. */
export function purchaseCandidate(
	row: PricingPurchaseRow,
	couponType: string | null | undefined,
):
	| CreditCandidate
	| {
			readonly kind: 'charge'
			readonly stripeChargeId: string
			readonly checkoutSessionId: string
	  } {
	if (row.status === 'Restricted') return excluded(row, 'restricted-ppp')
	if (row.status === 'Refunded') return excluded(row, 'refunded')
	if (row.status === 'Banned') return excluded(row, 'banned')
	if (row.status !== 'Valid')
		return { kind: 'unknown', gap: 'PaymentAmbiguous' }
	if (row.bulkCouponId) return excluded(row, 'bulk')
	if (row.redeemedBulkCouponId) return excluded(row, 'redeemed-bulk-seat')
	if (row.couponId) {
		// Never infer PPP from the amount. Only the coupon's own type counts.
		if (couponType === 'ppp') return excluded(row, 'ppp-coupon')
		if (couponType === 'bulk') return excluded(row, 'bulk-coupon')
		// A missing coupon, MerchantCoupon or type proves nothing about origin.
		if (!couponType || !VERIFIED_COUPON_TYPES.has(couponType)) return ambiguous
	}
	if (!row.stripeChargeId)
		return row.totalAmountCents === 0 ? excluded(row, 'zero-paid') : ambiguous
	if (!row.checkoutSessionId || !row.stripeProductId) return ambiguous
	return {
		kind: 'charge',
		stripeChargeId: row.stripeChargeId,
		checkoutSessionId: row.checkoutSessionId,
	}
}

/**
 * The product money a purchase that passed the DB checks actually settled.
 * The charge must be paid, captured and succeeded, and the amount is the one
 * Crash Course line on the purchase's own Checkout Session, less its tax.
 * Never the gross charge, and never the rounded Purchase total.
 */
export function chargeCandidate(
	row: PricingPurchaseRow,
	settlement: Either.Either<PricingSettlement | null, SourceUnavailable>,
): CreditCandidate {
	if (Either.isLeft(settlement))
		return { kind: 'unknown', gap: 'FactsUnavailable' }
	if (!settlement.right) return ambiguous
	const { charge, session } = settlement.right
	if (
		charge.id !== row.stripeChargeId ||
		charge.currency !== 'usd' ||
		charge.disputed
	)
		return ambiguous
	if (charge.amount === 0) return excluded(row, 'zero-paid')
	if (charge.amountRefunded >= charge.amount) return excluded(row, 'refunded')
	// A partial refund leaves no clean paid amount to credit.
	if (charge.amountRefunded > 0 || charge.refundCount > 0) return ambiguous
	if (!charge.paid || !charge.captured || charge.status !== 'succeeded')
		return ambiguous
	if (
		!session ||
		session.id !== row.checkoutSessionId ||
		session.status !== 'complete' ||
		session.paymentStatus !== 'paid' ||
		!charge.paymentIntentId ||
		session.paymentIntentId !== charge.paymentIntentId ||
		!session.linesComplete
	)
		return ambiguous
	const lines = session.lines.filter(
		(line) => line.stripeProductId === row.stripeProductId,
	)
	const [line] = lines
	if (lines.length !== 1 || !line || line.quantity !== 1) return ambiguous
	const paid = line.amountTotal - line.amountTax
	if (
		line.currency !== 'usd' ||
		!Number.isSafeInteger(paid) ||
		paid < 0 ||
		paid > charge.amount
	)
		return ambiguous
	if (paid === 0) return excluded(row, 'zero-paid')
	return {
		kind: 'eligible',
		paid,
		purchaseId: row.id,
		refs: [
			purchaseRef(row.id),
			`stripe:charge:${charge.id}`,
			`stripe:checkout-session:${session.id}#product:${row.stripeProductId}`,
		],
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
	transfers: readonly PricingTransferRow[],
	userId: string,
	scanRef: string,
): Effect.Effect<PricingBuyerFacts['credit'], never, PricingFactsSource> =>
	Effect.gen(function* () {
		const source = yield* PricingFactsSource
		const crashCourse = rows.filter(
			(row) => row.productId === CRASH_COURSE_PRODUCT,
		)
		// A purchase that came from another owner may already have spent its
		// credit there. With no redemption ledger, that is unknowable.
		const cameFromAnotherOwner = (row: PricingPurchaseRow) =>
			transfers.some(
				(transfer) =>
					transfer.purchaseId === row.id && transfer.sourceUserId !== userId,
			)
		if (crashCourse.some(cameFromAnotherOwner)) return gap('FactsUnavailable')
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
				? Effect.either(source.settlement(checked)).pipe(
						Effect.map((settlement) => chargeCandidate(row, settlement)),
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
		// The support read carries no trusted country or consent for PPP.
		// Legend stays unavailable until the exact account's purchases are read.
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
		// An exact-email account match stands for that account. A miss is not a
		// verified new buyer: the person may own history under another address.
		// No alias guessing.
		if (!user.right)
			return result(
				{ userId: null, sourceRefs: ['ai-hero:user:none-for-email'] },
				{
					...pending,
					legend: gap('IdentityUnverified'),
					alumni: gap('IdentityUnverified'),
					credit: gap('IdentityUnverified'),
					creditUse: gap('IdentityUnverified'),
					existingSeats: gap('IdentityUnverified'),
				},
			)
		const userId = user.right.id
		const buyer = { userId, sourceRefs: [`ai-hero:user:${userId}`] }
		const productIds = [...new Set([request.productId, ...LEGEND_PRODUCTS])]
		const rows = yield* Effect.either(source.purchases(userId, productIds))
		if (Either.isLeft(rows)) return result(buyer, unavailable)
		const scanRef = `ai-hero:purchases:user:${userId}`
		const transferRef = `ai-hero:purchase-transfers:user:${userId}`
		// Transfer history decides both credit facts. Without it, neither is known.
		const transfers = yield* Effect.either(source.transfers(userId))
		const ownership = Either.isRight(transfers)
			? yield* Effect.gen(function* () {
					const credit = yield* creditFor(
						rows.right,
						transfers.right,
						userId,
						scanRef,
					)
					const creditSource =
						'value' in credit && credit.value ? credit.value.source : null
					const spent = creditSource
						? yield* Effect.either(source.creditSpentBy(creditSource))
						: null
					const ledger: CreditLedger =
						spent === null
							? { kind: 'no-credit' }
							: Either.isRight(spent)
								? { kind: 'read', spentBy: spent.right }
								: { kind: 'unavailable' }
					return {
						credit,
						creditUse: creditUseFact(
							rows.right,
							transfers.right,
							userId,
							request.productId,
							[scanRef, transferRef],
							ledger,
						),
					}
				})
			: {
					credit: gap<null>('FactsUnavailable'),
					creditUse: gap<'available'>('FactsUnavailable'),
				}
		return result(buyer, {
			...pending,
			legend: legendFact(rows.right),
			alumni: alumniFact(rows.right, scanRef),
			...ownership,
			existingSeats: existingSeatsFact(rows.right, request.productId, scanRef),
		})
	})
