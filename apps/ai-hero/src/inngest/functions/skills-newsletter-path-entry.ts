import { db } from '@/db'
import { SKILLS_NEWSLETTER_SUBSCRIBED_EVENT } from '@/inngest/events/skills-newsletter'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { enterSkillsNewsletterSubscriber } from '@/lib/subscriber-marketing/skills-newsletter-path-entry'
import { readActiveGateDRuntimeAllowlist } from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { redis } from '@/server/redis-client'

export const skillsNewsletterPathEntry = inngest.createFunction(
	{
		id: 'skills-newsletter-path-entry',
		retries: 3,
	},
	{ event: SKILLS_NEWSLETTER_SUBSCRIBED_EVENT },
	async ({ event, step }) => {
		return step.run('authorize-capture-and-plan-email-zero', async () => {
			// Read authorization in the same retryable step as the write so a kill
			// switch or mode change cannot leave a stale authorization snapshot.
			const allowlistDecision = await readActiveGateDRuntimeAllowlist({ redis })
			if (!allowlistDecision.passed || !allowlistDecision.allowlist) {
				return {
					status: 'blocked',
					reviewReasons: allowlistDecision.reviewReasons,
				}
			}
			return enterSkillsNewsletterSubscriber({
				repository: new DrizzleCaptureMarketingRepository(db),
				allowlist: allowlistDecision.allowlist,
				input: event.data,
				allowWrite: true,
			})
		})
	},
)
