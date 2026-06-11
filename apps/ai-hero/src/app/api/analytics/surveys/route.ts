import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
} from '@/db/schema'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { and, count, desc, eq, sql } from 'drizzle-orm'

import type { AnalyticsRange } from '@coursebuilder/analytics'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export const OPTIONS = () => NextResponse.json({}, { headers: corsHeaders })

const VALID_RANGES = new Set<AnalyticsRange>(['24h', '7d', '30d', '90d', 'all'])

function rangeToInterval(range: AnalyticsRange): string {
	switch (range) {
		case '24h':
			return '1 DAY'
		case '7d':
			return '7 DAY'
		case '30d':
			return '30 DAY'
		case '90d':
			return '90 DAY'
		case 'all':
			return '3650 DAY'
	}
}

async function checkAnalyticsAccess(request: NextRequest) {
	const deviceAuth = await getUserAbilityForRequest(request)
	const canAccess = (a: typeof deviceAuth.ability) =>
		a?.can('manage', 'all') || a?.can('view', 'Analytics')

	if (deviceAuth.ability && canAccess(deviceAuth.ability)) {
		return { authorized: true, user: deviceAuth.user }
	}

	const { getServerAuthSession } = await import('@/server/auth')
	const sessionAuth = await getServerAuthSession()
	if (sessionAuth.ability && canAccess(sessionAuth.ability)) {
		return { authorized: true, user: sessionAuth.session?.user ?? null }
	}

	return { authorized: false, user: null }
}

/**
 * GET /api/analytics/surveys
 * Lists all surveys with response counts.
 * Requires `view Analytics` or `manage all`.
 */
export const GET = withSkill(async (request: NextRequest) => {
	const access = await checkAnalyticsAccess(request)
	if (!access.authorized) {
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics/surveys',
				error: { message: 'Unauthorized', code: 'AUTH_REQUIRED' },
				fix: 'Authenticate with an admin/reviewer session or device token.',
			},
			{ status: 401, headers: corsHeaders },
		)
	}

	const { searchParams } = new URL(request.url)
	const range = (
		VALID_RANGES.has(searchParams.get('range') as AnalyticsRange)
			? searchParams.get('range')
			: '30d'
	) as AnalyticsRange
	const interval = rangeToInterval(range)

	try {
		const surveys = await db
			.select({
				surveyId: contentResource.id,
				surveyTitle: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`,
				surveySlug: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.slug'))`,
				state: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.state'))`,
				responses: count(questionResponse.id),
				uniqueRespondents: sql<number>`COUNT(DISTINCT COALESCE(${questionResponse.userId}, ${questionResponse.emailListSubscriberId}))`,
			})
			.from(contentResource)
			.leftJoin(
				questionResponse,
				and(
					eq(questionResponse.surveyId, contentResource.id),
					sql`${questionResponse.createdAt} >= DATE_SUB(NOW(), INTERVAL ${sql.raw(interval)})`,
				),
			)
			.where(eq(contentResource.type, 'survey'))
			.groupBy(contentResource.id)
			.orderBy(desc(count(questionResponse.id)))

		// Question counts per survey
		const questionCounts = await db
			.select({
				surveyId: contentResourceResource.resourceOfId,
				questionCount: count(),
			})
			.from(contentResourceResource)
			.innerJoin(
				contentResource,
				and(
					eq(contentResourceResource.resourceId, contentResource.id),
					eq(contentResource.type, 'question'),
				),
			)
			.groupBy(contentResourceResource.resourceOfId)

		const qMap = new Map(
			questionCounts.map((qc: any) => [qc.surveyId, qc.questionCount]),
		)

		const data = surveys.map((s: any) => ({
			surveyId: s.surveyId,
			surveyTitle: s.surveyTitle ?? '',
			surveySlug: s.surveySlug ?? '',
			state: s.state ?? 'draft',
			responses: s.responses,
			uniqueRespondents: s.uniqueRespondents,
			questionCount: qMap.get(s.surveyId) ?? 0,
			_links: {
				detail: {
					href: `/api/analytics/surveys/${s.surveyId}?range=${range}`,
				},
			},
		}))

		return NextResponse.json(
			{
				ok: true,
				endpoint: '/api/analytics/surveys',
				range,
				data,
				meta: { totalRows: data.length },
				next_actions: [
					{
						command:
							'GET /api/analytics/surveys/<surveyId>?range=<range>&limit=<limit>',
						description: 'Drill into a single survey',
						params: {
							range: {
								default: '30d',
								enum: ['24h', '7d', '30d', '90d', 'all'],
							},
							limit: { default: '100', description: 'Max response rows' },
						},
					},
				],
			},
			{ headers: corsHeaders },
		)
	} catch (error) {
		await log.error('api.analytics.surveys.list.failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics/surveys',
				error: { message: 'Internal server error', code: 'QUERY_FAILED' },
			},
			{ status: 500, headers: corsHeaders },
		)
	}
})
