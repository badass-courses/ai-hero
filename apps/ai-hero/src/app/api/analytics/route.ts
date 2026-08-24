import { NextRequest, NextResponse } from 'next/server'
import * as analytics from '@/lib/analytics'
import type { AnalyticsRange, SurfaceEntry, SurfaceName } from '@/lib/analytics'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import {
	ANALYTICS_AGENT_INSTRUCTIONS,
	getAnalyticsAgentSchema,
	getRevenueSurfaceSchema,
} from './agent-contract'

type ApiAnalyticsRange = AnalyticsRange | '180d'

const VALID_RANGES = new Set<ApiAnalyticsRange>([
	'24h',
	'7d',
	'30d',
	'90d',
	'180d',
	'all',
])
const RANGE_OPTIONS: ApiAnalyticsRange[] = [
	'24h',
	'7d',
	'30d',
	'90d',
	'180d',
	'all',
]
const catalog = analytics.getCatalog()
const catalogByName = Object.fromEntries(
	catalog.map((entry) => [entry.name, entry]),
) as Record<SurfaceName, SurfaceEntry>

const CATEGORY_SUGGESTIONS: Record<SurfaceEntry['category'], SurfaceName[]> = {
	revenue: [
		'revenue/daily',
		'revenue/products',
		'attribution/sources',
		'correlation/traffic-revenue',
	],
	attribution: [
		'attribution/funnel',
		'attribution/sources',
		'attribution/coverage',
		'attribution/commerce-lanes',
		'attribution/email-campaigns/strict',
		'attribution/checkout-survey-fallback',
		'correlation/traffic-revenue',
	],
	traffic: [
		'traffic/daily',
		'traffic/sources',
		'correlation/traffic-revenue',
		'correlation/youtube-revenue',
	],
	youtube: [
		'youtube/videos',
		'youtube/daily',
		'youtube/sources',
		'correlation/youtube-revenue',
	],
	correlation: [
		'summary',
		'attribution/funnel',
		'youtube',
		'correlation/survey-revenue',
		'correlation/survey-revenue/product',
	],
	survey: [
		'surveys',
		'surveys/list',
		'surveys/daily',
		'surveys/questions',
		'correlation/survey-revenue/product',
		'attribution/checkout-survey-fallback',
	],
	'value-path': [
		'value-paths/summary',
		'surveys/questions',
		'attribution/email-campaigns/strict',
		'attribution/shortlinks',
	],
}

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function parseRange(raw?: string | null): ApiAnalyticsRange {
	if (raw && VALID_RANGES.has(raw as ApiAnalyticsRange)) {
		return raw as ApiAnalyticsRange
	}

	return '30d'
}

function getMeta(
	data: unknown,
	queryTimeMs: number,
	truncated: boolean,
	options: {
		limit: number
		offset: number
		surface: SurfaceName
		range: ApiAnalyticsRange
		totalMatchingRows?: number
	},
) {
	const rowCount = Array.isArray(data) ? data.length : 1
	const hasMore =
		options.totalMatchingRows !== undefined
			? options.offset + rowCount < options.totalMatchingRows
			: rowCount === options.limit
	return {
		totalRows: rowCount,
		truncated,
		queryTimeMs,
		pagination:
			options.surface === 'surveys/responses' ||
			options.surface === 'purchases/recent'
				? {
						limit: options.limit,
						offset: options.offset,
						returnedRows: rowCount,
						totalMatchingRows: options.totalMatchingRows,
						hasMore,
						nextOffset: hasMore ? options.offset + rowCount : null,
						previousOffset:
							options.offset > 0
								? Math.max(0, options.offset - options.limit)
								: null,
					}
				: undefined,
	}
}

function buildContextualNextActions(
	surface: SurfaceName,
	range: ApiAnalyticsRange,
	options: {
		limit?: number
		offset?: number
		nextOffset?: number | null
		productId?: string
	} = {},
) {
	const entry = catalogByName[surface]
	const suggestions = CATEGORY_SUGGESTIONS[entry.category] ?? []

	const actions: Array<{
		command: string
		description: string
		params?: Record<string, unknown>
	}> = suggestions
		.filter((name) => name !== surface)
		.slice(0, 4)
		.map((name) => {
			const searchParams = new URLSearchParams({ surface: name, range })
			if (options.productId) {
				searchParams.set('productId', options.productId)
			}
			return {
				command: `GET /api/analytics?${searchParams.toString()}`,
				description: catalogByName[name].description,
				params: {
					range: {
						value: range,
						enum: RANGE_OPTIONS,
					},
					...(options.productId
						? { productId: { value: options.productId } }
						: {}),
				},
			}
		})

	const paginated =
		surface === 'surveys/responses' || surface === 'purchases/recent'
	if (paginated) {
		const limit = options.limit ?? (surface === 'surveys/responses' ? 100 : 20)
		const offset = options.offset ?? 0
		const max = surface === 'surveys/responses' ? 1000 : 100
		const noun =
			surface === 'surveys/responses' ? 'survey response rows' : 'purchases'

		const paginationAction = (nextOffset: number, description: string) => {
			const searchParams = new URLSearchParams({
				surface,
				range,
				limit: String(limit),
				offset: String(nextOffset),
			})
			if (options.productId) {
				searchParams.set('productId', options.productId)
			}
			return {
				command: `GET /api/analytics?${searchParams.toString()}`,
				description,
				params: {
					range: { value: range, enum: RANGE_OPTIONS },
					limit: { value: limit, max },
					offset: { value: nextOffset },
					...(options.productId
						? { productId: { value: options.productId } }
						: {}),
				},
			}
		}

		if (options.nextOffset !== null && options.nextOffset !== undefined) {
			actions.unshift(
				paginationAction(options.nextOffset, `Fetch the next page of ${noun}`),
			)
		}
		if (offset > 0) {
			actions.unshift(
				paginationAction(
					Math.max(0, offset - limit),
					`Fetch the previous page of ${noun}`,
				),
			)
		}
	}

	return actions
}

export const OPTIONS = () => NextResponse.json({}, { headers: corsHeaders })

export const GET = withSkill(async (request: NextRequest) => {
	let ability: Awaited<ReturnType<typeof getUserAbilityForRequest>>['ability']
	let user: Awaited<ReturnType<typeof getUserAbilityForRequest>>['user']

	const deviceAuth = await getUserAbilityForRequest(request)
	const canAccessAnalytics = (a: typeof ability) =>
		a?.can('manage', 'all') || a?.can('view', 'Analytics')

	if (deviceAuth.ability && canAccessAnalytics(deviceAuth.ability)) {
		ability = deviceAuth.ability
		user = deviceAuth.user
	} else {
		const { getServerAuthSession } = await import('@/server/auth')
		const sessionAuth = await getServerAuthSession()
		ability = sessionAuth.ability
		user = sessionAuth.session?.user ?? null
	}

	if (!ability || !canAccessAnalytics(ability)) {
		void log.warn('api.analytics.access-denied', {
			userId: (user as any)?.id ?? null,
			email: (user as any)?.email ?? null,
			authMethod: deviceAuth.user ? 'device_token' : 'session',
			hasAbility: !!ability,
		})
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics',
				error: {
					message: 'Unauthorized',
					code: 'AUTH_REQUIRED',
				},
				fix: 'Authenticate with an admin device token or an admin session cookie.',
				next_actions: [
					{
						command: 'GET /api/coursebuilder/devices',
						description:
							'Start device verification flow to obtain a Bearer token',
					},
					{
						command: 'GET /login',
						description: 'Log in as an admin to use session-based auth',
					},
				],
			},
			{ status: 401, headers: corsHeaders },
		)
	}

	const requestUrl = new URL(request.url)
	const { searchParams } = requestUrl
	const rawSurface = searchParams.get('surface')

	if (!rawSurface) {
		return NextResponse.json(
			{
				ok: true,
				endpoint: '/api/analytics',
				description:
					'AI Hero analytics, revenue, attribution, traffic, YouTube, and content correlation',
				notes: [
					'Paid campaign and email-course funnel metrics are available at GET /api/analytics/ads-course?productId=email-course&range=today.',
					'The traffic surface includes GA4 device category, operating system, and screen resolution breakdowns with session percentages.',
					'Use range=180d only for GA4 traffic surfaces. Non-GA4 surfaces intentionally reject it.',
					'Attribution coverage includes quality lanes when the database provider exposes them. Coverage does not mean clean first-touch attribution.',
					'GA4 conversion writes return safe receipts in Inngest logs, but GA4 is not the revenue source of truth.',
					'YouTube surfaces are useful for correlation/content analysis but lag by about 48 hours.',
				],
				surfaces: catalog,
				agent_instructions: ANALYTICS_AGENT_INSTRUCTIONS,
				schema: getAnalyticsAgentSchema(catalog.map((entry) => entry.name)),
				_links: {
					self: { href: `${requestUrl.origin}${requestUrl.pathname}` },
				},
				next_actions: [
					{
						command:
							'GET /api/analytics/ads-course?productId=email-course&range=today',
						description:
							'Read matching Google Ads economics and email-course funnel metrics',
					},
					{
						command:
							'GET /api/analytics?surface=<surface>&range=<range>&limit=<limit>&offset=<offset>&productId=<productId>',
						description: 'Query a specific analytics surface',
						params: {
							surface: {
								required: true,
								enum: catalog.map((entry) => entry.name),
								description: 'Analytics surface to query',
							},
							range: {
								default: '30d',
								enum: RANGE_OPTIONS,
								description: 'Time range',
							},
							limit: {
								default: '20',
								description:
									'Max rows for surfaces that support it. Max 100 generally, max 1000 for surveys/responses.',
							},
							offset: {
								default: '0',
								description:
									'Row offset for paginated surfaces such as surveys/responses',
							},
							productId: {
								required: false,
								description:
									'Optional product filter for product-aware revenue, purchase, and attribution surfaces',
							},
							purchaseId: {
								required: false,
								description: 'Required for attribution/checkout-receipt',
							},
							surveyId: {
								required: false,
								description:
									'Optional survey ID filter for product survey correlation',
							},
							surveySlug: {
								required: false,
								description:
									'Optional survey slug filter for product survey correlation',
							},
							questionId: {
								required: false,
								description:
									'Optional question ID filter for product survey correlation',
							},
						},
					},
				],
			},
			{ headers: corsHeaders },
		)
	}

	if (!(rawSurface in catalogByName)) {
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics',
				error: {
					message: `Unknown surface: ${rawSurface}`,
					code: 'INVALID_SURFACE',
				},
				fix: 'Hit GET /api/analytics with no params for the full surface catalog.',
				next_actions: [
					{
						command: 'GET /api/analytics',
						description: 'Browse the full analytics surface catalog',
					},
				],
			},
			{ status: 400, headers: corsHeaders },
		)
	}

	const surface = rawSurface as SurfaceName
	const range = parseRange(searchParams.get('range'))

	if (range === '180d' && catalogByName[surface].provider !== 'ga4') {
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics',
				surface,
				error: {
					message: 'range=180d is only supported for GA4 traffic surfaces',
					code: 'INVALID_RANGE_FOR_SURFACE',
				},
				fix: 'Use a traffic surface, or use range=90d/all for non-traffic analytics.',
				next_actions: [
					{
						command: 'GET /api/analytics?surface=traffic&range=180d',
						description:
							'Fetch the six-month GA4 traffic overview with device, OS, and screen resolution breakdowns',
					},
				],
			},
			{ status: 400, headers: corsHeaders },
		)
	}

	const requestedLimit = Number(searchParams.get('limit') ?? 20)
	const limit = Math.min(
		Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20,
		surface === 'surveys/responses' ? 1000 : 100,
	)
	const requestedOffset = Number(searchParams.get('offset') ?? 0)
	const offset =
		Number.isFinite(requestedOffset) && requestedOffset > 0
			? Math.floor(requestedOffset)
			: 0

	const productId = searchParams.get('productId') ?? undefined
	const purchaseId = searchParams.get('purchaseId') ?? undefined
	const surveyId = searchParams.get('surveyId') ?? undefined
	const surveySlug = searchParams.get('surveySlug') ?? undefined
	const questionId = searchParams.get('questionId') ?? undefined
	const normalizedSearchParams = new URLSearchParams({
		surface,
		range,
		limit: String(limit),
		offset: String(offset),
	})
	for (const [name, value] of [
		['productId', productId],
		['purchaseId', purchaseId],
		['surveyId', surveyId],
		['surveySlug', surveySlug],
		['questionId', questionId],
	] as const) {
		if (value !== undefined) normalizedSearchParams.set(name, value)
	}

	await log.info('api.analytics.query', {
		userId: (user as any)?.id ?? null,
		email: (user as any)?.email ?? null,
		authMethod: deviceAuth.user ? 'device_token' : 'session',
		surface,
		range,
		limit,
		offset,
		productId,
		purchaseId,
		surveyId,
		surveySlug,
		questionId,
	})

	const result = await analytics.query(surface, {
		range: range as AnalyticsRange,
		limit,
		offset,
		productId,
		purchaseId,
		surveyId,
		surveySlug,
		questionId,
	})

	if (!result.ok) {
		await log.error('api.analytics.error', {
			userId: user?.id,
			surface,
			range,
			code: result.error.code,
			error: result.error.message,
		})

		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics',
				surface,
				error: result.error,
				fix: result.fix,
				next_actions: buildContextualNextActions(surface, range, {
					limit,
					offset,
					productId,
				}),
			},
			{
				status: result.error.code.endsWith('_UNAVAILABLE') ? 503 : 500,
				headers: corsHeaders,
			},
		)
	}

	let totalMatchingRows: number | undefined
	if (surface === 'purchases/recent') {
		const summaryResult = await analytics.query('summary', {
			range: range as AnalyticsRange,
			productId,
		})
		if (!summaryResult.ok) {
			return NextResponse.json(
				{
					ok: false,
					endpoint: '/api/analytics',
					surface,
					error: {
						code: 'PURCHASE_COUNT_UNAVAILABLE',
						message: 'Could not determine the exact matching purchase count.',
					},
					fix: summaryResult.fix,
				},
				{
					status: summaryResult.error.code.endsWith('_UNAVAILABLE') ? 503 : 500,
					headers: corsHeaders,
				},
			)
		}

		const summaryData = summaryResult.data as { purchaseCount?: unknown }
		if (typeof summaryData.purchaseCount !== 'number') {
			return NextResponse.json(
				{
					ok: false,
					endpoint: '/api/analytics',
					surface,
					error: {
						code: 'INVALID_PURCHASE_COUNT',
						message:
							'The revenue summary did not return a numeric purchaseCount.',
					},
				},
				{ status: 500, headers: corsHeaders },
			)
		}
		totalMatchingRows = summaryData.purchaseCount
	}

	const meta = getMeta(
		result.data,
		result.meta.queryTimeMs,
		result.meta.truncated,
		{
			limit,
			offset,
			surface,
			range,
			totalMatchingRows,
		},
	)
	const hrefForOffset = (pageOffset: number) => {
		const params = new URLSearchParams(normalizedSearchParams)
		params.set('offset', String(pageOffset))
		return `${requestUrl.origin}${requestUrl.pathname}?${params.toString()}`
	}

	return NextResponse.json(
		{
			ok: true,
			endpoint: '/api/analytics',
			surface,
			range,
			offset,
			productId,
			description: catalogByName[surface].description,
			agent_instructions: ANALYTICS_AGENT_INSTRUCTIONS,
			schema: getRevenueSurfaceSchema(surface),
			data: result.data,
			meta,
			_links: {
				self: { href: hrefForOffset(offset) },
				...(meta.pagination?.nextOffset !== null &&
				meta.pagination?.nextOffset !== undefined
					? {
							next: {
								href: hrefForOffset(meta.pagination.nextOffset),
							},
						}
					: {}),
				...(meta.pagination?.previousOffset !== null &&
				meta.pagination?.previousOffset !== undefined
					? {
							previous: {
								href: hrefForOffset(meta.pagination.previousOffset),
							},
						}
					: {}),
			},
			next_actions: buildContextualNextActions(surface, range, {
				limit,
				offset,
				nextOffset: meta.pagination?.nextOffset,
				productId,
			}),
		},
		{ headers: corsHeaders },
	)
})
