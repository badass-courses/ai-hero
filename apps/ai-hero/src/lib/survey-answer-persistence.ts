import { contentResource, questionResponse } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'

import { createInternalId } from './internal-id'
import { withMysqlPrimaryKeyRetry } from './mysql-primary-key-retry'

type SurveyAnswerLogger = {
	info(event: string, data: Record<string, unknown>): unknown
}

type PersistSurveyAnswersInput = {
	database: any
	logger: SurveyAnswerLogger
	surveySlug: string
	answers: Record<string, unknown>
	userId: string | null
	emailListSubscriberId: string | null
	eventPrefix?: 'survey.answer' | 'survey.answers'
}

export async function persistSurveyAnswers(input: PersistSurveyAnswersInput) {
	const eventPrefix = input.eventPrefix ?? 'survey.answers'
	const answers = Object.entries(input.answers).flatMap(
		([questionSlug, value]) => {
			if (value === null || value === undefined) return []
			const answer = Array.isArray(value) ? value.join(', ') : String(value)
			return answer.trim() ? [{ questionSlug, answer }] : []
		},
	)

	if (answers.length === 0) {
		await input.logger.info('survey.answers.skipped.empty', {
			surveySlug: input.surveySlug,
			userId: input.userId,
			emailListSubscriberId: input.emailListSubscriberId,
		})
		return { answerCount: 0 }
	}

	const survey = await input.database.query.contentResource.findFirst({
		where: and(
			eq(contentResource.type, 'survey'),
			sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') = ${input.surveySlug}`,
		),
	})
	const surveyId = survey?.id || input.surveySlug
	const questionSlugs = answers.map(({ questionSlug }) => questionSlug)
	const questions = await input.database.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'question'),
			sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') IN (${sql.join(
				questionSlugs.map((slug) => sql`${slug}`),
				sql`, `,
			)})`,
		),
	})
	const slugToIdMap = new Map<string, string>()
	for (const question of questions) {
		const fields = question.fields as { slug?: string }
		if (fields.slug) slugToIdMap.set(fields.slug, question.id)
	}
	const missingQuestionSlugs = questionSlugs.filter(
		(slug) => !slugToIdMap.has(slug),
	)
	const singleAnswer = answers.length === 1 ? answers[0] : undefined
	const resolvedQuestionId = singleAnswer
		? slugToIdMap.get(singleAnswer.questionSlug) || singleAnswer.questionSlug
		: undefined

	await input.logger.info(`${eventPrefix}.lookup`, {
		surveySlug: input.surveySlug,
		resolvedSurveyId: surveyId,
		questionLookupCount: questions.length,
		missingQuestionSlugs,
		...(singleAnswer
			? {
					questionSlug: singleAnswer.questionSlug,
					resolvedQuestionId,
					usedSurveySlugFallback: !survey?.id,
					usedQuestionSlugFallback: !slugToIdMap.has(
						singleAnswer.questionSlug,
					),
				}
			: {}),
		userId: input.userId,
		emailListSubscriberId: input.emailListSubscriberId,
	})

	await withMysqlPrimaryKeyRetry(async () => {
		const now = new Date()
		await input.database.insert(questionResponse).values(
			answers.map(({ questionSlug, answer }) => ({
				id: createInternalId(),
				surveyId,
				questionId: slugToIdMap.get(questionSlug) || questionSlug,
				userId: input.userId,
				emailListSubscriberId: input.emailListSubscriberId,
				fields: { answer },
				createdAt: now,
				updatedAt: now,
			})),
		)
	})

	await input.logger.info(`${eventPrefix}.saved`, {
		surveyId,
		surveySlug: input.surveySlug,
		userId: input.userId,
		emailListSubscriberId: input.emailListSubscriberId,
		answerCount: answers.length,
		...(singleAnswer
			? {
					questionSlug: singleAnswer.questionSlug,
					questionId: resolvedQuestionId,
				}
			: {}),
	})

	return { answerCount: answers.length }
}
