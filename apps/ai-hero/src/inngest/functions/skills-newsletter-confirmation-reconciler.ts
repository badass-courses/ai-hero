import { inngest } from '@/inngest/inngest.server'
import { buildSignupConfirmationReconciliationBatch } from '@/lib/subscriber-marketing/signup-confirmation-reconciler.server'

export const skillsNewsletterConfirmationReconciler = inngest.createFunction(
	{
		id: 'skills-newsletter-confirmation-reconciler',
		name: 'Skills Newsletter Confirmation Reconciler',
		retries: 2,
		concurrency: 1,
	},
	{ cron: '17 * * * *' },
	async ({ step, logger }) => {
		const plan = await step.run('scan-confirmed-signup-gap', () =>
			buildSignupConfirmationReconciliationBatch(),
		)

		if (plan.events.length > 0) {
			await step.sendEvent('enqueue-confirmed-subscribers', plan.events)
			await step.run('log-confirmed-entry-receipts', async () => {
				for (const event of plan.events) {
					logger.info('subscriber_funnel.confirmation_reconciled', {
						funnel: 'skills-newsletter',
						formId: event.data.formId,
						kitSubscriberId: event.data.kitSubscriberId,
						source: event.data.source,
						eventId: event.id,
					})
				}
				return { logged: plan.events.length }
			})
		}

		const receipt = {
			mode: 'signup-confirmation-reconciliation' as const,
			generatedAt: plan.generatedAt,
			formId: plan.formId,
			window: plan.window,
			counts: plan.counts,
		}
		await step.run('log-confirmation-run-receipt', async () => {
			logger.info('subscriber_funnel.confirmation_reconciliation_completed', {
				funnel: 'skills-newsletter',
				...receipt,
			})
		})
		return receipt
	},
)
