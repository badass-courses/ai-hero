import { db } from '@/db'
import { SKILLS_NEWSLETTER_SUBSCRIBED_EVENT } from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { enterSkillsNewsletterSubscriber } from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
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
		return step.run('authorize-capture-and-plan-email-zero', async () => {
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
			return result
		})
	},
)
