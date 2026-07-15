import { NextRequest, NextResponse } from 'next/server'
import { getAdsCourseMetrics, type AdsMetricsRange } from '@/lib/ads-course-metrics'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const VALID_RANGES = new Set<AdsMetricsRange>(['today', 'yesterday', '7d', '30d'])
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export const OPTIONS = () => NextResponse.json({}, { headers: corsHeaders })

export const GET = withSkill(async (request: NextRequest) => {
	let ability: Awaited<ReturnType<typeof getUserAbilityForRequest>>['ability']
	let user: Awaited<ReturnType<typeof getUserAbilityForRequest>>['user']
	const deviceAuth = await getUserAbilityForRequest(request)
	const canAccessAnalytics = (candidate: typeof ability) =>
		candidate?.can('manage', 'all') || candidate?.can('view', 'Analytics')

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
		void log.warn('api.analytics.ads-course.access-denied', {
			userId: (user as any)?.id ?? null,
			email: (user as any)?.email ?? null,
			authMethod: deviceAuth.user ? 'device_token' : 'session',
		})
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics/ads-course',
				error: { message: 'Unauthorized', code: 'AUTH_REQUIRED' },
				fix: 'Authenticate with an admin device token or an admin session cookie.',
				next_actions: [
					{ command: 'GET /api/coursebuilder/devices', description: 'Start device verification flow to obtain a Bearer token' },
					{ command: 'GET /login', description: 'Log in as an admin to use session-based auth' },
				],
			},
			{ status: 401, headers: corsHeaders },
		)
	}

	const { searchParams } = new URL(request.url)
	const rawRange = searchParams.get('range') ?? 'today'
	if (!VALID_RANGES.has(rawRange as AdsMetricsRange)) {
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics/ads-course',
				error: { message: `Unknown range: ${rawRange}`, code: 'INVALID_RANGE' },
				fix: 'Use today, yesterday, 7d, or 30d.',
				next_actions: [{ command: 'GET /api/analytics/ads-course?range=today', description: 'Read today’s ads and course funnel metrics' }],
			},
			{ status: 400, headers: corsHeaders },
		)
	}
	const range = rawRange as AdsMetricsRange
	const productId = searchParams.get('productId') ?? 'email-course'
	await log.info('api.analytics.ads-course.query', {
		userId: (user as any)?.id ?? null,
		email: (user as any)?.email ?? null,
		authMethod: deviceAuth.user ? 'device_token' : 'session',
		productId,
		range,
	})

	try {
		const data = await getAdsCourseMetrics({ productId, range })
		return NextResponse.json(
			{
				ok: true,
				endpoint: '/api/analytics/ads-course',
				surface: 'ads-course',
				productId,
				range,
				description: 'Paid campaign economics and email-course funnel health',
				data,
				meta: { totalRows: 1, truncated: false },
				next_actions: [
					{ command: `GET /api/analytics/ads-course?productId=${productId}&range=today`, description: 'Read today’s matching ads and funnel window' },
					{ command: `GET /api/analytics/ads-course?productId=${productId}&range=30d`, description: 'Read the rolling 30-day window' },
				],
			},
			{ headers: corsHeaders },
		)
	} catch (error) {
		await log.error('api.analytics.ads-course.error', {
			userId: (user as any)?.id ?? null,
			productId,
			range,
			error: error instanceof Error ? error.message : String(error),
		})
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics/ads-course',
				surface: 'ads-course',
				error: { message: error instanceof Error ? error.message : String(error), code: 'ADS_COURSE_METRICS_UNAVAILABLE' },
				fix: 'Check the database and Google Ads reporting credentials, then retry.',
				next_actions: [{ command: `GET /api/analytics/ads-course?productId=${productId}&range=${range}`, description: 'Retry this metrics read' }],
			},
			{ status: 503, headers: corsHeaders },
		)
	}
})
