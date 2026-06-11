import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	purchases,
	questionResponse,
	users,
} from '@/db/schema'
import { and, count, desc, eq, gte, inArray, min, sql, sum } from 'drizzle-orm'

import { createDerivedProvider } from '@coursebuilder/analytics/providers/derived'

import type {
	AnalyticsRange,
	ProductSurveyRevenueCorrelation,
	SurveyConversionByQuestion,
	SurveyRevenueCorrelation,
	YouTubeRevenueCorrelation,
} from '../types'
import database from './database'
import ga4, { getSessionsByDay } from './ga4'
import { getChannelTimeseries } from './youtube'

const sharedDerived = createDerivedProvider({ database, ga4 })

export const { getTrafficRevenueCorrelation } = sharedDerived

// ─── AI Hero-specific helpers ────────────────────────────────────────────────

const PAID_STATUSES = ['Valid', 'Restricted'] as const

function rangeToDate(range: AnalyticsRange): Date | null {
	if (range === 'all') return null
	const hours: Record<string, number> = {
		'24h': 24,
		'7d': 7 * 24,
		'30d': 30 * 24,
		'90d': 90 * 24,
	}
	return new Date(Date.now() - (hours[range] ?? 30 * 24) * 60 * 60 * 1000)
}

function toYouTubeRange(range: AnalyticsRange): '24h' | '7d' | '30d' | '90d' {
	if (range === 'all') return '90d'
	return range
}

function toGA4Range(range: AnalyticsRange): '24h' | '7d' | '30d' | '90d' {
	if (range === 'all') return '90d'
	return range
}

export async function getSurveyRevenueCorrelation(
	range: AnalyticsRange,
	limit = 20,
): Promise<SurveyRevenueCorrelation> {
	const since = rangeToDate(range)

	// 1. Get all survey respondent userIds in the range
	const responseConditions = []
	if (since) responseConditions.push(gte(questionResponse.createdAt, since))

	const respondentRows = await db
		.selectDistinct({ userId: questionResponse.userId })
		.from(questionResponse)
		.where(
			responseConditions.length > 0
				? and(
						...responseConditions,
						sql`${questionResponse.userId} IS NOT NULL`,
					)
				: sql`${questionResponse.userId} IS NOT NULL`,
		)

	const respondentUserIds = respondentRows
		.map((r) => r.userId)
		.filter((id): id is string => id !== null)

	const totalRespondents = respondentUserIds.length

	if (totalRespondents === 0) {
		// Baseline: even with no respondents, compute baseline conversion rate
		const [totalUsersResult] = await db.select({ count: count() }).from(users)
		const totalUserCount = totalUsersResult?.count ?? 0

		const [baselinePurchasersResult] = await db
			.select({
				count: sql<number>`COUNT(DISTINCT ${purchases.userId})`,
			})
			.from(purchases)
			.where(inArray(purchases.status, [...PAID_STATUSES]))
		const baselinePurchaserCount = Number(baselinePurchasersResult?.count ?? 0)

		return {
			totalRespondents: 0 as any,
			respondentsWhoPurchased: 0 as any,
			overallConversionRate: 0 as any,
			totalRevenueFromRespondents: 0 as any,
			prePurchaseRespondents: 0 as any,
			postPurchaseRespondents: 0 as any,
			neverPurchasedRespondents: 0 as any,
			baselineConversionRate: (totalUserCount > 0
				? baselinePurchaserCount / totalUserCount
				: 0) as any,
			byQuestion: [],
		}
	}

	// 2. Find which respondents purchased (any time, not range-limited)
	const purchaserRows = await db
		.selectDistinct({ userId: purchases.userId })
		.from(purchases)
		.where(
			and(
				inArray(purchases.status, [...PAID_STATUSES]),
				sql`${purchases.userId} IN (${sql.join(
					respondentUserIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			),
		)

	const purchaserIds = new Set(purchaserRows.map((r) => r.userId))
	const respondentsWhoPurchased = purchaserIds.size

	// 3. Total revenue from respondents
	const [revResult] = await db
		.select({ total: sum(purchases.totalAmount) })
		.from(purchases)
		.where(
			and(
				inArray(purchases.status, [...PAID_STATUSES]),
				sql`${purchases.userId} IN (${sql.join(
					respondentUserIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			),
		)
	const totalRevenueFromRespondents = Number(revResult?.total ?? 0)

	// 4. Fetch earliest purchase date per respondent-purchaser for pre/post timing
	const earliestPurchaseMap = new Map<string, Date>()
	if (purchaserIds.size > 0) {
		const earliestRows = await db
			.select({
				userId: purchases.userId,
				earliest: min(purchases.createdAt),
			})
			.from(purchases)
			.where(
				and(
					inArray(purchases.status, [...PAID_STATUSES]),
					sql`${purchases.userId} IN (${sql.join(
						[...purchaserIds].map((id) => sql`${id}`),
						sql`, `,
					)})`,
				),
			)
			.groupBy(purchases.userId)

		for (const r of earliestRows) {
			if (r.userId && r.earliest) {
				earliestPurchaseMap.set(r.userId, r.earliest)
			}
		}
	}

	// 5. Fetch earliest response date per respondent for top-level pre/post classification
	const earliestResponseMap = new Map<string, Date>()
	{
		const earliestResponseRows = await db
			.select({
				userId: questionResponse.userId,
				earliest: min(questionResponse.createdAt),
			})
			.from(questionResponse)
			.where(
				responseConditions.length > 0
					? and(
							...responseConditions,
							sql`${questionResponse.userId} IS NOT NULL`,
						)
					: sql`${questionResponse.userId} IS NOT NULL`,
			)
			.groupBy(questionResponse.userId)

		for (const r of earliestResponseRows) {
			if (r.userId && r.earliest) {
				earliestResponseMap.set(r.userId, r.earliest)
			}
		}
	}

	// Classify respondents into pre/post/never at top level
	let prePurchaseRespondents = 0
	let postPurchaseRespondents = 0
	let neverPurchasedRespondents = 0

	for (const userId of respondentUserIds) {
		const earliestPurchase = earliestPurchaseMap.get(userId)
		const earliestResponse = earliestResponseMap.get(userId)
		if (!earliestPurchase) {
			neverPurchasedRespondents++
		} else if (earliestResponse && earliestResponse < earliestPurchase) {
			prePurchaseRespondents++
		} else {
			postPurchaseRespondents++
		}
	}

	// 6. Baseline conversion rate (non-respondent users)
	const [totalUsersResult] = await db.select({ count: count() }).from(users)
	const totalUserCount = totalUsersResult?.count ?? 0
	const nonRespondentCount = totalUserCount - totalRespondents

	let baselineConversionRate = 0
	if (nonRespondentCount > 0) {
		const [nonRespondentPurchasersResult] = await db
			.select({
				count: sql<number>`COUNT(DISTINCT ${purchases.userId})`,
			})
			.from(purchases)
			.where(
				and(
					inArray(purchases.status, [...PAID_STATUSES]),
					sql`${purchases.userId} NOT IN (${sql.join(
						respondentUserIds.map((id) => sql`${id}`),
						sql`, `,
					)})`,
				),
			)
		const nonRespondentPurchaserCount = Number(
			nonRespondentPurchasersResult?.count ?? 0,
		)
		baselineConversionRate = nonRespondentPurchaserCount / nonRespondentCount
	}

	// 7. Per-question/answer breakdown with timing
	const answerRows = await db
		.select({
			questionId: questionResponse.questionId,
			answer:
				sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${questionResponse.fields}, '$.answer'))`.as(
					'answer',
				),
			userId: questionResponse.userId,
			createdAt: questionResponse.createdAt,
		})
		.from(questionResponse)
		.where(
			responseConditions.length > 0
				? and(
						...responseConditions,
						sql`${questionResponse.userId} IS NOT NULL`,
					)
				: sql`${questionResponse.userId} IS NOT NULL`,
		)

	// Get question metadata (title, type) — filter out free-text questions
	const questionIds = [...new Set(answerRows.map((r) => r.questionId))]
	const questionTitles = new Map<string, string>()
	const questionTypes = new Map<string, string>()
	if (questionIds.length > 0) {
		const metaRows = await db
			.select({
				id: contentResource.id,
				question:
					sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.question'))`.as(
						'question',
					),
				title:
					sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`.as(
						'title',
					),
				qtype:
					sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.type'))`.as(
						'qtype',
					),
			})
			.from(contentResource)
			.where(
				sql`${contentResource.id} IN (${sql.join(
					questionIds.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			)

		for (const r of metaRows) {
			const label = r.question || r.title
			if (label) questionTitles.set(r.id, label)
			if (r.qtype) questionTypes.set(r.id, r.qtype)
		}
	}

	// Only include choice-based questions (exclude free-text / essay types)
	const freeTextTypes = new Set([
		'text',
		'essay',
		'textarea',
		'short-answer',
		'long-answer',
	])
	const choiceQuestionIds = new Set(
		questionIds.filter((id) => {
			const t = questionTypes.get(id)
			return !t || !freeTextTypes.has(t)
		}),
	)

	const byQuestionAnswer = new Map<
		string,
		{
			questionId: string
			answer: string
			respondents: Set<string>
			purchasers: Set<string>
			prePurchase: Set<string>
			postPurchase: Set<string>
		}
	>()

	for (const row of answerRows) {
		if (!row.userId || !row.answer) continue
		if (!choiceQuestionIds.has(row.questionId)) continue
		const answer = row.answer

		const key = `${row.questionId}::${answer}`
		const existing = byQuestionAnswer.get(key) ?? {
			questionId: row.questionId,
			answer,
			respondents: new Set<string>(),
			purchasers: new Set<string>(),
			prePurchase: new Set<string>(),
			postPurchase: new Set<string>(),
		}
		existing.respondents.add(row.userId)
		if (purchaserIds.has(row.userId)) {
			existing.purchasers.add(row.userId)

			const earliestPurchase = earliestPurchaseMap.get(row.userId)
			if (
				earliestPurchase &&
				row.createdAt &&
				row.createdAt < earliestPurchase
			) {
				existing.prePurchase.add(row.userId)
			} else {
				existing.postPurchase.add(row.userId)
			}
		}
		byQuestionAnswer.set(key, existing)
	}

	// Get revenue per purchaser for breakdown
	const purchaserRevenue = new Map<string, number>()
	if (purchaserIds.size > 0) {
		const revRows = await db
			.select({
				userId: purchases.userId,
				revenue: sum(purchases.totalAmount),
			})
			.from(purchases)
			.where(
				and(
					inArray(purchases.status, [...PAID_STATUSES]),
					sql`${purchases.userId} IN (${sql.join(
						[...purchaserIds].map((id) => sql`${id}`),
						sql`, `,
					)})`,
				),
			)
			.groupBy(purchases.userId)

		for (const r of revRows) {
			if (r.userId) purchaserRevenue.set(r.userId, Number(r.revenue ?? 0))
		}
	}

	const byQuestion: SurveyConversionByQuestion[] = [
		...byQuestionAnswer.values(),
	]
		.map((entry) => {
			const revenue = [...entry.purchasers].reduce(
				(sum, uid) => sum + (purchaserRevenue.get(uid) ?? 0),
				0,
			)
			return {
				questionId: entry.questionId,
				questionTitle: questionTitles.get(entry.questionId) ?? null,
				answer: entry.answer,
				respondents: entry.respondents.size,
				purchasers: entry.purchasers.size,
				conversionRate:
					entry.respondents.size > 0
						? entry.purchasers.size / entry.respondents.size
						: 0,
				revenue,
				prePurchaseCount: entry.prePurchase.size,
				postPurchaseCount: entry.postPurchase.size,
			} as SurveyConversionByQuestion
		})
		.filter((row) => row.purchasers > 0)
		.sort((a, b) => {
			const qCmp = (a.questionTitle ?? a.questionId).localeCompare(
				b.questionTitle ?? b.questionId,
			)
			if (qCmp !== 0) return qCmp
			return b.respondents - a.respondents
		})
		.slice(0, limit)

	return {
		totalRespondents: totalRespondents as any,
		respondentsWhoPurchased: respondentsWhoPurchased as any,
		overallConversionRate: (totalRespondents > 0
			? respondentsWhoPurchased / totalRespondents
			: 0) as any,
		totalRevenueFromRespondents: totalRevenueFromRespondents as any,
		prePurchaseRespondents: prePurchaseRespondents as any,
		postPurchaseRespondents: postPurchaseRespondents as any,
		neverPurchasedRespondents: neverPurchasedRespondents as any,
		baselineConversionRate: baselineConversionRate as any,
		byQuestion,
	}
}

function normalizeRespondentKey(row: {
	respondentKey: string | null
	userId: string | null
	emailListSubscriberId: string | null
	surveySessionId: string | null
}) {
	if (row.respondentKey) return row.respondentKey
	if (row.userId) return `user:${row.userId}`
	if (row.emailListSubscriberId)
		return `subscriber:${row.emailListSubscriberId}`
	if (row.surveySessionId) return `session:${row.surveySessionId}`
	return null
}

export async function getProductSurveyRevenueCorrelation(
	range: AnalyticsRange,
	limit = 20,
	filters: {
		productId?: string
		surveyId?: string
		surveySlug?: string
		questionId?: string
	} = {},
): Promise<ProductSurveyRevenueCorrelation> {
	const since = rangeToDate(range)
	const responseConditions = []
	if (since) responseConditions.push(gte(questionResponse.createdAt, since))
	if (filters.surveyId)
		responseConditions.push(eq(questionResponse.surveyId, filters.surveyId))
	if (filters.questionId)
		responseConditions.push(eq(questionResponse.questionId, filters.questionId))
	if (filters.surveySlug) {
		responseConditions.push(
			sql`JSON_UNQUOTE(JSON_EXTRACT(survey_cr.fields, '$.slug')) = ${filters.surveySlug}`,
		)
	}

	const rawRows = await db
		.select({
			responseId: questionResponse.id,
			surveyId: questionResponse.surveyId,
			surveyTitle: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(survey_cr.fields, '$.title'))`,
			surveySlug: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(survey_cr.fields, '$.slug'))`,
			questionId: questionResponse.questionId,
			questionText: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(question_cr.fields, '$.question'))`,
			questionType: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(question_cr.fields, '$.type'))`,
			answer:
				sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${questionResponse.fields}, '$.answer'))`.as(
					'answer',
				),
			respondentKey: questionResponse.respondentKey,
			surveySessionId: questionResponse.surveySessionId,
			userId: questionResponse.userId,
			emailListSubscriberId: questionResponse.emailListSubscriberId,
			createdAt: questionResponse.createdAt,
			updatedAt: questionResponse.updatedAt,
		})
		.from(questionResponse)
		.leftJoin(
			sql`${contentResource} AS survey_cr`,
			sql`survey_cr.id = ${questionResponse.surveyId}`,
		)
		.leftJoin(
			sql`${contentResource} AS question_cr`,
			sql`question_cr.id = ${questionResponse.questionId}`,
		)
		.where(
			responseConditions.length > 0 ? and(...responseConditions) : undefined,
		)

	const latestByAnswer = new Map<
		string,
		(typeof rawRows)[number] & { normalizedRespondentKey: string }
	>()
	for (const row of rawRows) {
		const normalizedRespondentKey = normalizeRespondentKey(row)
		if (!normalizedRespondentKey) continue
		const key = `${row.surveyId}::${row.questionId}::${normalizedRespondentKey}`
		const current = latestByAnswer.get(key)
		const rowTime = new Date(row.updatedAt ?? row.createdAt ?? 0).getTime()
		const currentTime = current
			? new Date(current.updatedAt ?? current.createdAt ?? 0).getTime()
			: -1
		if (!current || rowTime >= currentTime) {
			latestByAnswer.set(key, { ...row, normalizedRespondentKey })
		}
	}

	const canonicalRows = [...latestByAnswer.values()]
	const respondentKeys = new Set(
		canonicalRows.map((row) => row.normalizedRespondentKey),
	)
	const respondentUserIds = [
		...new Set(
			canonicalRows
				.map((row) => row.userId)
				.filter((userId): userId is string => Boolean(userId)),
		),
	]

	const purchaseByUser = new Map<string, { revenue: number; count: number }>()
	if (respondentUserIds.length > 0) {
		const purchaseConditions = [
			inArray(purchases.status, [...PAID_STATUSES]),
			sql`${purchases.totalAmount} > 0`,
			sql`${purchases.userId} IN (${sql.join(
				respondentUserIds.map((id) => sql`${id}`),
				sql`, `,
			)})`,
		]
		if (filters.productId)
			purchaseConditions.push(eq(purchases.productId, filters.productId))
		if (since) purchaseConditions.push(gte(purchases.createdAt, since))

		const purchaseRows = await db
			.select({
				userId: purchases.userId,
				count: count(),
				revenue: sum(purchases.totalAmount),
			})
			.from(purchases)
			.where(and(...purchaseConditions))
			.groupBy(purchases.userId)

		for (const row of purchaseRows) {
			if (!row.userId) continue
			purchaseByUser.set(row.userId, {
				count: row.count,
				revenue: Number(row.revenue ?? 0),
			})
		}
	}

	const byAnswer = new Map<
		string,
		{
			surveyId: string
			surveyTitle: string | null
			surveySlug: string | null
			questionId: string
			question: string | null
			answer: string
			respondents: Set<string>
			respondentUserIds: Set<string>
			purchasers: Set<string>
		}
	>()

	for (const row of canonicalRows) {
		const answer = row.answer || '(no answer)'
		const key = `${row.surveyId}::${row.questionId}::${answer}`
		const entry = byAnswer.get(key) ?? {
			surveyId: row.surveyId,
			surveyTitle: row.surveyTitle ?? null,
			surveySlug: row.surveySlug ?? null,
			questionId: row.questionId,
			question: row.questionText ?? null,
			answer,
			respondents: new Set<string>(),
			respondentUserIds: new Set<string>(),
			purchasers: new Set<string>(),
		}
		entry.respondents.add(row.normalizedRespondentKey)
		if (row.userId) entry.respondentUserIds.add(row.userId)
		if (row.userId && purchaseByUser.has(row.userId)) {
			entry.purchasers.add(row.userId)
		}
		byAnswer.set(key, entry)
	}

	const paidPurchaserUserIds = new Set(purchaseByUser.keys())
	const paidRevenue = [...purchaseByUser.values()].reduce(
		(sum, row) => sum + row.revenue,
		0,
	)

	return {
		productId: filters.productId ?? null,
		surveyId: filters.surveyId ?? null,
		surveySlug: filters.surveySlug ?? null,
		totalResponses: canonicalRows.length as any,
		uniqueRespondents: respondentKeys.size as any,
		respondentsWithUserId: respondentUserIds.length as any,
		paidPurchasers: paidPurchaserUserIds.size as any,
		paidRevenue: paidRevenue as any,
		byAnswer: [...byAnswer.values()]
			.map((entry) => {
				const entryRevenue = [...entry.purchasers].reduce(
					(total, userId) => total + (purchaseByUser.get(userId)?.revenue ?? 0),
					0,
				)
				return {
					surveyId: entry.surveyId,
					surveyTitle: entry.surveyTitle,
					surveySlug: entry.surveySlug,
					questionId: entry.questionId,
					question: entry.question,
					answer: entry.answer,
					responses: entry.respondents.size as any,
					uniqueRespondents: entry.respondents.size as any,
					respondentsWithUserId: entry.respondentUserIds.size as any,
					paidPurchasers: entry.purchasers.size as any,
					paidRevenue: entryRevenue as any,
					conversionRate:
						entry.respondents.size > 0
							? ((entry.purchasers.size / entry.respondents.size) as any)
							: (0 as any),
				}
			})
			.filter((row) => row.paidPurchasers > 0)
			.sort(
				(a, b) => b.paidRevenue - a.paidRevenue || b.responses - a.responses,
			)
			.slice(0, limit),
	}
}

export async function getYouTubeRevenueCorrelation(
	range: AnalyticsRange,
): Promise<YouTubeRevenueCorrelation | null> {
	const [youtube, traffic, revenue] = await Promise.all([
		getChannelTimeseries(toYouTubeRange(range)),
		getSessionsByDay(toGA4Range(range)),
		database.getRevenueByDay(range),
	])

	if (youtube === null) return null

	return { youtube, traffic, revenue } as YouTubeRevenueCorrelation
}
