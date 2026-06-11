import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
	users,
} from '@/db/schema'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm'

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
 * GET /api/analytics/surveys/:id?range=30d&limit=100
 *
 * Returns full survey analytics for a single survey:
 * - summary (total responses, unique respondents)
 * - responsesByDay (daily response counts)
 * - questionBreakdown (per-question answer distribution)
 * - responses (flat row per response, multi-choice + open-ended)
 *
 * Accepts survey ID or slug. Requires `view Analytics` or `manage all`.
 */
export const GET = withSkill(
	async (
		request: NextRequest,
		{ params }: { params: Promise<{ id: string }> },
	) => {
		const access = await checkAnalyticsAccess(request)
		if (!access.authorized) {
			return NextResponse.json(
				{
					ok: false,
					endpoint: '/api/analytics/surveys/:id',
					error: { message: 'Unauthorized', code: 'AUTH_REQUIRED' },
					fix: 'Authenticate with an admin/reviewer session or device token.',
				},
				{ status: 401, headers: corsHeaders },
			)
		}

		const { id: slugOrId } = await params
		const { searchParams } = new URL(request.url)
		const range = (
			VALID_RANGES.has(searchParams.get('range') as AnalyticsRange)
				? searchParams.get('range')
				: '30d'
		) as AnalyticsRange
		const limit = Math.min(Number(searchParams.get('limit') ?? 100), 500)
		const interval = rangeToInterval(range)
		const startMs = Date.now()

		try {
			// ── Resolve survey ────────────────────────────────────────────
			const survey = await db.query.contentResource.findFirst({
				where: and(
					or(
						eq(
							sql`JSON_EXTRACT(${contentResource.fields}, "$.slug")`,
							slugOrId,
						),
						eq(contentResource.id, slugOrId),
					),
					eq(contentResource.type, 'survey'),
				),
				with: {
					resources: {
						with: { resource: true },
						orderBy: asc(contentResourceResource.position),
					},
				},
			})

			if (!survey) {
				return NextResponse.json(
					{
						ok: false,
						endpoint: `/api/analytics/surveys/${slugOrId}`,
						error: { message: 'Survey not found', code: 'NOT_FOUND' },
						fix: 'Check the survey ID or slug. GET /api/analytics/surveys for a list.',
						next_actions: [
							{
								command: 'GET /api/analytics/surveys',
								description: 'List all surveys',
							},
						],
					},
					{ status: 404, headers: corsHeaders },
				)
			}

			const surveyFields = (survey.fields || {}) as Record<string, unknown>
			const surveyId = survey.id
			const surveyTitle =
				typeof surveyFields.title === 'string'
					? surveyFields.title
					: 'Untitled Survey'
			const surveySlug =
				typeof surveyFields.slug === 'string' ? surveyFields.slug : surveyId

			// ── Summary counts ────────────────────────────────────────────
			const [{ totalResponses = 0 } = {}] = await db
				.select({ totalResponses: count() })
				.from(questionResponse)
				.where(
					and(
						eq(questionResponse.surveyId, surveyId),
						sql`${questionResponse.createdAt} >= DATE_SUB(NOW(), INTERVAL ${sql.raw(interval)})`,
					),
				)

			const [{ uniqueRespondents = 0 } = {}] = await db
				.select({
					uniqueRespondents: sql<number>`COUNT(DISTINCT COALESCE(${questionResponse.userId}, ${questionResponse.emailListSubscriberId}))`,
				})
				.from(questionResponse)
				.where(
					and(
						eq(questionResponse.surveyId, surveyId),
						sql`${questionResponse.createdAt} >= DATE_SUB(NOW(), INTERVAL ${sql.raw(interval)})`,
					),
				)

			// ── Responses by day ──────────────────────────────────────────
			const responsesByDay = await db
				.select({
					date: sql<string>`DATE(${questionResponse.createdAt})`,
					responses: count(),
				})
				.from(questionResponse)
				.where(
					and(
						eq(questionResponse.surveyId, surveyId),
						sql`${questionResponse.createdAt} >= DATE_SUB(NOW(), INTERVAL ${sql.raw(interval)})`,
					),
				)
				.groupBy(sql`DATE(${questionResponse.createdAt})`)
				.orderBy(sql`DATE(${questionResponse.createdAt})`)

			// ── Question breakdown ────────────────────────────────────────
			// Build question lookup from survey resources
			const questionMap = new Map<
				string,
				{ question: string; type: string | null; slug: string | null }
			>()
			for (const rel of survey.resources || []) {
				if (rel.resource.type !== 'question') continue
				const f = (rel.resource.fields || {}) as Record<string, unknown>
				questionMap.set(rel.resource.id, {
					question:
						typeof f.question === 'string' ? f.question : rel.resource.id,
					type: typeof f.type === 'string' ? f.type : null,
					slug: typeof f.slug === 'string' ? f.slug : null,
				})
			}

			const topQuestionRows = await db
				.select({
					questionId: questionResponse.questionId,
					responses: sql<number>`COUNT(*)`,
					uniqueRespondents: sql<number>`COUNT(DISTINCT COALESCE(${questionResponse.userId}, ${questionResponse.emailListSubscriberId}))`,
				})
				.from(questionResponse)
				.where(
					and(
						eq(questionResponse.surveyId, surveyId),
						sql`${questionResponse.createdAt} >= DATE_SUB(NOW(), INTERVAL ${sql.raw(interval)})`,
					),
				)
				.groupBy(questionResponse.questionId)
				.orderBy(sql`COUNT(*) DESC`)

			const questionBreakdown = await Promise.all(
				topQuestionRows.map(async (q: any) => {
					const meta = questionMap.get(q.questionId)
					const answers = await db
						.select({
							answer: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${questionResponse.fields}, '$.answer'))`,
							count: count(),
						})
						.from(questionResponse)
						.where(
							and(
								eq(questionResponse.questionId, q.questionId),
								eq(questionResponse.surveyId, surveyId),
								sql`${questionResponse.createdAt} >= DATE_SUB(NOW(), INTERVAL ${sql.raw(interval)})`,
							),
						)
						.groupBy(
							sql`JSON_UNQUOTE(JSON_EXTRACT(${questionResponse.fields}, '$.answer'))`,
						)
						.orderBy(desc(count()))

					return {
						questionId: q.questionId,
						questionSlug: meta?.slug ?? null,
						question: meta?.question ?? q.questionId,
						type: meta?.type ?? null,
						responses: Number(q.responses),
						uniqueRespondents: Number(q.uniqueRespondents),
						answerDistribution: answers.map((a: any) => ({
							answer: a.answer ?? '(no answer)',
							count: a.count,
						})),
					}
				}),
			)

			// ── Individual response rows ──────────────────────────────────
			const responseRows = await db
				.select({
					responseId: questionResponse.id,
					questionId: questionResponse.questionId,
					answer: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${questionResponse.fields}, '$.answer'))`,
					userId: questionResponse.userId,
					userEmail: users.email,
					emailListSubscriberId: questionResponse.emailListSubscriberId,
					createdAt: questionResponse.createdAt,
				})
				.from(questionResponse)
				.leftJoin(users, eq(questionResponse.userId, users.id))
				.where(
					and(
						eq(questionResponse.surveyId, surveyId),
						sql`${questionResponse.createdAt} >= DATE_SUB(NOW(), INTERVAL ${sql.raw(interval)})`,
					),
				)
				.orderBy(desc(questionResponse.createdAt))
				.limit(limit)

			const responses = responseRows.map((r: any) => {
				const meta = questionMap.get(r.questionId)
				return {
					responseId: r.responseId,
					questionId: r.questionId,
					questionSlug: meta?.slug ?? null,
					question: meta?.question ?? r.questionId,
					questionType: meta?.type ?? null,
					answer: r.answer ?? '',
					userId: r.userId ?? null,
					userEmail: r.userEmail ?? null,
					emailListSubscriberId: r.emailListSubscriberId ?? null,
					createdAt: r.createdAt ? String(r.createdAt) : '',
				}
			})

			const queryTimeMs = Date.now() - startMs

			return NextResponse.json(
				{
					ok: true,
					endpoint: `/api/analytics/surveys/${slugOrId}`,
					range,
					survey: {
						surveyId,
						surveyTitle,
						surveySlug,
					},
					summary: {
						totalResponses: Number(totalResponses),
						uniqueRespondents: Number(uniqueRespondents),
						questionCount: questionMap.size,
					},
					responsesByDay: responsesByDay.map((r: any) => ({
						date: String(r.date),
						responses: r.responses,
					})),
					questionBreakdown,
					responses,
					meta: {
						queryTimeMs,
						totalRows: responses.length,
						truncated: responses.length >= limit,
					},
					next_actions: [
						{
							command: 'GET /api/analytics/surveys',
							description: 'Back to survey list',
						},
						{
							command: `GET /api/analytics?surface=surveys/responses&range=${range}`,
							description: 'All responses across all surveys (flat rows)',
						},
						{
							command: `GET /api/analytics?surface=correlation/survey-revenue&range=${range}`,
							description: 'Survey → purchase correlation',
						},
					],
				},
				{ headers: corsHeaders },
			)
		} catch (error) {
			await log.error('api.analytics.surveys.detail.failed', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				slugOrId,
			})
			return NextResponse.json(
				{
					ok: false,
					endpoint: `/api/analytics/surveys/${slugOrId}`,
					error: { message: 'Internal server error', code: 'QUERY_FAILED' },
				},
				{ status: 500, headers: corsHeaders },
			)
		}
	},
)
