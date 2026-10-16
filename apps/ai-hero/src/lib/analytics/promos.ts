import type { AnalyticsRange } from './types'

export const PROMO_KINDS = [
	'seat-or-zero',
	'evergreen',
	'regional',
	'other-coupon',
	'full-price',
	'unclassified',
] as const
export type PromoKind = (typeof PROMO_KINDS)[number]

export type PromoPurchase = {
	status: string
	totalAmount: number | string
	couponId?: string | null
	redeemedBulkCouponId?: string | null
}
export type CouponFacts = {
	/** The purchase coupon resolved to a site coupon. Status/expiry do not rewrite history. */
	siteCouponFound?: boolean
	fields?: Record<string, unknown> | null
	merchantCouponFound?: boolean
	merchantCouponType?: string | null
}

/** Schema status is an open varchar, not an enum. Fail closed on new statuses. */
export function promoKindOf(
	purchase: PromoPurchase,
	facts: CouponFacts,
): PromoKind {
	const amount = Number(purchase.totalAmount)
	const hasCoupon = purchase.couponId != null
	if (amount === 0 || purchase.redeemedBulkCouponId != null)
		return 'seat-or-zero'
	if (
		!Number.isFinite(amount) ||
		amount < 0 ||
		!['Valid', 'Restricted', 'Refunded'].includes(purchase.status)
	)
		return 'unclassified'
	if (
		hasCoupon &&
		facts.siteCouponFound &&
		Object.prototype.hasOwnProperty.call(facts.fields ?? {}, 'evergreenOffer')
	)
		return 'evergreen'
	if (purchase.status === 'Restricted' || facts.merchantCouponType === 'ppp')
		return 'regional'
	if (hasCoupon && !facts.siteCouponFound && !facts.merchantCouponFound)
		return 'unclassified'
	if (hasCoupon || facts.merchantCouponFound) return 'other-coupon'
	return 'full-price'
}

export type Pending = { status: 'pending'; reason: string }
export type EvergreenFunnel =
	| Pending
	| {
			status: 'ready'
			daily: {
				date: string
				entered: number
				clicked: number
				boughtWithCoupon: number
				boughtWithout: number
				productMatched: number
			}[]
	  }
export const EVERGREEN_FUNNEL_PENDING: Pending = {
	status: 'pending',
	reason:
		'Evergreen journey aggregate read is not available yet. Conversion cannot be calculated from purchases alone.',
}

export type PromoMetrics = {
	kind: PromoKind
	currency: 'USD'
	recordCount: number
	purchaseCount: number
	gross: number
	refunds: number
	net: number
}
export type PromoRevenue = {
	currency: 'USD'
	window: {
		from: string | null
		to: string
		basis: 'purchase-created'
		bounds: '[from,to)'
	}
	byKind: PromoMetrics[]
	daily: (PromoMetrics & { date: string })[]
}
export type PromoOptions = {
	range?: AnalyticsRange
	from?: string
	to?: string
	productId?: string
}

/** UTC instants, millisecond precision (the purchase timestamp's precision). */
export function promoWindow(options: PromoOptions, now = new Date()) {
	const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
	const parse = (value: string) => {
		if (!iso.test(value) || !Number.isFinite(Date.parse(value)))
			throw new Error(
				'from/to must be UTC ISO timestamps with at most millisecond precision',
			)
		const date = new Date(value)
		if (date.toISOString().slice(0, 19) !== value.slice(0, 19))
			throw new Error('Invalid calendar date')
		return date
	}
	if ((options.from === undefined) !== (options.to === undefined))
		throw new Error('Supply both from and to')
	const to = options.to === undefined ? now : parse(options.to)
	const hours = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }
	const range = options.range ?? '30d'
	const from =
		options.from !== undefined
			? parse(options.from)
			: range === 'all'
				? null
				: new Date(to.getTime() - hours[range] * 3600000)
	if (from && from >= to) throw new Error('from must be before to')
	// Explicit windows are bounded. range=all retains the existing historical-read contract.
	if (options.from && from && to.getTime() - from.getTime() > 366 * 86400000)
		throw new Error('Explicit windows cannot exceed 366 days')
	return {
		from: from?.toISOString() ?? null,
		to: to.toISOString(),
		basis: 'purchase-created' as const,
		bounds: '[from,to)' as const,
	}
}

export type PromoAggregateRow = {
	date: string
	kind: PromoKind
	recordCount: number | string
	purchaseCount: number | string
	gross: number | string
	refunds: number | string
}
export function formatPromoRevenue(
	rows: PromoAggregateRow[],
	window: PromoRevenue['window'],
): PromoRevenue {
	const byKind: PromoMetrics[] = PROMO_KINDS.map((kind) => ({
		kind,
		currency: 'USD',
		recordCount: 0,
		purchaseCount: 0,
		gross: 0,
		refunds: 0,
		net: 0,
	}))
	const money = (value: number) =>
		Math.round((value + Number.EPSILON) * 100) / 100
	const daily = rows.map((row) => {
		const total = byKind.find((entry) => entry.kind === row.kind)
		if (!total) throw new Error('Unexpected promo kind from database')
		const entry = {
			date: row.date,
			kind: row.kind,
			currency: 'USD' as const,
			recordCount: Number(row.recordCount),
			purchaseCount: Number(row.purchaseCount),
			gross: money(Number(row.gross)),
			refunds: money(Number(row.refunds)),
			net: money(Number(row.gross) - Number(row.refunds)),
		}
		for (const key of [
			'recordCount',
			'purchaseCount',
			'gross',
			'refunds',
		] as const)
			total[key] += entry[key]
		total.gross = money(total.gross)
		total.refunds = money(total.refunds)
		total.net = money(total.gross - total.refunds)
		return entry
	})
	return { currency: 'USD', window, byKind, daily }
}
