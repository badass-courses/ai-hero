import type {
	BindingQuoteData,
	BuyerFactsData,
	PriceRequestData,
	PricingResultData,
} from '@ai-hero/front-desk-support/pricing'

/**
 * Where a team invoice gets its price. The form never sends one: the server
 * asks a `TeamPriceSource` and invoices only a `priced` answer.
 *
 * Two adapters sit behind the port:
 *
 * - `appBulkPriceSource`: the app's own rules, the same
 *   `formatPricesForProduct` checkout runs with the same default sale coupon,
 *   so an invoice never costs more than checkout or the team card. One
 *   discount: the better of the sale and the bulk ladder. For a product the
 *   authoritative-price hook prices, that is the hook's own decision.
 * - `enginePriceSource`: front-desk's pricing engine, run in-process from the
 *   vendored build, with the policy and binding quotes front-desk serves as
 *   data. The rules ship with the app; the policy arrives at runtime, so a
 *   date or percent change needs no deploy.
 *
 * `teamPriceSourceFor` routes a product to one of them. A product routed to
 * the engine with no configured policy source is unavailable, which keeps its
 * invoicing off until front-desk is configured.
 *
 * An engine-priced product needs no separate cap: checkout prices it with
 * the same engine, policy and quotes, so the engine's team price is the
 * price checkout charges. Capping it with the hook's display decision would
 * be wrong: with no signed-in buyer that decision is only an upper bound, so
 * a billing email with no account could never be invoiced.
 */

export type TeamPriceRequest = {
	productId: string
	quantity: number
	/** Bulk seats this billing email already bought for the product. */
	existingSeats: number
	/** Retail per-seat price in cents, from the product's Stripe price. */
	listUnitAmount: number
	/** The buyer's app user, when the billing email already has one. */
	userId?: string
	/** The billing email, for binding quotes made to it. */
	email?: string
}

/** How the invoice reaches the priced total from list price × quantity. */
export type TeamDiscount =
	| { kind: 'none' }
	/** An existing Stripe coupon, e.g. the bulk merchant coupon checkout uses. */
	| { kind: 'stripe-coupon'; stripeCouponId: string }
	/** A one-time amount off, for a price no existing coupon expresses. */
	| { kind: 'amount-off'; amountOff: number }

export type TeamPrice =
	| {
			kind: 'priced'
			source: 'app-bulk' | 'engine'
			/** Per-seat price after the team discount, in cents. */
			unitAmount: number
			/** The invoice total, in cents. */
			amount: number
			/** Names the rule that priced it. Goes into invoice metadata. */
			policy: string
			discount: TeamDiscount
	  }
	| { kind: 'unavailable'; reason: string }

export interface TeamPriceSource {
	price(request: TeamPriceRequest): Promise<TeamPrice>
}

const unavailable = (reason: string): TeamPrice => ({
	kind: 'unavailable',
	reason,
})

/** Products whose team prices come from the engine, not the app's rules. */
export const ENGINE_PRICED_PRODUCTS: ReadonlySet<string> = new Set([
	'product-s00zs',
])

/** A source that never prices: the fail-closed default. */
export const disabledPriceSource = (reason: string): TeamPriceSource => ({
	price: async () => unavailable(reason),
})

export function teamPriceSourceFor(
	productId: string,
	sources: {
		appBulk: TeamPriceSource
		/** Null until `FRONT_DESK_URL` and `FRONT_DESK_PRICING_TOKEN` are set. */
		engine: TeamPriceSource | null
	},
): TeamPriceSource {
	if (!ENGINE_PRICED_PRODUCTS.has(productId)) return sources.appBulk
	return sources.engine ?? disabledPriceSource('engine-not-configured')
}

/**
 * A price source that never beats checkout upward. The buyer can always pay
 * by card at checkout's price, so an invoice above it is a mistake, not a
 * policy. When checkout's price is not knowable, neither is the cap.
 */
export function cappedAtCheckout(
	source: TeamPriceSource,
	checkout: TeamPriceSource,
): TeamPriceSource {
	return {
		async price(request) {
			const [price, ceiling] = await Promise.all([
				source.price(request),
				checkout.price(request),
			])
			if (price.kind !== 'priced') return price
			if (ceiling.kind !== 'priced') {
				return unavailable(`checkout-cap-${ceiling.reason}`)
			}
			return price.amount > ceiling.amount
				? unavailable('above-checkout')
				: price
		},
	}
}

/** Whether a product can be invoiced at all with this configuration. */
export function teamInvoicingEnabled(
	productId: string,
	engineConfigured: boolean,
): boolean {
	return !ENGINE_PRICED_PRODUCTS.has(productId) || engineConfigured
}

type Read<A> = { ok: true; value: A } | { ok: false; reason: string }

/**
 * The engine's team price for one order. A team order uses only its seats:
 * new plus `existingSeats` the billing email already bought, so every
 * individual fact is a gap the engine ignores. A billing email's binding
 * quotes are read fresh, because an invoice is a charge; without them the
 * invoice is unavailable rather than priced at the formula.
 *
 * Accepts only `priced`, an amount the list price reaches by discount, and a
 * per-seat price that multiplies out to the total. The product's kill switch
 * closes invoices as it closes checkout.
 */
export function enginePriceSource(deps: {
	policy: (
		productId: string,
	) => Promise<
		Read<{ version: string; policy: PriceRequestData['product']['policy'] }>
	>
	quotes: (input: {
		email: string
		productId: string
		quantity: number
		fresh: boolean
	}) => Promise<Read<readonly BindingQuoteData[]>>
	price: (request: PriceRequestData) => {
		ok: boolean
		value?: PricingResultData
	}
	now: () => Date
	/** The C5 switch checkout obeys; true when it cannot tell. */
	disabled: () => boolean | Promise<boolean>
}): TeamPriceSource {
	return {
		async price(request) {
			if (await deps.disabled()) return unavailable('engine-disabled')
			const policy = await deps.policy(request.productId)
			if (!policy.ok) return unavailable('engine-policy-unavailable')
			let quotes: readonly BindingQuoteData[] = []
			if (request.email) {
				const read = await deps.quotes({
					email: request.email,
					productId: request.productId,
					quantity: request.quantity,
					fresh: true,
				})
				if (!read.ok) return unavailable('engine-quotes-unavailable')
				quotes = read.value
			}
			const gap = { gap: 'FactsUnavailable' } as const
			const facts: BuyerFactsData = {
				order: { value: 'team', sourceRefs: ['team-invoice:order'] },
				existingSeats: {
					value: request.existingSeats,
					sourceRefs: ['team-invoice:existing-seats'],
				},
				alumni: gap,
				credit: gap,
				creditUse: gap,
				legend: gap,
				ppp: { value: null, sourceRefs: ['ppp:team-order'] },
			}
			const result = deps.price({
				facts,
				now: deps.now().toISOString(),
				product: {
					id: policy.value.policy.product,
					merchantUnit: request.listUnitAmount,
					policy: policy.value.policy,
				},
				quantity: request.quantity,
				quotes,
			})
			if (!result.ok || !result.value) return unavailable('engine-invalid')
			const decision = result.value
			if (decision.kind !== 'priced')
				return unavailable(`engine-${decision.kind}`)
			const amount = decision.amount
			const listTotal = request.listUnitAmount * request.quantity
			// An invoice can only discount the product's price, never raise it,
			// and a free team order is not an invoice.
			if (amount <= 0 || amount > listTotal)
				return unavailable('engine-out-of-range')
			// A band or Unit-quote price is per seat and must multiply out; a
			// Total quote prices the order only.
			if (
				decision.unitAmount !== null &&
				decision.unitAmount * request.quantity !== amount
			)
				return unavailable('engine-inconsistent')
			const unitAmount =
				decision.unitAmount ?? Math.round(amount / request.quantity)
			const amountOff = listTotal - amount
			return {
				kind: 'priced',
				source: 'engine',
				unitAmount,
				amount,
				policy: `${decision.policyVersion}:${decision.rule}`,
				discount:
					amountOff > 0 ? { kind: 'amount-off', amountOff } : { kind: 'none' },
			}
		},
	}
}

/** The slice of `formatPricesForProduct`'s answer the app adapter reads. */
export type AppFormattedPrice = {
	quantity: number
	unitPrice: number
	fullPrice: number
	calculatedPrice: number
	fixedDiscountForUpgrade?: number
	appliedDiscountType?: string
	appliedMerchantCoupon?: {
		id: string
		percentageDiscount?: unknown
		amountDiscount?: unknown
	} | null
	/** Present when the authoritative-price hook priced the product. */
	authoritative?: {
		kind: string
		purchasable: boolean
		amountCents: number
		policyVersion: string
	}
}

/** The site-wide sale coupon checkout applies on its own, when one runs. */
export type DefaultSaleCoupon = {
	merchantCouponId: string
	/** The app coupon, passed to pricing as checkout passes it. */
	couponId?: string
	/** The Stripe coupon behind it, used as is for a percentage sale. */
	stripeCouponId: string
	/** 0 to 1. */
	percentageDiscount?: number | null
	/** Per seat, in cents. */
	amountDiscount?: number | null
}

type AppCandidate = {
	amount: number
	policy: string
	discount: TeamDiscount
}

/**
 * The app's rules: checkout's own pricing for this quantity and buyer, with
 * the default sale coupon checkout applies and no PPP or upgrade credit.
 *
 * Checkout keeps the bulk ladder whenever it gives any discount, even when a
 * bigger sale is running. A team invoice takes the better of the two instead,
 * so it never costs more than checkout or the team card. Exactly one
 * discount applies; they never stack. Prices are in dollars on the way in.
 */
export function appBulkPriceSource(deps: {
	formatPrice: (
		request: TeamPriceRequest,
		saleCoupon: DefaultSaleCoupon | null,
	) => Promise<AppFormattedPrice>
	stripeCouponIdFor: (merchantCouponId: string) => Promise<string | null>
	defaultSaleCoupon: (productId: string) => Promise<DefaultSaleCoupon | null>
}): TeamPriceSource {
	return {
		async price(request) {
			let formatted: AppFormattedPrice
			let sale: DefaultSaleCoupon | null
			try {
				sale = await deps.defaultSaleCoupon(request.productId)
				formatted = await deps.formatPrice(request, sale)
			} catch {
				return unavailable('app-price-error')
			}
			if (formatted.quantity !== request.quantity) {
				return unavailable('app-quantity-mismatch')
			}
			if (Number(formatted.fixedDiscountForUpgrade ?? 0) > 0) {
				return unavailable('app-upgrade-credit')
			}
			const listTotal = request.listUnitAmount * request.quantity
			// The hook priced it: checkout charges its decision, so that is the
			// price an invoice may not exceed. Only a chargeable one counts.
			if (formatted.authoritative) {
				const { authoritative } = formatted
				if (!authoritative.purchasable)
					return unavailable(`app-authoritative-${authoritative.kind}`)
				const amount = authoritative.amountCents
				if (!(amount > 0 && amount <= listTotal))
					return unavailable('app-out-of-range')
				return {
					kind: 'priced',
					source: 'app-bulk',
					unitAmount: Math.round(amount / request.quantity),
					amount,
					policy: `app-authoritative:${authoritative.policyVersion}`,
					discount:
						amount < listTotal
							? { kind: 'amount-off', amountOff: listTotal - amount }
							: { kind: 'none' },
				}
			}
			const inRange = (amount: number) =>
				Number.isFinite(amount) && amount > 0 && amount <= listTotal

			const checkout = await checkoutCandidate(formatted, sale, listTotal, deps)
			if ('reason' in checkout) return unavailable(checkout.reason)
			if (!inRange(checkout.amount)) return unavailable('app-out-of-range')

			const saleOnly = sale ? saleCandidate(sale, request, listTotal) : null
			const best =
				saleOnly &&
				inRange(saleOnly.amount) &&
				saleOnly.amount < checkout.amount
					? saleOnly
					: checkout
			return {
				kind: 'priced',
				source: 'app-bulk',
				unitAmount: Math.round(best.amount / request.quantity),
				amount: best.amount,
				policy: best.policy,
				discount: best.discount,
			}
		},
	}
}

const percentOf = (value: unknown) => Math.round(Number(value ?? 0) * 100)

/** What checkout charges, as an invoice discount. */
async function checkoutCandidate(
	formatted: AppFormattedPrice,
	sale: DefaultSaleCoupon | null,
	listTotal: number,
	deps: { stripeCouponIdFor: (id: string) => Promise<string | null> },
): Promise<AppCandidate | { reason: string }> {
	const amount = Math.round(Number(formatted.calculatedPrice) * 100)
	const type = formatted.appliedDiscountType ?? 'none'
	const coupon = formatted.appliedMerchantCoupon

	if (type === 'none' || !coupon) {
		if (amount !== listTotal) return { reason: 'app-unexplained-discount' }
		return { amount, policy: 'app-bulk:list', discount: { kind: 'none' } }
	}
	if (type === 'bulk') {
		const stripeCouponId = await deps
			.stripeCouponIdFor(coupon.id)
			.catch(() => null)
		if (!stripeCouponId) return { reason: 'app-bulk-coupon-missing' }
		return {
			amount,
			policy: `app-bulk:${percentOf(coupon.percentageDiscount)}`,
			discount: { kind: 'stripe-coupon', stripeCouponId },
		}
	}
	// The sale coupon is the only other discount a team invoice carries. PPP
	// and special coupons are checkout decisions for one buyer, not team rules.
	if (
		(type === 'percentage' || type === 'fixed') &&
		coupon.id === sale?.merchantCouponId
	) {
		return type === 'percentage'
			? {
					amount,
					policy: `app-sale:${percentOf(coupon.percentageDiscount)}`,
					discount: {
						kind: 'stripe-coupon',
						stripeCouponId: sale.stripeCouponId,
					},
				}
			: {
					amount,
					policy: 'app-sale:fixed',
					discount: { kind: 'amount-off', amountOff: listTotal - amount },
				}
	}
	return { reason: `app-discount-${type}` }
}

/** The sale alone, priced the way checkout prices a coupon. */
function saleCandidate(
	sale: DefaultSaleCoupon,
	request: TeamPriceRequest,
	listTotal: number,
): AppCandidate | null {
	const perSeatOff = Number(sale.amountDiscount ?? 0)
	if (perSeatOff > 0) {
		// A fixed sale is per seat in the app; a Stripe amount-off coupon is per
		// invoice. So the invoice carries the seat total as a one-off amount.
		const amountOff = Math.round(perSeatOff) * request.quantity
		return {
			amount: listTotal - amountOff,
			policy: 'app-sale:fixed',
			discount: { kind: 'amount-off', amountOff },
		}
	}
	const percent = Number(sale.percentageDiscount ?? 0)
	if (percent > 0 && percent < 1) {
		return {
			amount: Math.round(listTotal * (1 - percent)),
			policy: `app-sale:${percentOf(percent)}`,
			discount: { kind: 'stripe-coupon', stripeCouponId: sale.stripeCouponId },
		}
	}
	return null
}
