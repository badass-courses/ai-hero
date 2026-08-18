import type { SurfaceName } from '@/lib/analytics'

export const ANALYTICS_SCHEMA_VERSION = '2026-08-18'

export const ANALYTICS_AGENT_INSTRUCTIONS = [
	'Revenue amounts are USD major units. Treat database revenue surfaces as the revenue source of truth, not GA4.',
	'Use the same range and productId when comparing summary with revenue/daily. Requests at different times can include different purchases.',
	'Read summary revenue from data.totalRevenue. Read daily revenue from data[].revenue. There is no totalRevenue field on revenue/daily rows.',
	'For purchases/recent, follow meta.pagination.nextOffset until it is null. meta.totalRows is the current page size, not the total matching purchase count.',
	'Absent productId means all products. A productId only scopes surfaces whose schema lists productId in supports.',
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

export const REVENUE_SURFACE_SCHEMAS = {
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
					isTeam: { type: 'boolean' },
					seats: { type: ['integer', 'null'], minimum: 1 },
				},
			},
		},
		semantics: [
			'Rows are newest first. Large historical purchases do not outrank newer purchases.',
			'Follow meta.pagination.nextOffset until null. meta.totalRows is only the current page size.',
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
					maximum: 1000,
					default: 20,
					description:
						'Max 100 generally. Max 1000 only for surveys/responses.',
				},
				offset: {
					type: 'integer',
					minimum: 0,
					default: 0,
				},
				productId: { type: 'string' },
				purchaseId: { type: 'string' },
				surveyId: { type: 'string' },
				surveySlug: { type: 'string' },
				questionId: { type: 'string' },
			},
		},
		surfaces: REVENUE_SURFACE_SCHEMAS,
	}
}
