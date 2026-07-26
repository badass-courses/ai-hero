import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
} from '@/db/schema'
import {
	quizRespondentKey,
	QuizAnswerInputSchema,
	QuizQuestionNotFoundError,
	submitQuizAnswer,
} from '@/lib/quiz/answer'
import { log } from '@/server/logger'
import { createTRPCRouter, protectedProcedure } from '@/trpc/api/trpc'
import { TRPCError } from '@trpc/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

const CorrectAnswerSchema = z.union([
	z.string().trim().min(1),
	z.array(z.string().trim().min(1)).min(1),
])

/**
 * Trace one mutation end to end with the answerAttemptId returned to the client:
 * joelclaw otel search '<answerAttemptId>' -h 1 -n 50
 */
export const quizRouter = createTRPCRouter({
	answer: protectedProcedure
		.input(QuizAnswerInputSchema)
		.mutation(async ({ ctx, input }) => {
			const answerAttemptId = randomUUID()
			try {
				return await submitQuizAnswer(input, answerAttemptId, {
					resolveIdentity: async () => {
						const userId = ctx.session.user.id
						return {
							respondentKey: quizRespondentKey(userId),
							surveySessionId: null,
							userId,
							emailListSubscriberId: null,
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
