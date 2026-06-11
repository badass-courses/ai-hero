import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
	users,
} from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm'
import { ChevronLeft, DownloadIcon } from 'lucide-react'

import { Button } from '@coursebuilder/ui'

import { SurveyAnalyticsClient } from './_components/survey-analytics-client'

export default async function AnalyticsSurveyDetailPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>
	searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
	const { ability } = await getServerAuthSession()
	const canView =
		ability.can('manage', 'all') || ability.can('view', 'Analytics')

	if (!canView) {
		notFound()
	}

	const { id: slugOrId } = await params
	const sp = await searchParams
	const range = (
		['24h', '7d', '30d', '90d', 'all'].includes(sp.range as string)
			? sp.range
			: '30d'
	) as string

	const survey = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(sql`JSON_EXTRACT(${contentResource.fields}, "$.slug")`, slugOrId),
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
		notFound()
	}

	const surveyFields = (survey.fields || {}) as Record<string, unknown>
	const surveyTitle =
		typeof surveyFields.title === 'string'
			? surveyFields.title
			: 'Untitled Survey'

	return (
		<main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-3 py-6 sm:px-4 sm:py-10">
			<div className="flex items-center gap-4">
				<Button variant="ghost" size="sm" asChild className="px-2">
					<Link href="/admin/analytics/surveys">
						<ChevronLeft className="mr-1 size-4" />
						All Surveys
					</Link>
				</Button>
			</div>
			<div>
				<h1 className="text-xl font-bold tracking-tight sm:text-2xl">
					{surveyTitle}
				</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					Survey analytics — responses, question breakdown, and daily volume
				</p>
			</div>
			<Suspense
				fallback={
					<div className="text-muted-foreground py-10 text-center text-sm">
						Loading analytics…
					</div>
				}
			>
				<SurveyAnalyticsContent
					surveyId={survey.id}
					range={range}
					resources={survey.resources}
				/>
			</Suspense>
		</main>
	)
}

function rangeToInterval(range: string): string {
	switch (range) {
		case '24h':
			return '1 DAY'
		case '7d':
			return '7 DAY'
		case '90d':
			return '90 DAY'
		case 'all':
			return '3650 DAY'
		default:
			return '30 DAY'
	}
}

async function SurveyAnalyticsContent({
	surveyId,
	range,
	resources,
}: {
	surveyId: string
	range: string
	resources: any[] | null
}) {
	const interval = rangeToInterval(range)

	// Build question lookup
	const questionMap = new Map<
		string,
		{ question: string; type: string | null; slug: string | null }
	>()
	for (const rel of resources || []) {
		if (rel.resource.type !== 'question') continue
		const f = (rel.resource.fields || {}) as Record<string, unknown>
		questionMap.set(rel.resource.id, {
			question: typeof f.question === 'string' ? f.question : rel.resource.id,
			type: typeof f.type === 'string' ? f.type : null,
			slug: typeof f.slug === 'string' ? f.slug : null,
		})
	}

	// Summary
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

	// Responses by day
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

	// Question breakdown
	const topQuestionRows = await db
		.select({
			questionId: questionResponse.questionId,
			responses: sql<number>`COUNT(*)`,
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
				question: meta?.question ?? q.questionId,
				type: meta?.type ?? null,
				responses: Number(q.responses),
				answerDistribution: answers.map((a: any) => ({
					answer: a.answer ?? '(no answer)',
					count: a.count,
				})),
			}
		}),
	)

	// Individual responses
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
		.limit(500)

	const responses = responseRows.map((r: any) => {
		const meta = questionMap.get(r.questionId)
		return {
			responseId: r.responseId,
			question: meta?.question ?? r.questionId,
			questionType: meta?.type ?? null,
			answer: r.answer ?? '',
			userEmail: r.userEmail ?? null,
			emailListSubscriberId: r.emailListSubscriberId ?? null,
			createdAt: r.createdAt ? r.createdAt.toISOString() : '',
		}
	})

	return (
		<SurveyAnalyticsClient
			range={range}
			summary={{
				totalResponses: Number(totalResponses),
				uniqueRespondents: Number(uniqueRespondents),
				questionCount: questionMap.size,
			}}
			responsesByDay={responsesByDay.map((r: any) => ({
				date: String(r.date),
				responses: r.responses,
			}))}
			questionBreakdown={questionBreakdown}
			responses={responses}
		/>
	)
}
