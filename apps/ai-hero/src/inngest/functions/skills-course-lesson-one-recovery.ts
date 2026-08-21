import { env } from '@/env.mjs'
import { SKILLS_COURSE_LESSON_ONE_RECOVERY_REQUESTED_EVENT } from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	readSkillsCourseRecoveryDelivery,
	sendSkillsCourseRecoveryDelivery,
} from '@/lib/subscriber-marketing/skills-course-recovery-delivery'
import { getValuePathAnswerPages } from '@/lib/subscriber-marketing/value-path-answer-page'
import {
	isValuePathIntentCompleted,
	valuePathIntentCompletedAt,
} from '@/lib/subscriber-marketing/value-path-completion'
import { buildValuePathEmailPersonalization } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	SKILLS_WORKFLOW_EMAIL_ZERO,
	SKILLS_WORKFLOW_VALUE_PATH,
} from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import type { SideEffectIntent } from '@/lib/subscriber-marketing/types'
import { log } from '@/server/logger'
import { RetryAfterError } from 'inngest'

import { db } from '@/db'

export const SKILLS_COURSE_RECOVERY_RETRIES = 12
export const SKILLS_COURSE_RECOVERY_IDENTITY_RETRY_MS = 5 * 60 * 1000
export const SKILLS_COURSE_RECOVERY_DELIVERY_RETRY_MS = 5 * 60 * 1000

type AnswerLink = {
	optionValue?: string
	href: string
}

/**
 * Resolves the Kit identity created by canonical path entry before sending.
 * The event carries no email, and the function never enrolls a Kit sequence.
 */
export const skillsCourseLessonOneRecovery = inngest.createFunction(
	{
		id: 'skills-course-lesson-one-recovery',
		name: 'Skills Course - Recover Lesson One',
		retries: SKILLS_COURSE_RECOVERY_RETRIES,
		concurrency: 1,
		idempotency: 'event.data.recoveryKey',
		onFailure: async ({ event }) => {
			await log.error('skills.course.lesson_one_recovery_failed', {
				requestId: recoveryRequestId(event.data.event),
				outcome: 'retries-exhausted',
			})
		},
	},
	{ event: SKILLS_COURSE_LESSON_ONE_RECOVERY_REQUESTED_EVENT },
	async ({ event, step }) => {
		const identity = await step.run(
			'wait-for-trusted-recovery-identity-and-canonical-send',
			async () => {
				const repository = new DrizzleCaptureMarketingRepository(db)
				const providerIdentity = await repository.findProviderIdentity(
					'kit',
					event.data.kitSubscriberId,
				)
				const contact = providerIdentity
					? await repository.findContactById(providerIdentity.contactId)
					: undefined
				if (!providerIdentity || !contact?.email) {
					return retryIdentity(event.data.requestId, 'identity-not-ready')
				}

				const intents =
					await repository.findValuePathEmailSideEffectIntentsByContact(
						contact.id,
					)
				const canonicalIntent = findCanonicalEmailZeroIntent(intents)
				if (!canonicalIntent) {
					return retryIdentity(event.data.requestId, 'canonical-send-not-ready')
				}
				if (
					canonicalIntent.status === 'pending' ||
					(canonicalIntent.status === 'failed' &&
						canonicalIntent.metadata.retryable === true)
				) {
					return retryIdentity(event.data.requestId, 'canonical-send-pending')
				}

				if (canonicalIntent.status === 'completed') {
					const completedAt = valuePathIntentCompletedAt(canonicalIntent)
					if (!isValuePathIntentCompleted(canonicalIntent) || !completedAt) {
						return retryIdentity(
							event.data.requestId,
							'canonical-completion-unproven',
						)
					}
					return {
						contactId: contact.id,
						sendRequired: completedAt < event.data.requestedAt,
					}
				}

				return { contactId: contact.id, sendRequired: true }
			},
		)

		if (!identity.sendRequired) {
			await step.run('log-canonical-send-satisfied-recovery', () =>
				log.info('skills.course.lesson_one_recovery_satisfied', {
					requestId: event.data.requestId,
					outcome: 'canonical-send-completed',
				}),
			)
			return {
				success: true as const,
				requestId: event.data.requestId,
				outcome: 'canonical-send-completed' as const,
			}
		}

		await step.run('send-lesson-one-recovery', async () => {
			const repository = new DrizzleCaptureMarketingRepository(db)
			const contact = await repository.findContactById(identity.contactId)
			if (!contact?.email) {
				throw new RetryAfterError(
					'Recovery identity is not ready',
					SKILLS_COURSE_RECOVERY_IDENTITY_RETRY_MS,
				)
			}

			const pathTokenSecret =
				process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET ??
				(process.env.NODE_ENV === 'production'
					? undefined
					: 'dev-value-path-token-secret')
			const personalization = buildValuePathEmailPersonalization({
				contactId: contact.id,
				kitSubscriberId: event.data.kitSubscriberId,
				valuePathSlug: SKILLS_WORKFLOW_VALUE_PATH,
				emailResourceId: SKILLS_WORKFLOW_EMAIL_ZERO,
				answerPages: await getValuePathAnswerPages(),
				baseUrl: process.env.NEXT_PUBLIC_URL ?? 'https://www.aihero.dev',
				pathTokenSecret,
			})
			if (!personalization.passed) {
				throw new Error('Course recovery personalization is unavailable')
			}

			const answerLinksJson =
				'aih_value_path_answer_links_json' in personalization.fields &&
				typeof personalization.fields.aih_value_path_answer_links_json ===
					'string'
					? personalization.fields.aih_value_path_answer_links_json
					: undefined
			const links = parseAnswerLinks(answerLinksJson)
			const postmarkToken = process.env.POSTMARK_API_KEY ?? ''
			let readback
			try {
				readback = await readSkillsCourseRecoveryDelivery({
					correlationId: event.data.requestId,
					postmarkToken,
				})
			} catch {
				// Never replay while provider acceptance is unknown. A retry must first
				// prove that this correlation id is absent from Postmark.
				throw deliveryRetry()
			}
			if (readback.found) {
				return {
					delivered: true as const,
					providerCorrelationId: event.data.requestId,
					messageId: readback.messageId,
					via: 'readback' as const,
				}
			}

			try {
				const delivery = await sendSkillsCourseRecoveryDelivery({
					correlationId: event.data.requestId,
					to: contact.email,
					subject: 'Your first AI Skills lesson — sent again',
					body: lessonOneBody({
						personalUrl: answerUrl(links, 'personal'),
						teamUrl: answerUrl(links, 'team'),
						unsureUrl: answerUrl(links, 'unsure'),
					}),
					preview: 'Choose the AI workflow path that fits your work.',
					replyTo: env.NEXT_PUBLIC_SUPPORT_EMAIL,
					from: `${env.NEXT_PUBLIC_SITE_TITLE} <${env.NEXT_PUBLIC_SUPPORT_EMAIL}>`,
					postmarkToken,
				})
				return {
					delivered: true as const,
					providerCorrelationId: event.data.requestId,
					messageId: delivery.messageId,
					via: 'send' as const,
				}
			} catch {
				// The POST may have been accepted before the response was lost. Delay,
				// then force Postmark metadata readback before another send attempt.
				throw deliveryRetry()
			}
		})

		await step.run('log-lesson-one-recovery', () =>
			log.info('skills.course.lesson_one_resent', {
				requestId: event.data.requestId,
				outcome: 'sent',
			}),
		)
		return { success: true as const, requestId: event.data.requestId }
	},
)

async function retryIdentity(
	requestId: string,
	reason:
		| 'identity-not-ready'
		| 'canonical-send-not-ready'
		| 'canonical-send-pending'
		| 'canonical-completion-unproven',
): Promise<never> {
	await log.warn('skills.course.lesson_one_recovery_retrying', {
		requestId,
		reason,
	})
	throw new RetryAfterError(
		'Recovery identity is not ready',
		SKILLS_COURSE_RECOVERY_IDENTITY_RETRY_MS,
	)
}

function findCanonicalEmailZeroIntent(intents: SideEffectIntent[]) {
	return intents.find(
		(intent) =>
			intent.metadata.valuePathSlug === SKILLS_WORKFLOW_VALUE_PATH &&
			intent.metadata.emailResourceId === SKILLS_WORKFLOW_EMAIL_ZERO,
	)
}

function recoveryRequestId(value: unknown) {
	if (!value || typeof value !== 'object' || !('data' in value)) {
		return 'unresolved-request'
	}
	const data = value.data
	if (!data || typeof data !== 'object' || !('requestId' in data)) {
		return 'unresolved-request'
	}
	return typeof data.requestId === 'string'
		? data.requestId
		: 'unresolved-request'
}

function deliveryRetry() {
	return new RetryAfterError(
		'Skills course recovery delivery needs provider readback',
		SKILLS_COURSE_RECOVERY_DELIVERY_RETRY_MS,
	)
}

function parseAnswerLinks(value?: string): AnswerLink[] {
	if (!value) throw new Error('Course recovery links are missing')
	const parsed: unknown = JSON.parse(value)
	if (!Array.isArray(parsed)) {
		throw new Error('Course recovery links are invalid')
	}
	return parsed.filter((link): link is AnswerLink =>
		Boolean(
			link &&
			typeof link === 'object' &&
			'href' in link &&
			typeof link.href === 'string' &&
			(!('optionValue' in link) || typeof link.optionValue === 'string'),
		),
	)
}

function answerUrl(links: AnswerLink[], optionValue: string) {
	const href = links.find((link) => link.optionValue === optionValue)?.href
	if (!href) throw new Error(`Course recovery link is missing: ${optionValue}`)
	return href
}

function lessonOneBody({
	personalUrl,
	teamUrl,
	unsureUrl,
}: {
	personalUrl: string
	teamUrl: string
	unsureUrl: string
}) {
	return `Agents work best when you are not just collecting prompts.

Prompts are disposable. Workflows are reusable.

That is what skills give you: a way to teach your agent how you want work done, then reuse that instruction again and again.

This email course gives you a repeatable workflow for working with agents, not a pile of one-off prompts.

Choose the path that best fits what you are trying to do. Your next email will start with the skill and practice step that matches your goal.

**Choose your path:**

[My Own AI Agent Workflows](${personalUrl})

[Team Agent Workflows](${teamUrl})

[Help me choose the right workflow.](${unsureUrl})

Pick one and I will send the next lesson in a few minutes.`
}
