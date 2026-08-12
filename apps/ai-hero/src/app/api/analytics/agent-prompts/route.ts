import { NextRequest, NextResponse } from 'next/server'
import {
	getAgentPromptUsage,
	type GA4TrafficRange,
} from '@/lib/analytics/providers/ga4'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const VALID_RANGES = new Set<GA4TrafficRange>([
	'24h',
	'7d',
	'30d',
	'90d',
	'180d',
])
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export const OPTIONS = () => NextResponse.json({}, { headers: corsHeaders })

export const GET = withSkill(async (request: NextRequest) => {
	const deviceAuth = await getUserAbilityForRequest(request)
	let ability = deviceAuth.ability
	let user = deviceAuth.user
	const canView = () =>
		ability.can('manage', 'all') || ability.can('view', 'Analytics')

	if (!canView()) {
		const sessionAuth = await getServerAuthSession()
		ability = sessionAuth.ability
		user = sessionAuth.session?.user ?? null
	}

	if (!canView()) {
		void log.warn('api.analytics.agent-prompts.access-denied', {
			userId: user?.id ?? null,
		})
		return NextResponse.json(
			{
				ok: false,
				error: { code: 'AUTH_REQUIRED', message: 'Unauthorized' },
				fix: 'Authenticate with an analytics-capable device token or admin session.',
			},
			{ status: 401, headers: corsHeaders },
		)
	}

	const { searchParams } = new URL(request.url)
	const slug = searchParams.get('slug')?.trim()
	const rawRange = searchParams.get('range') ?? '30d'

	if (!slug) {
		return NextResponse.json(
			{
				ok: false,
				error: { code: 'MISSING_SLUG', message: 'slug is required' },
			},
			{ status: 400, headers: corsHeaders },
		)
	}

	if (!VALID_RANGES.has(rawRange as GA4TrafficRange)) {
		return NextResponse.json(
			{
				ok: false,
				error: { code: 'INVALID_RANGE', message: 'Unsupported range' },
				validRanges: [...VALID_RANGES],
			},
			{ status: 400, headers: corsHeaders },
		)
	}

	const startedAt = Date.now()
	const range = rawRange as GA4TrafficRange
	const data = await getAgentPromptUsage(slug, range)

	return NextResponse.json(
		{
			ok: true,
			surface: 'agent-prompts',
			slug,
			range,
			data,
			meta: {
				queryTimeMs: Date.now() - startedAt,
				provider: 'ga4',
				freshness: 'GA4 custom events can take time to appear in reports.',
			},
			next_actions: [
				{
					command: `GET /api/analytics/agent-prompts?slug=${encodeURIComponent(slug)}&range=24h`,
					description: 'Read the latest prompt interaction counts.',
				},
			],
		},
		{ headers: corsHeaders },
	)
})
