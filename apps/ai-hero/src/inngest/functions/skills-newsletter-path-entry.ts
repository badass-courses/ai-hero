import { db } from '@/db'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { SKILLS_NEWSLETTER_SUBSCRIBED_EVENT } from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	enterSkillsNewsletterSubscriber,
	SHADOW_NEWSLETTER_KIT_SEQUENCE,
} from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import { readActiveGateDRuntimeAllowlist } from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { log } from '@/server/logger'
import { redis } from '@/server/redis-client'

export const skillsNewsletterPathEntry = inngest.createFunction(
	{
		// v2: the original function id registered correctly on 2026-07-15 but
		// Inngest never routed a single skills-newsletter/subscribed event to it
		// (zero runs while sibling functions from the same syncs ran). Re-keying
		// forces a fresh function record and trigger binding.
		id: 'skills-newsletter-path-entry-v2',
		retries: 3,
	},
	{ event: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT },
	async ({ event, step }) => {
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

		// Separate step on purpose: course entry above is already durable, and a Kit
		// outage here retries on its own without replanning email zero.
		await step.run('subscribe-to-shadow-newsletter', async () => {
			await emailListProvider.subscribeToList({
				listId: SHADOW_NEWSLETTER_KIT_SEQUENCE,
				listType: 'sequence',
				user: {
					email: event.data.email,
					name: event.data.name,
				} as Parameters<
					typeof emailListProvider.subscribeToList
				>[0]['user'],
				fields: {},
			})
			await log.info('subscriber_funnel.shadow_newsletter_subscribed', {
				funnel: 'skills-newsletter',
				eventId: event.id,
				kitSequenceId: SHADOW_NEWSLETTER_KIT_SEQUENCE,
				contactId: entryResult.contactId,
			})
			return { status: 'subscribed' as const }
		})

		return entryResult
	},
)
