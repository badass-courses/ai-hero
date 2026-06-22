import { NextRequest, NextResponse } from 'next/server'
import * as analytics from '@/lib/analytics'
import type { AnalyticsRange, SurfaceEntry, SurfaceName } from '@/lib/analytics'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

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
	},
) {
	const rowCount = Array.isArray(data) ? data.length : 1
	return {
		totalRows: rowCount,
		truncated,
		queryTimeMs,
		pagination:
			options.surface === 'surveys/responses'
				? {
						limit: options.limit,
						offset: options.offset,
						nextOffset:
							rowCount === options.limit
								? options.offset + options.limit
								: null,
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
	options: { limit?: number; offset?: number; rowCount?: number } = {},
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
		.map((name) => ({
			command: `GET /api/analytics?surface=${name}&range=<range>`,
			description: catalogByName[name].description,
			params: {
				range: {
					value: range,
					enum: RANGE_OPTIONS,
				},
			},
		}))

	if (surface === 'surveys/responses') {
		const limit = options.limit ?? 100
		const offset = options.offset ?? 0
		const rowCount = options.rowCount ?? 0
		if (rowCount === limit) {
			actions.unshift({
				command: `GET /api/analytics?surface=surveys/responses&range=${range}&limit=${limit}&offset=${offset + limit}`,
				description: 'Fetch the next page of survey response rows',
				params: {
					range: { value: range, enum: RANGE_OPTIONS },
					limit: { value: limit, max: 1000 },
					offset: { value: offset + limit },
				},
			})
		}
		if (offset > 0) {
			actions.unshift({
				command: `GET /api/analytics?surface=surveys/responses&range=${range}&limit=${limit}&offset=${Math.max(0, offset - limit)}`,
				description: 'Fetch the previous page of survey response rows',
				params: {
					range: { value: range, enum: RANGE_OPTIONS },
					limit: { value: limit, max: 1000 },
					offset: { value: Math.max(0, offset - limit) },
				},
			})
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

	const { searchParams } = new URL(request.url)
	const rawSurface = searchParams.get('surface')

	if (!rawSurface) {
		return NextResponse.json(
			{
				ok: true,
				endpoint: '/api/analytics',
				description:
					'AI Hero analytics — revenue, attribution, traffic, YouTube, and content correlation',
				notes: [
					'The traffic surface includes GA4 device category, operating system, and screen resolution breakdowns with session percentages.',
					'Use range=180d for roughly the last six months of traffic data.',
					'YouTube surfaces are useful for correlation/content analysis but lag by about 48 hours.',
				],
				surfaces: catalog,
				next_actions: [
					{
						command:
							'GET /api/analytics?surface=<surface>&range=<range>&limit=<limit>',
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
									'Optional product filter for product-aware attribution surfaces',
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
				}),
			},
			{
				status: result.error.code.endsWith('_UNAVAILABLE') ? 503 : 500,
				headers: corsHeaders,
			},
		)
	}

	return NextResponse.json(
		{
			ok: true,
			endpoint: '/api/analytics',
			surface,
			range,
			offset,
			description: catalogByName[surface].description,
			data: result.data,
			meta: getMeta(
				result.data,
				result.meta.queryTimeMs,
				result.meta.truncated,
				{
					limit,
					offset,
					surface,
					range,
				},
			),
			next_actions: buildContextualNextActions(surface, range, {
				limit,
				offset,
				rowCount: Array.isArray(result.data) ? result.data.length : 0,
			}),
		},
		{ headers: corsHeaders },
	)
})
