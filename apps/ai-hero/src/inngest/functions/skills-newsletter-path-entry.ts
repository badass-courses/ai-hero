import { db } from '@/db'
import {
	emailListProvider,
	KitSubscribeError,
	subscribeToKitListWithoutFields,
} from '@/coursebuilder/email-list-provider'
import { kitWriteRetrySchedule } from '@/coursebuilder/kit-write-retry'
import { SKILLS_NEWSLETTER_SUBSCRIBED_EVENT } from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { parseCourseSequenceExhaustionEnabled } from '@/lib/subscriber-marketing/course-sequence-exhaustion'
import {
	enterSkillsNewsletterSubscriber,
	SHADOW_NEWSLETTER_BACKFILL_KIT_TAG,
	SHADOW_NEWSLETTER_KIT_SEQUENCE,
} from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import { readActiveGateDRuntimeAllowlist } from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'
import { NonRetriableError, RetryAfterError } from 'inngest'

export const SKILLS_NEWSLETTER_PATH_RETRIES = 3
export const PAUSED_SEQUENCE_MAX_PROVIDER_CALLS =
	2 * (SKILLS_NEWSLETTER_PATH_RETRIES + 1)

async function throwForDurableKitRetry({
	error,
	attempt,
	maxAttempts,
	operation,
	listType,
}: {
	error: unknown
	attempt: number
	maxAttempts: number
	operation: 'shadow-sequence-probe' | 'shadow-backfill-tag'
	listType: 'sequence' | 'tag'
}): Promise<never> {
	const schedule = kitWriteRetrySchedule(error, { attempt: attempt + 1 })
	if (schedule) {
		if (attempt + 1 >= maxAttempts) {
			await log.warn('kit.write.outcome', {
				operation,
				outcome: 'exhausted',
				context: 'skills-newsletter-path-entry',
				listType,
				attempts: attempt + 1,
				providerCalls: 1,
				maxProviderCallsForOperation: maxAttempts,
				maxProviderCallsForPausedEvent: PAUSED_SEQUENCE_MAX_PROVIDER_CALLS,
				status: schedule.status,
			})
			throw error
		}

		await log.warn('kit.write.retry', {
			operation,
			context: 'skills-newsletter-path-entry',
			listType,
			attempt: attempt + 1,
			providerCalls: 1,
			maxProviderCallsForOperation: maxAttempts,
			maxProviderCallsForPausedEvent: PAUSED_SEQUENCE_MAX_PROVIDER_CALLS,
			...schedule,
		})
		throw new RetryAfterError('Kit provider retry scheduled', schedule.delayMs)
	}

	if (error instanceof ConvertKitApiError || error instanceof KitSubscribeError) {
		await log.warn('kit.write.outcome', {
			operation,
			outcome: 'failed',
			context: 'skills-newsletter-path-entry',
			listType,
			attempts: attempt + 1,
			providerCalls: 1,
			status: error.status,
		})
		throw new NonRetriableError('Kit rejected background write')
	}

	throw error
}

export const skillsNewsletterPathEntry = inngest.createFunction(
	{
		// v2: the original function id registered correctly on 2026-07-15 but
		// Inngest never routed a single skills-newsletter/subscribed event to it
		// (zero runs while sibling functions from the same syncs ran). Re-keying
		// forces a fresh function record and trigger binding.
		id: 'skills-newsletter-path-entry-v2',
		retries: SKILLS_NEWSLETTER_PATH_RETRIES,
		concurrency: 1,
		// The healthy paused path performs one expected 400 plus one tag write.
		// One run per two seconds caps that path at 60 Kit calls per minute.
		// Each durable step has its own four-attempt budget: eight calls worst case.
		throttle: { limit: 1, period: '2s' },
	},
	{ event: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT },
	async ({ event, step, attempt, maxAttempts }) => {
		await log.info('subscriber_funnel.event_received', {
			funnel: 'skills-newsletter',
			eventId: event.id,
			formId: event.data.formId,
			hasAttribution: Boolean(event.data.optInAttribution),
			hasClickId: Boolean(event.data.optInAttribution?.gclid || event.data.optInAttribution?.gbraid || event.data.optInAttribution?.wbraid),
		})
		const entryResult = await step.run('authorize-capture-and-plan-email-zero', async () => {
			// Read authorization in the same retryable step as the write so a kill
			// switch or mode change cannot leave a stale authorization snapshot.
			const allowlistDecision = await readActiveGateDRuntimeAllowlist({ redis })
			if (!allowlistDecision.passed || !allowlistDecision.allowlist) {
				await log.warn('subscriber_funnel.authorization_blocked', {
					funnel: 'skills-newsletter', eventId: event.id,
					reviewReasons: allowlistDecision.reviewReasons,
				})
				return {
					status: 'blocked',
					reviewReasons: allowlistDecision.reviewReasons,
				}
			}
			await log.info('subscriber_funnel.authorization_allowed', {
				funnel: 'skills-newsletter', eventId: event.id,
				authorizationMode: allowlistDecision.allowlist.authorizationMode,
			})
			const result = await enterSkillsNewsletterSubscriber({
				repository: new DrizzleCaptureMarketingRepository(db),
				allowlist: allowlistDecision.allowlist,
				input: event.data,
				allowWrite: true,
				sequenceExhaustionEnabled: parseCourseSequenceExhaustionEnabled(
					process.env.AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED,
				),
			})
			await log.info('subscriber_funnel.entry_result', {
				funnel: 'skills-newsletter', eventId: event.id,
				contactId: result.contactId, captureEventId: result.captureEventId,
				status: result.status, emailZeroPlanned: result.entry.counts.planned,
				blocked: result.entry.counts.blocked,
				reviewReasons: result.entry.results.flatMap((item) => item.reviewReasons),
			})
			await log.info('subscriber_funnel.signup_entry_completed', {
				funnel: 'skills-newsletter',
				signupsCaptured: 1,
				contactsPersisted: 1,
				emailZeroPlanned: result.entry.counts.planned,
				blocked: result.entry.counts.blocked,
				idempotentNoop: result.entry.counts.idempotentNoop,
			})
			if (
				event.data.source === 'signup-gap-replay' ||
				event.data.source === 'learner-flow-unstick'
			) {
				await log.info('subscriber_funnel.signup_gap_replay_received', {
					funnel: 'skills-newsletter',
					replayEventsReceived: 1,
					emailZeroPlanned: result.entry.counts.planned,
					blocked: result.entry.counts.blocked,
					idempotentNoop: result.entry.counts.idempotentNoop,
					...(event.data.signupGapLiveness ?? {}),
				})
			}
			return result
		})

		// A blocked entry never became a course subscriber, so it must not be added
		// to the newsletter either. Gate D is the only authorization gate here.
		// The authorization-blocked branch above returns a narrower shape with no
		// contactId, so test for that rather than the status string.
		if (!entryResult || !('contactId' in entryResult)) {
			return entryResult
		}
		if (entryResult.status === 'blocked') {
			return entryResult
		}

		const user = {
			email: event.data.email,
			name: event.data.name,
		} as Parameters<typeof emailListProvider.subscribeToList>[0]['user']
		const configuredMaxAttempts =
			maxAttempts ?? SKILLS_NEWSLETTER_PATH_RETRIES + 1

		await step.run('log-shadow-sequence-logical-operation', () =>
			log.info('kit.write.logical_operation', {
				operation: 'shadow-sequence-probe',
				logicalOperations: 1,
				context: 'skills-newsletter-path-entry',
				listType: 'sequence',
				providerCallInvariant: 'one-call-per-step-attempt',
				maxProviderCallsForPausedEvent: PAUSED_SEQUENCE_MAX_PROVIDER_CALLS,
			}),
		)

		// The sequence probe and fallback tag are separate durable steps. When the
		// tag retries, Inngest reuses the completed 400 probe instead of repeating it.
		const sequenceResult = await step.run(
			'probe-shadow-newsletter-sequence',
			async () => {
				try {
					await subscribeToKitListWithoutFields({
						listId: SHADOW_NEWSLETTER_KIT_SEQUENCE,
						listType: 'sequence',
						user,
					})
					await log.info('kit.write.outcome', {
						operation: 'shadow-sequence-probe',
						outcome: attempt > 0 ? 'recovered' : 'succeeded',
						context: 'skills-newsletter-path-entry',
						listType: 'sequence',
						attempts: attempt + 1,
						providerCalls: 1,
					})
					return { status: 'subscribed' as const }
				} catch (error) {
					if (error instanceof ConvertKitApiError && error.status === 400) {
						await log.info('kit.write.outcome', {
							operation: 'shadow-sequence-probe',
							outcome: 'deferred',
							context: 'skills-newsletter-path-entry',
							listType: 'sequence',
							attempts: attempt + 1,
							providerCalls: 1,
							status: 400,
						})
						return { status: 'deferred' as const }
					}
					return throwForDurableKitRetry({
						error,
						attempt,
						maxAttempts: configuredMaxAttempts,
						operation: 'shadow-sequence-probe',
						listType: 'sequence',
					})
				}
			},
		)

		if (sequenceResult.status === 'deferred') {
			await step.run('log-shadow-backfill-logical-operation', () =>
				log.info('kit.write.logical_operation', {
					operation: 'shadow-backfill-tag',
					logicalOperations: 1,
					context: 'skills-newsletter-path-entry',
					listType: 'tag',
					providerCallInvariant: 'one-call-per-step-attempt',
					maxProviderCallsForPausedEvent: PAUSED_SEQUENCE_MAX_PROVIDER_CALLS,
				}),
			)
			await step.run('tag-shadow-newsletter-backfill', async () => {
				try {
					await subscribeToKitListWithoutFields({
						listId: SHADOW_NEWSLETTER_BACKFILL_KIT_TAG,
						listType: 'tag',
						user,
					})
					await log.info('kit.write.outcome', {
						operation: 'shadow-backfill-tag',
						outcome: attempt > 0 ? 'recovered' : 'succeeded',
						context: 'skills-newsletter-path-entry',
						listType: 'tag',
						attempts: attempt + 1,
						providerCalls: 1,
					})
					return { status: 'tagged' as const }
				} catch (error) {
					return throwForDurableKitRetry({
						error,
						attempt,
						maxAttempts: configuredMaxAttempts,
						operation: 'shadow-backfill-tag',
						listType: 'tag',
					})
				}
			})
			await step.run('log-shadow-newsletter-deferred', () =>
				log.info('subscriber_funnel.shadow_newsletter_deferred', {
					funnel: 'skills-newsletter',
					eventId: event.id,
					contactId: entryResult.contactId,
					kitSequenceId: SHADOW_NEWSLETTER_KIT_SEQUENCE,
					kitBackfillTagId: SHADOW_NEWSLETTER_BACKFILL_KIT_TAG,
				}),
			)
		} else {
			await step.run('log-shadow-newsletter-subscribed', () =>
				log.info('subscriber_funnel.shadow_newsletter_subscribed', {
					funnel: 'skills-newsletter',
					eventId: event.id,
					kitSequenceId: SHADOW_NEWSLETTER_KIT_SEQUENCE,
					contactId: entryResult.contactId,
				}),
			)
		}

		return entryResult
	},
)
