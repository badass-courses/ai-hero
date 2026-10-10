import { z } from 'zod'

/**
 * Where a team invoice gets its price. The form never sends one: the server
 * asks a `TeamPriceSource` and invoices only a `priced` answer.
 *
 * Two adapters sit behind the port:
 *
 * - `appBulkPriceSource`: the app's own bulk rules, the same
 *   `formatPricesForProduct` checkout runs, so an invoice costs what the
 *   team card says. Its discount is the existing bulk Stripe coupon.
 * - `frontDeskPriceSource`: front-desk's private pricing engine, over an
 *   authenticated server-to-server request. Its rules and percentages live in
 *   front-desk, never in this public repo.
 *
 * `teamPriceSourceFor` routes a product to one of them. A product routed to
 * front-desk with no configured client is unavailable, which keeps its
 * invoicing off until the token exists.
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
			source: 'app-bulk' | 'front-desk'
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

/** Products whose team prices come from front-desk, not the app's rules. */
export const FRONT_DESK_PRICED_PRODUCTS: ReadonlySet<string> = new Set([
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
		frontDesk: TeamPriceSource | null
	},
): TeamPriceSource {
	if (!FRONT_DESK_PRICED_PRODUCTS.has(productId)) return sources.appBulk
	return sources.frontDesk ?? disabledPriceSource('front-desk-not-configured')
}

/** Whether a product can be invoiced at all with this configuration. */
export function teamInvoicingEnabled(
	productId: string,
	frontDeskConfigured: boolean,
): boolean {
	return !FRONT_DESK_PRICED_PRODUCTS.has(productId) || frontDeskConfigured
}

const cents = z.number().int().nonnegative()

/** front-desk's `POST /api/pricing/decision` answer. Cents throughout. */
export const frontDeskDecisionSchema = z.object({
	kind: z.string(),
	unitAmount: cents.optional(),
	amount: cents.optional(),
	policy: z.string().optional(),
	reasons: z.array(z.unknown()).optional(),
})

export type FrontDeskDecision = z.infer<typeof frontDeskDecisionSchema>

export const FRONT_DESK_TIMEOUT_MS = 5_000

/**
 * front-desk's pricing engine. Accepts only `kind: "priced"` with a total the
 * list price can reach by discount; anything else, a non-2xx answer, a
 * malformed body or a timeout is unavailable.
 */
export function frontDeskPriceSource(options: {
	url: string
	token: string
	fetch?: typeof fetch
	timeoutMs?: number
}): TeamPriceSource {
	const doFetch = options.fetch ?? fetch
	const endpoint = new URL('/api/pricing/decision', options.url).toString()
	return {
		async price(request) {
			let decision: FrontDeskDecision
			try {
				const response = await doFetch(endpoint, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${options.token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						productId: request.productId,
						quantity: request.quantity,
						orderKind: 'team',
						existingSeats: request.existingSeats,
					}),
					signal: AbortSignal.timeout(
						options.timeoutMs ?? FRONT_DESK_TIMEOUT_MS,
					),
					cache: 'no-store',
				})
				if (!response.ok) return unavailable(`front-desk-http-${response.status}`)
				const parsed = frontDeskDecisionSchema.safeParse(await response.json())
				if (!parsed.success) return unavailable('front-desk-malformed')
				decision = parsed.data
			} catch {
				return unavailable('front-desk-unreachable')
			}

			if (decision.kind !== 'priced') {
				return unavailable(`front-desk-${decision.kind}`)
			}
			const { unitAmount, amount, policy } = decision
			if (unitAmount === undefined || amount === undefined || !policy) {
				return unavailable('front-desk-incomplete')
			}
			const listTotal = request.listUnitAmount * request.quantity
			// An invoice can only discount the product's price, never raise it,
			// and a free team order is not an invoice.
			if (amount <= 0 || amount > listTotal) {
				return unavailable('front-desk-out-of-range')
			}
			const amountOff = listTotal - amount
			return {
				kind: 'priced',
				source: 'front-desk',
				unitAmount,
				amount,
				policy,
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
	appliedMerchantCoupon?: { id: string; percentageDiscount?: unknown } | null
}

/**
 * The app's bulk rules: checkout's own pricing for this quantity, with no
 * site coupon, no PPP and no upgrade credit, then the bulk merchant coupon's
 * Stripe id as the discount. Prices are in dollars on the way in.
 */
export function appBulkPriceSource(deps: {
	formatPrice: (request: TeamPriceRequest) => Promise<AppFormattedPrice>
	stripeCouponIdFor: (merchantCouponId: string) => Promise<string | null>
}): TeamPriceSource {
	return {
		async price(request) {
			let formatted: AppFormattedPrice
			try {
				formatted = await deps.formatPrice(request)
			} catch {
				return unavailable('app-price-error')
			}
			if (formatted.quantity !== request.quantity) {
				return unavailable('app-quantity-mismatch')
			}
			if (Number(formatted.fixedDiscountForUpgrade ?? 0) > 0) {
				return unavailable('app-upgrade-credit')
			}
			const amount = Math.round(Number(formatted.calculatedPrice) * 100)
			const listTotal = request.listUnitAmount * request.quantity
			if (!Number.isFinite(amount) || amount <= 0 || amount > listTotal) {
				return unavailable('app-out-of-range')
			}

			const type = formatted.appliedDiscountType ?? 'none'
			if (type === 'none' || !formatted.appliedMerchantCoupon) {
				if (amount !== listTotal) return unavailable('app-unexplained-discount')
				return {
					kind: 'priced',
					source: 'app-bulk',
					unitAmount: request.listUnitAmount,
					amount,
					policy: 'app-bulk:list',
					discount: { kind: 'none' },
				}
			}
			// Only the bulk ladder belongs on a team invoice. A sale, PPP or
			// special coupon is a checkout decision, not a team rule.
			if (type !== 'bulk') return unavailable(`app-discount-${type}`)

			const stripeCouponId = await deps
				.stripeCouponIdFor(formatted.appliedMerchantCoupon.id)
				.catch(() => null)
			if (!stripeCouponId) return unavailable('app-bulk-coupon-missing')

			const percent = Math.round(
				Number(formatted.appliedMerchantCoupon.percentageDiscount ?? 0) * 100,
			)
			return {
				kind: 'priced',
				source: 'app-bulk',
				unitAmount: Math.round(amount / request.quantity),
				amount,
				policy: `app-bulk:${percent}`,
				discount: { kind: 'stripe-coupon', stripeCouponId },
			}
		},
	}
}
