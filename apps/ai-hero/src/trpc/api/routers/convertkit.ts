import { cookies } from 'next/headers'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
} from '@/db/schema'
import { getSubscriberFromCookie } from '@/lib/convertkit'
import { answerSurvey } from '@/lib/surveys-query'
import { SubscriberSchema } from '@/schemas/subscriber'
import { log } from '@/server/logger'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'
import type { AdapterUser } from '@auth/core/adapters'
import { format } from 'date-fns'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { toSnakeCase } from 'drizzle-orm/casing'
import { z } from 'zod'

import { guid } from '@coursebuilder/utils/guid'

export function formatDate(date: Date) {
	return format(date, 'yyyy-MM-dd HH:mm:ss z')
}

const CHECKOUT_SURVEY_SLUG = 'checkout-decision-source'
const CHECKOUT_SURVEY_ID = 'survey-checkout-decision-source'
const CHECKOUT_SURVEY_QUESTION_SLUG = 'what-helped-you-decide-to-join'
const CHECKOUT_SURVEY_QUESTION_ID = 'question-what-helped-you-decide-to-join'
const CHECKOUT_SURVEY_CHOICES = [
	{ answer: 'matts_youtube', label: "Matt's YouTube" },
	{ answer: 'matts_x', label: "Matt's X or Twitter" },
	{ answer: 'github', label: 'GitHub' },
	{ answer: 'google_search', label: 'Google search' },
	{ answer: 'podcast_newsletter', label: 'Podcast or newsletter' },
	{ answer: 'coworker_friend', label: 'Coworker or friend' },
	{ answer: 'email_announcement', label: 'Email announcement' },
	{ answer: 'other', label: 'Other' },
]

async function ensureCheckoutSurveyResources(createdById: string) {
	const existingSurvey = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.type, 'survey'),
			sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') = ${CHECKOUT_SURVEY_SLUG}`,
		),
	})

	const surveyId = existingSurvey?.id || CHECKOUT_SURVEY_ID

	if (!existingSurvey) {
		try {
			await db.insert(contentResource).values({
				id: CHECKOUT_SURVEY_ID,
				type: 'survey',
				createdById,
				fields: {
					title: 'Checkout decision source',
					slug: CHECKOUT_SURVEY_SLUG,
					state: 'published',
					visibility: 'unlisted',
				},
			})
		} catch (error) {
			await log.warn('checkout.survey.ensure.survey.insert.skipped', {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const existingQuestion = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.type, 'question'),
			sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') = ${CHECKOUT_SURVEY_QUESTION_SLUG}`,
		),
	})

	const questionId = existingQuestion?.id || CHECKOUT_SURVEY_QUESTION_ID

	if (!existingQuestion) {
		try {
			await db.insert(contentResource).values({
				id: CHECKOUT_SURVEY_QUESTION_ID,
				type: 'question',
				createdById,
				fields: {
					slug: CHECKOUT_SURVEY_QUESTION_SLUG,
					question: 'What helped you decide to join?',
					type: 'multiple-choice',
					choices: CHECKOUT_SURVEY_CHOICES,
					required: false,
					shuffleChoices: false,
					allowMultiple: false,
				},
			})
		} catch (error) {
			await log.warn('checkout.survey.ensure.question.insert.skipped', {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const existingRelation = await db.query.contentResourceResource.findFirst({
		where: and(
			eq(contentResourceResource.resourceOfId, surveyId),
			eq(contentResourceResource.resourceId, questionId),
		),
	})

	if (!existingRelation) {
		try {
			await db.insert(contentResourceResource).values({
				resourceOfId: surveyId,
				resourceId: questionId,
				position: 0,
				metadata: { source: 'checkout-survey-auto-ensure' },
			})
		} catch (error) {
			await log.warn('checkout.survey.ensure.relation.insert.skipped', {
				surveyId,
				questionId,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return { surveyId, questionId }
}

export const convertkitRouter = createTRPCRouter({
	answerSurveyMultiple: publicProcedure
		.input(
			z.object({
				answers: z.record(z.string(), z.any()),
				email: z.string().optional(),
				surveyId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const session = ctx.session
			const cookieStore = await cookies()
			const convertkitId = cookieStore.get('ck_subscriber_id')?.value
			const subscriberCookie = cookieStore.get('ck_subscriber')?.value

			await log.info('survey.submit.received', {
				surveySlug: input.surveyId,
				answerCount: Object.keys(input.answers).length,
				answerKeys: Object.keys(input.answers),
				hasSession: !!session,
				hasInputEmail: !!input.email,
				hasSubscriberIdCookie: !!convertkitId,
				hasSubscriberCookie: !!subscriberCookie,
			})

			let subscriber: z.infer<typeof SubscriberSchema> | null = null
			let subscriberSyncError: string | null = null
			const fields: Record<string, string> = {
				last_surveyed_on: formatDate(new Date()),
				...(input.surveyId && {
					[`completed_${toSnakeCase(input.surveyId)}_survey_on`]: formatDate(
						new Date(),
					),
				}),
			}

			for (const answer in input.answers) {
				const value = input.answers[answer]
				if (value === null || value === undefined) continue

				const stringValue = Array.isArray(value)
					? value.join(', ')
					: String(value)

				if (stringValue.trim()) {
					fields[answer] = stringValue
				}
			}

			try {
				if (convertkitId) {
					subscriber = SubscriberSchema.parse(
						await emailListProvider.getSubscriber(convertkitId),
					)
				} else if (subscriberCookie) {
					subscriber = SubscriberSchema.parse(JSON.parse(subscriberCookie))
				}

				if (!subscriber && input.email) {
					subscriber = await emailListProvider.subscribeToList({
						listId: process.env.CONVERTKIT_SIGNUP_FORM,
						user: (session?.user || { email: input.email }) as AdapterUser,
						fields,
						listType: 'form',
					})
				}
			} catch (error) {
				subscriberSyncError =
					error instanceof Error ? error.message : String(error)
				await log.error('survey.submit.subscriber.failed', {
					surveyId: input.surveyId,
					userId: session?.user?.id,
					email: input.email,
					error: subscriberSyncError,
				})
			}

			let userId = session?.user?.id || null
			const emailListSubscriberId = subscriber?.id?.toString() || null
			const identityEmail =
				subscriber?.email_address || session?.user?.email || input.email || null

			if (!userId && identityEmail) {
				const existingUser = await db.query.users.findFirst({
					where: (users, { eq }) => eq(users.email, identityEmail),
				})
				if (existingUser) {
					userId = existingUser.id
				}
			}

			await log.info('survey.answers.identity', {
				hasSession: !!session,
				userId,
				emailListSubscriberId,
				surveyId: input.surveyId,
				answerCount: Object.keys(input.answers).length,
				hasSubscriber: !!subscriber,
			})

			if (input.surveyId) {
				try {
					const survey = await db.query.contentResource.findFirst({
						where: and(
							eq(contentResource.type, 'survey'),
							sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') = ${input.surveyId}`,
						),
					})

					const surveyId = survey?.id || input.surveyId
					const questionSlugs = Object.keys(input.answers).filter(
						(slug) =>
							input.answers[slug] !== null && input.answers[slug] !== undefined,
					)

					const questions = await db.query.contentResource.findMany({
						where: and(
							eq(contentResource.type, 'question'),
							sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') IN (${sql.join(
								questionSlugs.map((slug) => sql`${slug}`),
								sql`, `,
							)})`,
						),
					})

					const slugToIdMap = new Map<string, string>()
					for (const q of questions) {
						const fields = q.fields as any
						if (fields.slug) {
							slugToIdMap.set(fields.slug, q.id)
						}
					}

					const missingQuestionSlugs = questionSlugs.filter(
						(slug) => !slugToIdMap.has(slug),
					)

					await log.info('survey.answers.lookup', {
						surveySlug: input.surveyId,
						resolvedSurveyId: surveyId,
						questionLookupCount: questions.length,
						missingQuestionSlugs,
						userId,
						emailListSubscriberId,
					})

					const answerRecords = Object.entries(input.answers)
						.filter(([_, value]) => value !== null && value !== undefined)
						.map(([questionSlug, value]) => {
							const answerValue = Array.isArray(value)
								? value.join(', ')
								: String(value)

							if (!answerValue.trim()) return null

							const questionId = slugToIdMap.get(questionSlug) || questionSlug

							return {
								id: guid(),
								surveyId,
								questionId,
								userId,
								emailListSubscriberId,
								fields: { answer: answerValue },
								createdAt: new Date(),
								updatedAt: new Date(),
							}
						})
						.filter(Boolean) as Array<{
						id: string
						surveyId: string
						questionId: string
						userId: string | null
						emailListSubscriberId: string | null
						fields: Record<string, any>
						createdAt: Date
						updatedAt: Date
					}>

					if (answerRecords.length > 0) {
						await db.insert(questionResponse).values(answerRecords)

						await log.info('survey.answers.saved', {
							surveyId,
							surveySlug: input.surveyId,
							userId,
							emailListSubscriberId,
							answerCount: answerRecords.length,
						})
					} else {
						await log.warn('survey.answers.skipped.empty', {
							surveySlug: input.surveyId,
							userId,
							emailListSubscriberId,
						})
					}
				} catch (error) {
					await log.error('survey.answers.save.failed', {
						error: error instanceof Error ? error.message : String(error),
						surveySlug: input.surveyId,
						userId,
					})
				}
			}

			if (!subscriber) {
				await log.warn('survey.submit.no.subscriber', {
					surveyId: input.surveyId,
					userId: session?.user?.id,
					email: input.email,
					subscriberSyncError,
				})
				return { success: true, storedInDb: true, subscriberSyncError }
			}

			try {
				let updatedSubscriber = await emailListProvider.getSubscriber(
					subscriber.id.toString(),
				)

				if (fields && emailListProvider?.updateSubscriberFields) {
					updatedSubscriber = await emailListProvider?.updateSubscriberFields?.(
						{
							fields,
							subscriberEmail: updatedSubscriber?.email_address,
							subscriberId: updatedSubscriber?.id,
						},
					)
				}

				return updatedSubscriber
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				await log.error('survey.submit.subscriber.update.failed', {
					surveyId: input.surveyId,
					userId,
					emailListSubscriberId,
					error: message,
				})
				return { success: true, storedInDb: true, subscriberSyncError: message }
			}
		}),
	/**
	 * Returns the saved checkout survey answer for the current browser identity.
	 *
	 * @remarks Resolves identity from the active session, ConvertKit subscriber
	 * cookies, and matching user email before reading local QuestionResponse rows.
	 *
	 * @returns `{ answered: boolean, answer: string | null }`.
	 */
	checkoutSurveyAnswer: publicProcedure.query(async ({ ctx }) => {
		const session = ctx.session
		const cookieStore = await cookies()
		const convertkitId = cookieStore.get('ck_subscriber_id')?.value
		const subscriberCookie = cookieStore.get('ck_subscriber')?.value

		let subscriber: z.infer<typeof SubscriberSchema> | null = null

		try {
			if (convertkitId) {
				subscriber = SubscriberSchema.parse(
					await emailListProvider.getSubscriber(convertkitId),
				)
			} else if (subscriberCookie) {
				subscriber = SubscriberSchema.parse(JSON.parse(subscriberCookie))
			}
		} catch (error) {
			await log.warn('checkout.survey.answer.lookup.subscriber.failed', {
				error: error instanceof Error ? error.message : String(error),
			})
		}

		let userId = session?.user?.id || null
		const emailListSubscriberId = subscriber?.id?.toString() || null
		const sessionEmail = session?.user?.email || null

		if (!userId && sessionEmail) {
			const existingUser = await db.query.users.findFirst({
				where: (users, { eq }) => eq(users.email, sessionEmail),
			})
			if (existingUser) {
				userId = existingUser.id
			}
		}

		const identityCondition = userId
			? eq(questionResponse.userId, userId)
			: emailListSubscriberId
				? eq(questionResponse.emailListSubscriberId, emailListSubscriberId)
				: null

		if (!identityCondition) {
			return { answered: false, answer: null }
		}

		const response = await db.query.questionResponse.findFirst({
			where: and(
				inArray(questionResponse.surveyId, [
					CHECKOUT_SURVEY_ID,
					CHECKOUT_SURVEY_SLUG,
				]),
				inArray(questionResponse.questionId, [
					CHECKOUT_SURVEY_QUESTION_ID,
					CHECKOUT_SURVEY_QUESTION_SLUG,
				]),
				isNull(questionResponse.deletedAt),
				identityCondition,
			),
			orderBy: desc(questionResponse.createdAt),
		})

		const answer =
			typeof response?.fields?.answer === 'string'
				? response.fields.answer
				: null

		return { answered: Boolean(answer), answer }
	}),
	answerSurvey: publicProcedure
		.input(
			z.object({
				question: z.string(),
				answer: z.string(),
				surveyId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const session = ctx.session
			const cookieStore = await cookies()
			const convertkitId = cookieStore.get('ck_subscriber_id')?.value
			const subscriberCookie = cookieStore.get('ck_subscriber')?.value

			await log.info('survey.answer.received', {
				surveySlug: input.surveyId,
				questionSlug: input.question,
				answerLength: input.answer.length,
				hasSession: !!session,
				hasSubscriberIdCookie: !!convertkitId,
				hasSubscriberCookie: !!subscriberCookie,
			})

			let subscriber: z.infer<typeof SubscriberSchema> | null = null
			let subscriberLookupError: string | null = null

			try {
				if (convertkitId) {
					subscriber = SubscriberSchema.parse(
						await emailListProvider.getSubscriber(convertkitId),
					)
				} else if (subscriberCookie) {
					subscriber = SubscriberSchema.parse(JSON.parse(subscriberCookie))
				}
			} catch (error) {
				subscriberLookupError =
					error instanceof Error ? error.message : String(error)
				await log.error('survey.answer.subscriber.failed', {
					surveyId: input.surveyId,
					questionId: input.question,
					userId: session?.user?.id,
					error: subscriberLookupError,
				})
			}

			let userId = session?.user?.id || null
			const emailListSubscriberId = subscriber?.id?.toString() || null
			const identityEmail =
				subscriber?.email_address || session?.user?.email || null

			if (!userId && identityEmail) {
				const existingUser = await db.query.users.findFirst({
					where: (users, { eq }) => eq(users.email, identityEmail),
				})
				if (existingUser) {
					userId = existingUser.id
				}
			}

			await log.info('survey.answer.identity', {
				hasSession: !!session,
				userId,
				emailListSubscriberId,
				surveySlug: input.surveyId,
				hasSubscriber: !!subscriber,
			})

			if (
				input.surveyId === CHECKOUT_SURVEY_SLUG &&
				input.question === CHECKOUT_SURVEY_QUESTION_SLUG
			) {
				await ensureCheckoutSurveyResources(userId || 'system')
			}

			if (input.surveyId && input.question && input.answer?.trim()) {
				try {
					const survey = await db.query.contentResource.findFirst({
						where: and(
							eq(contentResource.type, 'survey'),
							sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') = ${input.surveyId}`,
						),
					})

					const surveyId = survey?.id || input.surveyId
					const question = await db.query.contentResource.findFirst({
						where: and(
							eq(contentResource.type, 'question'),
							sql`JSON_EXTRACT(${contentResource.fields}, '$.slug') = ${input.question}`,
						),
					})

					const questionId = question?.id || input.question

					await log.info('survey.answer.lookup', {
						surveySlug: input.surveyId,
						questionSlug: input.question,
						resolvedSurveyId: surveyId,
						resolvedQuestionId: questionId,
						usedSurveySlugFallback: !survey?.id,
						usedQuestionSlugFallback: !question?.id,
						userId,
						emailListSubscriberId,
					})

					await db.insert(questionResponse).values({
						id: guid(),
						surveyId,
						questionId,
						userId,
						emailListSubscriberId,
						fields: { answer: input.answer },
						createdAt: new Date(),
						updatedAt: new Date(),
					})

					await log.info('survey.answer.saved', {
						surveyId,
						surveySlug: input.surveyId,
						questionId,
						questionSlug: input.question,
						userId,
						emailListSubscriberId,
					})
				} catch (error) {
					await log.error('survey.answer.save.failed', {
						error: error instanceof Error ? error.message : String(error),
						surveySlug: input.surveyId,
						questionSlug: input.question,
						userId,
					})
				}
			}

			if (!subscriber) {
				await log.warn('survey.answer.no.subscriber', {
					surveyId: input.surveyId,
					questionId: input.question,
					userId: session?.user?.id,
					subscriberLookupError,
				})
				return { success: true, storedInDb: true, subscriberLookupError }
			}

			const updatedSubscriber = await answerSurvey({
				subscriber,
				question: input.question,
				answer: input.answer,
			})

			return updatedSubscriber
		}),
})
