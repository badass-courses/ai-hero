import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
} from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { ChevronLeft } from 'lucide-react'

import { Button } from '@coursebuilder/ui'

export default async function AnalyticsSurveysPage() {
	const { ability, session } = await getServerAuthSession()
	const canView =
		ability.can('manage', 'all') || ability.can('view', 'Analytics')

	if (!canView) {
		notFound()
	}

	return (
		<main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-3 py-6 sm:px-4 sm:py-10">
			<div className="flex items-center gap-4">
				<Button variant="ghost" size="sm" asChild className="px-2">
					<Link href="/admin/analytics">
						<ChevronLeft className="mr-1 size-4" />
						Analytics
					</Link>
				</Button>
			</div>
			<div>
				<h1 className="text-xl font-bold tracking-tight sm:text-2xl">
					Survey Analytics
				</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					All surveys with response counts — click to drill in
				</p>
			</div>
			<Suspense
				fallback={
					<div className="text-muted-foreground py-10 text-center text-sm">
						Loading surveys…
					</div>
				}
			>
				<SurveysList />
			</Suspense>
		</main>
	)
}

async function SurveysList() {
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
			eq(questionResponse.surveyId, contentResource.id),
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

	if (surveys.length === 0) {
		return (
			<div className="text-muted-foreground py-10 text-center text-sm">
				No surveys found.
			</div>
		)
	}

	return (
		<div className="divide-border rounded-lg border">
			<div className="bg-muted/40 grid grid-cols-[1fr_80px_80px_80px_80px] gap-3 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider">
				<span>Survey</span>
				<span className="text-right">Questions</span>
				<span className="text-right">Responses</span>
				<span className="text-right">Respondents</span>
				<span className="text-right">State</span>
			</div>
			{surveys.map((s: any) => (
				<Link
					key={s.surveyId}
					href={`/admin/analytics/surveys/${s.surveyId}`}
					className="hover:bg-muted/30 grid grid-cols-[1fr_80px_80px_80px_80px] gap-3 border-t px-4 py-3 transition-colors"
				>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium">
							{s.surveyTitle || 'Untitled'}
						</p>
						<p className="text-muted-foreground mt-0.5 truncate text-xs">
							{s.surveySlug}
						</p>
					</div>
					<span className="text-muted-foreground self-center text-right text-sm tabular-nums">
						{qMap.get(s.surveyId) ?? 0}
					</span>
					<span className="self-center text-right text-sm font-semibold tabular-nums">
						{s.responses}
					</span>
					<span className="text-muted-foreground self-center text-right text-sm tabular-nums">
						{s.uniqueRespondents}
					</span>
					<span className="self-center text-right">
						<span
							className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
								s.state === 'published'
									? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
									: 'bg-muted text-muted-foreground'
							}`}
						>
							{s.state || 'draft'}
						</span>
					</span>
				</Link>
			))}
		</div>
	)
}
