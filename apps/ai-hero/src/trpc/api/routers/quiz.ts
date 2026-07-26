import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
} from '@/db/schema'
import {
	getOrCreateQuizSessionId,
	quizRespondentKey,
	QuizAnswerInputSchema,
	QuizQuestionNotFoundError,
	submitQuizAnswer,
} from '@/lib/quiz/answer'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'
import { TRPCError } from '@trpc/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

const QUIZ_SESSION_COOKIE = 'quiz_survey_session_id'
const CorrectAnswerSchema = z.union([
	z.string().trim().min(1),
	z.array(z.string().trim().min(1)).min(1),
])

/**
 * Trace one mutation end to end with the answerAttemptId returned to the client:
 * joelclaw otel search '<answerAttemptId>' -h 1 -n 50
 */
export const quizRouter = createTRPCRouter({
	answer: publicProcedure
		.input(QuizAnswerInputSchema)
		.mutation(async ({ ctx, input }) => {
			const answerAttemptId = randomUUID()
			try {
				return await submitQuizAnswer(input, answerAttemptId, {
					resolveIdentity: async () => {
						const cookieStore = await cookies()
						const surveySessionId = getOrCreateQuizSessionId(
							cookieStore,
							QUIZ_SESSION_COOKIE,
							randomUUID,
						)
						const convertkitId = cookieStore.get('ck_subscriber_id')?.value
						const subscriberCookie = cookieStore.get('ck_subscriber')?.value
						const normalizedConvertkitId = (() => {
							if (!convertkitId) return null
							try {
								return String(JSON.parse(convertkitId))
							} catch {
								return convertkitId
							}
						})()
						let subscriberCookieId: string | null = null

						if (!normalizedConvertkitId && subscriberCookie) {
							try {
								subscriberCookieId = SubscriberSchema.parse(
									JSON.parse(subscriberCookie),
								).id.toString()
							} catch (error) {
								await log.error('quiz.answer.subscriber-cookie.failed', {
									answerAttemptId,
									lessonId: input.lessonId,
									authoredQuestionId: input.questionId,
									error: error instanceof Error ? error.message : String(error),
								})
							}
						}

						const userId = ctx.session?.user?.id ?? null
						const emailListSubscriberId =
							normalizedConvertkitId ?? subscriberCookieId

						return {
							respondentKey: quizRespondentKey(userId, surveySessionId),
							surveySessionId,
							userId,
							emailListSubscriberId,
						}
					},
					findQuestion: async ({ lessonId, authoredQuestionId }) => {
						const rows = await db
							.select({
								id: contentResource.id,
								fields: contentResource.fields,
							})
							.from(contentResource)
							.innerJoin(
								contentResourceResource,
								and(
									eq(contentResourceResource.resourceId, contentResource.id),
									eq(contentResourceResource.resourceOfId, lessonId),
									isNull(contentResourceResource.deletedAt),
								),
							)
							.where(
								and(
									eq(contentResource.type, 'question'),
									isNull(contentResource.deletedAt),
									sql`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.courseSync.sourceQuestionId')) = ${authoredQuestionId}`,
								),
							)
							.limit(1)

						const question = rows[0]
						if (!question) return null
						const correct = CorrectAnswerSchema.parse(
							(question.fields as Record<string, unknown> | null)?.correct,
						)
						return { id: question.id, correct }
					},
					upsertResponse: async (record) => {
						await db
							.insert(questionResponse)
							.values(record)
							.onDuplicateKeyUpdate({
								set: {
									fields: record.fields,
									userId: sql`COALESCE(VALUES(${questionResponse.userId}), ${questionResponse.userId})`,
									emailListSubscriberId: sql`COALESCE(VALUES(${questionResponse.emailListSubscriberId}), ${questionResponse.emailListSubscriberId})`,
									surveySessionId: record.surveySessionId,
									updatedAt: record.updatedAt,
									deletedAt: null,
								},
							})
					},
					newId: randomUUID,
					now: () => new Date(),
					log,
				})
			} catch (error) {
				if (error instanceof QuizQuestionNotFoundError) {
					throw new TRPCError({ code: 'NOT_FOUND', message: error.message })
				}
				throw error
			}
		}),
})
