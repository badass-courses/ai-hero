import type { SurfaceName } from '@/lib/analytics'
import { PROMO_KINDS } from '@/lib/analytics/promos'

export const ANALYTICS_SCHEMA_VERSION = '2026-10-16.1'

export const ANALYTICS_AGENT_INSTRUCTIONS = [
	'Revenue amounts are USD major units. Treat database revenue surfaces as the revenue source of truth, not GA4.',
	'Use the same range and productId when comparing summary with revenue/daily. Requests at different times can include different purchases.',
	'Read summary revenue from data.totalRevenue. Read daily revenue from data[].revenue. There is no totalRevenue field on revenue/daily rows.',
	'The 100-row purchases/recent limit is a per-page cap, not a total cap. Read meta.pagination.totalMatchingRows for the full matching count. Follow _links.next.href until it is absent, or meta.pagination.nextOffset until it is null. meta.totalRows is the current page size.',
	'Absent productId means all products on product-aware surfaces. Published revenue schemas list productId support, and some attribution surfaces also accept it.',
	'purchases/recent defaults to range=30d. Use range=all when historical purchases are required.',
	'Treat each response as a point-in-time read. Re-query before reporting live launch numbers.',
] as const

const usd = (description: string) => ({
	type: 'number',
	unit: 'USD',
	description,
})

const count = (description: string) => ({
	type: 'integer',
	minimum: 0,
	description,
})

const promoMetrics = {
	type: 'object',
	additionalProperties: false,
	required: [
		'kind',
		'currency',
		'recordCount',
		'purchaseCount',
		'gross',
		'refunds',
		'net',
	],
	properties: {
		kind: { type: 'string', enum: PROMO_KINDS },
		currency: { const: 'USD' },
		recordCount: count('All records, including seat/zero and unclassified'),
		purchaseCount: count(
			'Positive Valid, Restricted and Refunded purchases, excluding team-seat redemptions',
		),
		gross: usd(
			'Original paid amounts, including subsequently refunded purchases',
		),
		refunds: usd(
			'Refunded purchase amounts, dated by purchase creation, not refund time',
		),
		net: usd('gross minus refunds'),
	},
} as const

export const REVENUE_SURFACE_SCHEMAS = {
	'revenue/promos': {
		supports: ['range', 'from', 'to', 'productId'],
		data: {
			type: 'object',
			additionalProperties: false,
			required: ['currency', 'window', 'byKind', 'daily'],
			properties: {
				currency: { const: 'USD' },
				window: {
					type: 'object',
					additionalProperties: false,
					required: ['from', 'to', 'basis', 'bounds'],
					properties: {
						from: { type: ['string', 'null'], format: 'date-time' },
						to: { type: 'string', format: 'date-time' },
						basis: { const: 'purchase-created' },
						bounds: { const: '[from,to)' },
					},
				},
				byKind: { type: 'array', items: promoMetrics },
				daily: {
					type: 'array',
					items: {
						...promoMetrics,
						required: [...promoMetrics.required, 'date'],
						properties: {
							...promoMetrics.properties,
							date: { type: 'string', format: 'date' },
						},
					},
				},
			},
		},
		semantics: [
			'USD major units. No customer identifiers. SQL groups by UTC purchase-created day and promo kind.',
			'Precedence: seat-or-zero; invalid amount or unknown status -> unclassified; evergreen; regional; unresolved coupon -> unclassified; other-coupon; full-price.',
			'Evergreen means the linked site coupon has fields.evergreenOffer present, including null or false. Coupon status/expiry and arbitrary merchant offer types do not rewrite historical attribution.',
			'Regional means Restricted, or a linked merchant coupon of type ppp (also preserves regional attribution on Refunded rows when that link exists).',
			'Classification uses persisted coupon evidence only. A refunded row cannot recover a previous Restricted status without a persisted PPP coupon link. An unrecorded merchant discount cannot be inferred from the paid amount.',
			'Unknown purchase statuses (including Disputed and Banned) are unclassified and excluded from paid money, matching the base revenue provider. Status comparisons are byte-exact. Unresolved coupon references are unclassified, not full-price. recordCount makes every record visible.',
			'purchaseCount counts positive Valid/Restricted/Refunded records except team-seat redemptions. Seat/zero and unknown statuses never contribute paid amounts.',
			'gross includes original amounts of Refunded purchases; refunds includes their amounts; net = gross - refunds. Refunds are dated by purchase creation, not refund time. Partial Stripe refund events are not represented by this purchase-status report.',
			'from/to must be supplied together as UTC ISO timestamps (Z, at most millisecond precision), using half-open [from,to) bounds, max 400 days. Explicit windows override the rolling range, and the envelope echoes window instead of range. range=all without an explicit window is rejected with a 400; paired from/to override range=all. Use 24h/7d/30d/90d or paired from/to. Other surfaces reject from/to.',
		],
	},
	'funnel/evergreen': {
		supports: ['range', 'from', 'to', 'productId'],
		data: {
			oneOf: [
				{
					type: 'object',
					additionalProperties: false,
					required: ['status', 'reason'],
					properties: {
						status: { const: 'pending' },
						reason: { type: 'string' },
					},
				},
				{
					type: 'object',
					additionalProperties: false,
					required: ['status', 'daily'],
					properties: {
						status: { const: 'ready' },
						daily: {
							type: 'array',
							items: {
								type: 'object',
								additionalProperties: false,
								required: [
									'date',
									'entered',
									'clicked',
									'boughtWithCoupon',
									'boughtWithout',
									'productMatched',
								],
								properties: {
									date: { type: 'string', format: 'date' },
									entered: count('Entered journey'),
									clicked: count('Clicked offer'),
									boughtWithCoupon: count('Bought with offer coupon'),
									boughtWithout: count('Bought without offer coupon'),
									productMatched: count(
										'Purchases matched to the offered product',
									),
								},
							},
						},
					},
				},
			],
		},
		semantics: [
			'Currently returns only { status: pending, reason }. No journey provider calls. Conversion remains typed pending, never zero, until an aggregate read lands.',
		],
	},
	summary: {
		supports: ['range', 'productId'],
		data: {
			type: 'object',
			additionalProperties: false,
			required: ['totalRevenue', 'purchaseCount', 'avgOrderValue'],
			properties: {
				totalRevenue: usd('Paid purchase revenue for the selected filters'),
				purchaseCount: count('Paid purchase records for the selected filters'),
				avgOrderValue: usd('totalRevenue divided by purchaseCount'),
			},
		},
		semantics: [
			'Use data.totalRevenue for the revenue total.',
			'Use the same range and productId to reconcile with revenue/daily.',
		],
	},
	'revenue/daily': {
		supports: ['range', 'productId'],
		data: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['date', 'revenue', 'count'],
				properties: {
					date: {
						type: 'string',
						format: 'date',
						description: 'Purchase database calendar date',
					},
					revenue: usd('Paid purchase revenue for this date'),
					count: count('Paid purchase records for this date'),
				},
			},
		},
		semantics: [
			'Read revenue from data[].revenue, not totalRevenue.',
			'The sum of rows reconciles with summary when both requests use the same filters and data snapshot.',
		],
	},
	'revenue/products': {
		supports: ['range', 'productId'],
		data: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['productId', 'productName', 'revenue', 'count'],
				properties: {
					productId: { type: 'string' },
					productName: { type: 'string' },
					revenue: usd('Paid purchase revenue for this product'),
					count: count('Paid purchase records for this product'),
				},
			},
		},
		semantics: [
			'Without productId, rows are ordered by revenue descending across all products.',
		],
	},
	'revenue/countries': {
		supports: ['range', 'productId'],
		data: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['country', 'revenue', 'count'],
				properties: {
					country: {
						type: 'string',
						description: 'Purchase country or (unknown)',
					},
					revenue: usd('Paid purchase revenue for this country'),
					count: count('Paid purchase records for this country'),
				},
			},
		},
		semantics: ['Rows are ordered by revenue descending and limited to 20.'],
	},
	'purchases/recent': {
		supports: ['range', 'productId', 'limit', 'offset'],
		order: ['createdAt desc', 'id desc'],
		pagination: {
			limitMaximum: 100,
			currentPageCount: 'meta.pagination.returnedRows',
			totalMatchingCount: 'meta.pagination.totalMatchingRows',
			nextPage: '_links.next.href',
			previousPage: '_links.previous.href',
		},
		data: {
			type: 'array',
			items: {
				type: 'object',
				required: [
					'id',
					'createdAt',
					'totalAmount',
					'productName',
					'productId',
				],
				properties: {
					id: { type: 'string' },
					createdAt: { type: 'string', format: 'date-time' },
					totalAmount: usd('Paid amount for this purchase'),
					productName: { type: 'string' },
					productId: { type: 'string' },
					country: { type: ['string', 'null'] },
					couponId: { type: ['string', 'null'] },
					userName: { type: ['string', 'null'] },
					userEmail: { type: ['string', 'null'], format: 'email' },
					isTeam: {
						type: 'boolean',
						description:
							'True only when the purchase has a bulk coupon with more than one seat. An organization alone does not make a purchase a team purchase.',
					},
					seats: {
						type: ['integer', 'null'],
						minimum: 2,
						description:
							'Seats bought by this purchase. Set only for a team purchase that is the only purchase on its bulk coupon. Null for individual purchases and for add-seat teams, where the per-purchase count is not stored.',
					},
					teamSeats: {
						type: ['integer', 'null'],
						minimum: 2,
						description:
							"The team's current total seats, its bulk coupon's maxUses today, for any team purchase. Null for individual purchases.",
					},
				},
			},
		},
		semantics: [
			'Rows are newest first. Large historical purchases do not outrank newer purchases.',
			'The 100-row limit is per page. Follow _links.next.href until absent, or meta.pagination.nextOffset until null.',
			'Read meta.pagination.totalMatchingRows for the full matching purchase count. meta.totalRows and meta.pagination.returnedRows describe only the current page.',
			'A team purchase is one with a bulk coupon of more than one seat. Add-seat purchases reuse the team coupon and raise its total, so seats is null when a coupon has more than one purchase, and teamSeats is the team total now, not at purchase time.',
		],
	},
} as const

export type RevenueSurfaceName = keyof typeof REVENUE_SURFACE_SCHEMAS

export function getRevenueSurfaceSchema(surface: SurfaceName) {
	return REVENUE_SURFACE_SCHEMAS[surface as RevenueSurfaceName] as
		| (typeof REVENUE_SURFACE_SCHEMAS)[RevenueSurfaceName]
		| undefined
}

export function getAnalyticsAgentSchema(surfaceNames: readonly SurfaceName[]) {
	return {
		version: ANALYTICS_SCHEMA_VERSION,
		dialect: 'https://json-schema.org/draft/2020-12/schema',
		query: {
			type: 'object',
			additionalProperties: false,
			required: ['surface'],
			properties: {
				surface: {
					type: 'string',
					enum: surfaceNames,
					description: 'Analytics surface to query',
				},
				range: {
					type: 'string',
					enum: ['24h', '7d', '30d', '90d', '180d', 'all'],
					default: '30d',
					description:
						'Rolling lookback. 180d is only valid for GA4 traffic surfaces.',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					default: 20,
					description:
						'Max 100 generally. Max 1000 only for surveys/responses.',
				},
				offset: {
					type: 'integer',
					minimum: 0,
					default: 0,
				},
				from: {
					type: 'string',
					format: 'date-time',
					description:
						'revenue/promos and funnel/evergreen only. Inclusive UTC ISO instant, supply with to.',
				},
				to: {
					type: 'string',
					format: 'date-time',
					description:
						'Exclusive UTC ISO instant, supply with from. Max 400-day explicit window.',
				},
				productId: { type: 'string' },
				purchaseId: { type: 'string' },
				surveyId: { type: 'string' },
				surveySlug: { type: 'string' },
				questionId: { type: 'string' },
			},
			allOf: [
				{
					if: {
						properties: {
							surface: { enum: ['revenue/promos', 'funnel/evergreen'] },
						},
						required: ['surface'],
						not: { required: ['from', 'to'] },
					},
					then: {
						properties: { range: { enum: ['24h', '7d', '30d', '90d'] } },
					},
				},
				{
					if: {
						properties: { surface: { const: 'surveys/responses' } },
						required: ['surface'],
					},
					then: { properties: { limit: { maximum: 1000 } } },
					else: { properties: { limit: { maximum: 100 } } },
				},
			],
		},
		surfaces: REVENUE_SURFACE_SCHEMAS,
	}
}
