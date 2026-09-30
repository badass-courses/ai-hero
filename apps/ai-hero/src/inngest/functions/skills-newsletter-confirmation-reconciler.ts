import { inngest } from '@/inngest/inngest.server'
import {
	reconcileSkillsConfirmations,
	type SkillsConfirmationSteps,
	type SkillsConfirmationTier,
} from '@/lib/subscriber-marketing/signup-confirmation-reconciler.server'

/**
 * The recent tier: every 15 minutes, off the quarter hours (the
 * contact-sync reconcile) and :40 (the owner-birth guard). Kit has no
 * confirmation webhook here, so this poll is the whole wait between a
 * learner confirming and their entry.
 */
export const SKILLS_CONFIRMATION_POLL_CRON = '2,17,32,47 * * * *'
/**
 * The daily tier: every signup since the floor, once a day at 05:09Z, off
 * the quarter hours, the fives and :40. A run still going queues it.
 */
export const SKILLS_CONFIRMATION_DAILY_CRON = '9 5 * * *'

export function skillsConfirmationTierOf(event: {
	data?: { cron?: unknown }
}): SkillsConfirmationTier {
	return event.data?.cron === SKILLS_CONFIRMATION_DAILY_CRON
		? 'daily'
		: 'recent'
}

export const skillsNewsletterConfirmationReconciler = inngest.createFunction(
	{
		id: 'skills-newsletter-confirmation-reconciler',
		name: 'Skills Newsletter Confirmation Reconciler',
		retries: 2,
		// One run at a time: a run that outlasts its quarter queues the next
		// instead of overlapping it. A replay is safe anyway: each event's id is
		// skills-confirmed:<form>:<subscriber>, which Inngest dedupes.
		concurrency: 1,
	},
	[
		{ cron: SKILLS_CONFIRMATION_POLL_CRON },
		{ cron: SKILLS_CONFIRMATION_DAILY_CRON },
	],
	async ({ event, step, logger }) => {
		const steps: SkillsConfirmationSteps = {
			run: (id, work) => step.run(id, work) as never,
			send: (id, confirmed) => step.sendEvent(id, confirmed),
		}
		// Each confirmed subscriber is sent in its own step as soon as its
		// tags clear, and logged then (Inngest's logger skips memoized steps).
		const receipt = await reconcileSkillsConfirmations({
			tier: skillsConfirmationTierOf(event),
			steps,
			onSent: (confirmed) =>
				logger.info('subscriber_funnel.confirmation_reconciled', {
					funnel: 'skills-newsletter',
					formId: confirmed.data.formId,
					kitSubscriberId: confirmed.data.kitSubscriberId,
					source: confirmed.data.source,
					eventId: confirmed.id,
				}),
			// Skipped, unsent, and checked again next poll.
			onTagCheckFailed: (failure) =>
				logger.warn('subscriber_funnel.confirmation_tag_check_failed', {
					funnel: 'skills-newsletter',
					...failure,
				}),
		})
		await step.run('log-confirmation-run-receipt', async () => {
			logger.info('subscriber_funnel.confirmation_reconciliation_completed', {
				funnel: 'skills-newsletter',
				...receipt,
			})
			// The daily tier reads to the floor; anyone it leaves is waiting a
			// day at least. Only 404s and failing tag checks can use the check
			// cap now, so this should stay 0 (a monitor on it is a follow-up).
			if (receipt.tier === 'daily' && receipt.counts.deferred > 0)
				logger.warn('subscriber_funnel.confirmation_daily_deferred', {
					funnel: 'skills-newsletter',
					deferred: receipt.counts.deferred,
					tagChecked: receipt.counts.tagChecked,
					notInKit: receipt.counts.notInKit,
					tagFailed: receipt.counts.tagFailed,
					planned: receipt.counts.planned,
				})
		})
		return receipt
	},
)
