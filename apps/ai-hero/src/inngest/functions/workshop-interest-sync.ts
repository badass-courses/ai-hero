import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { env } from '@/env.mjs'
import {
	WORKSHOP_INTEREST_REQUESTED_EVENT,
	type WorkshopInterestRequested,
} from '@/inngest/events/workshop-interest'
import { inngest } from '@/inngest/inngest.server'
import { conversionIntentContract } from '@/lib/cta/conversion-intent'
import { log } from '@/server/logger'

function contractFor(data: WorkshopInterestRequested['data']) {
	return conversionIntentContract({
		intent: { kind: 'workshop-interest', workshopSlug: data.workshopSlug },
		surface: data.surface,
		now: new Date(data.expressedAt),
	})
}

export const workshopInterestSync = inngest.createFunction(
	{
		id: 'workshop-interest-sync',
		name: 'Sync workshop interest to Kit',
		retries: 5,
		idempotency: 'event.data.email + ":" + event.data.workshopSlug',
		throttle: { limit: 4, period: '1s' },
		onFailure: async ({ event, error }) => {
			const original = event.data.event as WorkshopInterestRequested
			const contract = contractFor(original.data)
			await log.error('workshop.interest.failed', {
				workshopSlug: original.data.workshopSlug,
				subscriberId: original.data.subscriberId,
				via: original.data.via,
				fieldKey: Object.keys(contract.fields).find(
					(key) => key !== 'source',
				),
				phase: 'terminal-sync',
				error: error.message,
			})
		},
	},
	{ event: WORKSHOP_INTEREST_REQUESTED_EVENT },
	async ({ event, step }) => {
		const contract = contractFor(event.data)
		const user = {
			email: event.data.email,
			name: event.data.name,
		} as Parameters<typeof emailListProvider.subscribeToList>[0]['user']

		await step.run('write-workshop-interest-field', () =>
			emailListProvider.subscribeToList({
				listId: env.CONVERTKIT_SIGNUP_FORM,
				listType: 'form',
				user,
				fields: contract.fields,
			}),
		)

		await step.run('apply-workshop-interest-tag', async () => {
			if (!contract.tagName || !emailListProvider.tagSubscriber) {
				throw new Error('Kit workshop-interest tag projection is unavailable')
			}
			await emailListProvider.tagSubscriber({
				tag: contract.tagName,
				email: event.data.email,
			})
		})

		await step.run('log-workshop-interest-success', () =>
			log.info('workshop.interest.success', {
				workshopSlug: event.data.workshopSlug,
				subscriberId: event.data.subscriberId,
				via: event.data.via,
				fieldKey: Object.keys(contract.fields).find(
					(key) => key !== 'source',
				),
				phase: 'terminal-sync',
			}),
		)

		return { success: true as const, intentKey: contract.key }
	},
)
