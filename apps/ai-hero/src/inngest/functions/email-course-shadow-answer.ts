import { db } from '@/db'
import { contactEvent } from '@/db/schema'
import { VALUE_PATH_ANSWER_SELECTED_EVENT } from '@/inngest/events/value-path'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	createEmailCourseShadowRuntime,
	type EmailCourseShadowObservationResult,
} from '@/lib/subscriber-marketing/email-course-shadow-runtime'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const NonBlankString = z.string().min(1)

type EmailCourseShadowAnswerReceipt = {
	contactEventId: string
	status: EmailCourseShadowObservationResult['status']
	reason?: string
}

export const emailCourseShadowAnswer = inngest.createFunction(
	{
		id: 'email-course-shadow-answer-v1',
		name: 'Email Course shadow: observe answer progression',
		retries: 2,
		concurrency: 1,
	},
	{ event: VALUE_PATH_ANSWER_SELECTED_EVENT },
	async ({ event, step }) => {
		const context = await step.run('load-shadow-answer-context', async () => {
			const repository = new DrizzleCaptureMarketingRepository(db)
			const [sourceIntent, answerPages, selectedEvent] = await Promise.all([
				repository.findSideEffectIntentByIdempotencyKey(
					`contact:${event.data.contactId}:value-path:${event.data.valuePathSlug}:email:${event.data.sentEmailResourceId}`,
				),
				getValuePathAnswerPages(),
				db.query.contactEvent.findFirst({
					where: eq(contactEvent.id, event.data.contactEventId),
				}),
			])
			const answerPage = answerPages.find(
				(candidate) => candidate.id === event.data.answerPageId,
			)
			const courseEntryEventId = NonBlankString.safeParse(
				sourceIntent?.metadata.courseEntryEventId,
			)
			return {
				courseEntryEventId: courseEntryEventId.success
					? courseEntryEventId.data
					: undefined,
				selectedNextEmailResourceId: answerPage?.fields.nextEmailResourceId,
				selectedAt: selectedEvent?.occurredAt?.toISOString(),
			}
		})

		const courseEntryEventId = context.courseEntryEventId
		const selectedAt = context.selectedAt
		if (!courseEntryEventId || !selectedAt) {
			const result = {
				status: 'skipped' as const,
				reason: 'legacy-answer-shadow-context-missing',
			}
			await log.warn('email_course.shadow_answer_skipped', {
				contactEventId: event.data.contactEventId,
				reason: result.reason,
			})
			return result
		}

		const result = await step.run('advance-email-course-shadow-answer', () =>
			createEmailCourseShadowRuntime({ database: db }).observeAnswer({
				courseEntryEventId,
				contactEventId: event.data.contactEventId,
				sentEmailResourceId: event.data.sentEmailResourceId,
				selectedNextEmailResourceId: context.selectedNextEmailResourceId,
				selectedAt,
			}),
		)
		const receipt: EmailCourseShadowAnswerReceipt = {
			contactEventId: event.data.contactEventId,
			status: result.status,
		}
		if ('reason' in result) receipt.reason = result.reason
		await log.info('email_course.shadow_answer_observed', receipt)
		return result
	},
)
